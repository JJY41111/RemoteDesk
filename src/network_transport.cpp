#include <winsock2.h>
#include <ws2tcpip.h>

#include "network_transport.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <limits>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>

namespace remotedesk {
namespace {

constexpr std::uint32_t kMagic = 0x5244534B; // RDSK
constexpr std::uint32_t kVersion = 1;
constexpr std::size_t kHeaderFields = 10;
constexpr std::size_t kMaxPacketBytes = 2 * 1024 * 1024;
constexpr std::size_t kMaxQueuedPackets = 16;

std::runtime_error SocketError(const char* operation) {
    return std::runtime_error(std::string(operation) + " failed (WSA " +
                              std::to_string(WSAGetLastError()) + ")");
}

class WinsockSession {
public:
    WinsockSession() {
        WSADATA data{};
        const int result = WSAStartup(MAKEWORD(2, 2), &data);
        if (result != 0) {
            throw std::runtime_error("WSAStartup failed (WSA " +
                                     std::to_string(result) + ")");
        }
    }
    ~WinsockSession() { WSACleanup(); }
    WinsockSession(const WinsockSession&) = delete;
    WinsockSession& operator=(const WinsockSession&) = delete;
};

class SocketHandle {
public:
    explicit SocketHandle(SOCKET value = INVALID_SOCKET) : value_(value) {}
    ~SocketHandle() { Close(); }
    SocketHandle(const SocketHandle&) = delete;
    SocketHandle& operator=(const SocketHandle&) = delete;
    SocketHandle(SocketHandle&& other) noexcept
        : value_(std::exchange(other.value_, INVALID_SOCKET)) {}
    SocketHandle& operator=(SocketHandle&& other) noexcept {
        if (this != &other) {
            Close();
            value_ = std::exchange(other.value_, INVALID_SOCKET);
        }
        return *this;
    }
    SOCKET Get() const { return value_; }
    void Close() {
        if (value_ != INVALID_SOCKET) {
            closesocket(value_);
            value_ = INVALID_SOCKET;
        }
    }

private:
    SOCKET value_;
};

void SendAll(SOCKET socket, const char* data, std::size_t size) {
    while (size != 0) {
        const int chunk = static_cast<int>(
            std::min<std::size_t>(size, std::numeric_limits<int>::max()));
        const int sent = send(socket, data, chunk, 0);
        if (sent == SOCKET_ERROR || sent == 0) {
            throw SocketError("send");
        }
        data += sent;
        size -= static_cast<std::size_t>(sent);
    }
}

void WaitReadable(SOCKET socket, const std::atomic_bool* stopRequested) {
    for (;;) {
        if (stopRequested != nullptr && stopRequested->load()) {
            throw std::runtime_error("Receiver cancelled");
        }
        fd_set readable{};
        FD_ZERO(&readable);
        FD_SET(socket, &readable);
        timeval timeout{0, 200000};
        const int result = select(0, &readable, nullptr, nullptr, &timeout);
        if (result == SOCKET_ERROR) {
            throw SocketError("select");
        }
        if (result != 0) {
            return;
        }
    }
}

bool ReceiveAll(SOCKET socket, char* data, std::size_t size,
                const std::atomic_bool* stopRequested) {
    bool receivedAny = false;
    while (size != 0) {
        WaitReadable(socket, stopRequested);
        const int chunk = static_cast<int>(
            std::min<std::size_t>(size, std::numeric_limits<int>::max()));
        const int received = recv(socket, data, chunk, 0);
        if (received == 0) {
            if (receivedAny) {
                throw std::runtime_error("TCP stream ended inside a packet");
            }
            return false;
        }
        if (received == SOCKET_ERROR) {
            throw SocketError("recv");
        }
        receivedAny = true;
        data += received;
        size -= static_cast<std::size_t>(received);
    }
    return true;
}

void UpdateChecksum(PacketStatistics& statistics,
                    const std::vector<std::uint8_t>& bytes) {
    for (const auto byte : bytes) {
        statistics.checksum ^= byte;
        statistics.checksum *= 1099511628211ULL;
    }
}

sockaddr_in LoopbackAddress(unsigned short port) {
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    return address;
}

} // namespace

struct TcpPacketSender::Impl {
    struct QueuedPacket {
        std::vector<std::uint8_t> bytes;
        std::uint64_t sampleTime{};
        std::uint64_t sampleDuration{};
        std::uint32_t sequence{};
        unsigned width{};
        unsigned height{};
    };

    WinsockSession winsock;
    SocketHandle socket;
    std::mutex mutex;
    std::condition_variable ready;
    std::deque<QueuedPacket> queue;
    std::thread worker;
    PacketStatistics statistics;
    std::string error;
    std::uint32_t nextSequence{};
    bool stopping{};

    void Run() {
        try {
            for (;;) {
                QueuedPacket packet;
                {
                    std::unique_lock lock(mutex);
                    ready.wait(lock, [this] { return stopping || !queue.empty(); });
                    if (queue.empty()) {
                        break;
                    }
                    packet = std::move(queue.front());
                    queue.pop_front();
                }

                const auto high = [](std::uint64_t value) {
                    return static_cast<std::uint32_t>(value >> 32);
                };
                const auto low = [](std::uint64_t value) {
                    return static_cast<std::uint32_t>(value);
                };
                std::array<std::uint32_t, kHeaderFields> header{
                    htonl(kMagic),
                    htonl(kVersion),
                    htonl(packet.sequence),
                    htonl(packet.width),
                    htonl(packet.height),
                    htonl(static_cast<std::uint32_t>(packet.bytes.size())),
                    htonl(high(packet.sampleTime)),
                    htonl(low(packet.sampleTime)),
                    htonl(high(packet.sampleDuration)),
                    htonl(low(packet.sampleDuration)),
                };
                SendAll(socket.Get(), reinterpret_cast<const char*>(header.data()),
                        sizeof(header));
                SendAll(socket.Get(),
                        reinterpret_cast<const char*>(packet.bytes.data()),
                        packet.bytes.size());
                ++statistics.packets;
                statistics.bytes += packet.bytes.size();
                UpdateChecksum(statistics, packet.bytes);
            }
            if (shutdown(socket.Get(), SD_SEND) == SOCKET_ERROR) {
                throw SocketError("shutdown sender");
            }
        } catch (const std::exception& failure) {
            std::lock_guard lock(mutex);
            error = failure.what();
        }
    }
};

TcpPacketSender::TcpPacketSender() = default;

TcpPacketSender::~TcpPacketSender() {
    if (impl_) {
        try {
            Stop();
        } catch (...) {
        }
    }
}

void TcpPacketSender::StartLoopback(unsigned short port) {
    if (impl_ || port == 0) {
        throw std::invalid_argument("Invalid or repeated TCP sender start");
    }
    auto state = std::make_unique<Impl>();
    const sockaddr_in address = LoopbackAddress(port);
    for (int attempt = 0; attempt < 20; ++attempt) {
        state->socket = SocketHandle(socket(AF_INET, SOCK_STREAM, IPPROTO_TCP));
        if (state->socket.Get() == INVALID_SOCKET) {
            throw SocketError("create sender socket");
        }
        const DWORD timeoutMilliseconds = 2000;
        if (setsockopt(state->socket.Get(), SOL_SOCKET, SO_SNDTIMEO,
                       reinterpret_cast<const char*>(&timeoutMilliseconds),
                       sizeof(timeoutMilliseconds)) == SOCKET_ERROR) {
            throw SocketError("set sender timeout");
        }
        if (connect(state->socket.Get(),
                    reinterpret_cast<const sockaddr*>(&address),
                    sizeof(address)) != SOCKET_ERROR) {
            break;
        }
        const int error = WSAGetLastError();
        state->socket.Close();
        if (error != WSAECONNREFUSED || attempt == 19) {
            throw std::runtime_error(
                "connect to loopback receiver failed (WSA " +
                std::to_string(error) + ")");
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
    state->worker = std::thread([pointer = state.get()] { pointer->Run(); });
    impl_ = std::move(state);
}

void TcpPacketSender::QueuePacket(const std::vector<std::uint8_t>& bytes,
                                  std::uint64_t sampleTime,
                                  std::uint64_t sampleDuration,
                                  unsigned width, unsigned height) {
    if (!impl_ || bytes.empty() || bytes.size() > kMaxPacketBytes) {
        throw std::runtime_error("Invalid TCP H.264 packet");
    }
    {
        std::lock_guard lock(impl_->mutex);
        if (!impl_->error.empty()) {
            throw std::runtime_error(impl_->error);
        }
        if (impl_->stopping || impl_->queue.size() >= kMaxQueuedPackets) {
            throw std::runtime_error("TCP sender queue is full or stopped");
        }
        impl_->queue.push_back({bytes, sampleTime, sampleDuration,
                                impl_->nextSequence++, width, height});
    }
    impl_->ready.notify_one();
}

PacketStatistics TcpPacketSender::Stop() {
    if (!impl_) {
        return {};
    }
    {
        std::lock_guard lock(impl_->mutex);
        impl_->stopping = true;
    }
    impl_->ready.notify_one();
    impl_->worker.join();
    const PacketStatistics statistics = impl_->statistics;
    const std::string error = impl_->error;
    impl_.reset();
    if (!error.empty()) {
        throw std::runtime_error(error);
    }
    return statistics;
}

PacketStatistics ReceiveLoopbackPackets(
    unsigned short port,
    const std::function<void(const EncodedNetworkPacket&)>& onPacket,
    const std::atomic_bool* stopRequested) {
    if (port == 0) {
        throw std::invalid_argument("Invalid TCP receiver port");
    }
    WinsockSession winsock;
    SocketHandle listener(socket(AF_INET, SOCK_STREAM, IPPROTO_TCP));
    if (listener.Get() == INVALID_SOCKET) {
        throw SocketError("create receiver socket");
    }
    const sockaddr_in address = LoopbackAddress(port);
    if (bind(listener.Get(), reinterpret_cast<const sockaddr*>(&address),
             sizeof(address)) == SOCKET_ERROR) {
        throw SocketError("bind loopback receiver");
    }
    if (listen(listener.Get(), 1) == SOCKET_ERROR) {
        throw SocketError("listen");
    }
    WaitReadable(listener.Get(), stopRequested);
    SocketHandle connection(accept(listener.Get(), nullptr, nullptr));
    if (connection.Get() == INVALID_SOCKET) {
        throw SocketError("accept");
    }
    listener.Close();

    PacketStatistics statistics;
    std::uint32_t expectedSequence = 0;
    for (;;) {
        std::array<std::uint32_t, kHeaderFields> header{};
        if (!ReceiveAll(connection.Get(), reinterpret_cast<char*>(header.data()),
                        sizeof(header), stopRequested)) {
            break;
        }
        for (auto& value : header) {
            value = ntohl(value);
        }
        const std::uint32_t length = header[5];
        if (header[0] != kMagic || header[1] != kVersion ||
            header[2] != expectedSequence++ || header[3] != 1280 ||
            header[4] != 720 || length == 0 || length > kMaxPacketBytes) {
            throw std::runtime_error("Invalid TCP H.264 packet header");
        }
        EncodedNetworkPacket packet;
        packet.bytes.resize(length);
        packet.width = header[3];
        packet.height = header[4];
        packet.sampleTime = (static_cast<std::uint64_t>(header[6]) << 32) |
                            header[7];
        packet.sampleDuration = (static_cast<std::uint64_t>(header[8]) << 32) |
                                header[9];
        if (!ReceiveAll(connection.Get(),
                        reinterpret_cast<char*>(packet.bytes.data()),
                        packet.bytes.size(), stopRequested)) {
            throw std::runtime_error("TCP stream ended before packet payload");
        }
        ++statistics.packets;
        statistics.bytes += packet.bytes.size();
        UpdateChecksum(statistics, packet.bytes);
        if (onPacket) {
            onPacket(packet);
        }
    }
    if (statistics.packets == 0) {
        throw std::runtime_error("No H.264 packets were received");
    }
    return statistics;
}

} // namespace remotedesk
