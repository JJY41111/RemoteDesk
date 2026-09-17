#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

namespace remotedesk {

struct PacketStatistics {
    std::uint64_t packets{};
    std::uint64_t bytes{};
    std::uint64_t checksum{14695981039346656037ULL};
};

struct EncodedNetworkPacket {
    std::vector<std::uint8_t> bytes;
    std::uint64_t sampleTime{};
    std::uint64_t sampleDuration{};
    unsigned width{};
    unsigned height{};
    unsigned framesPerSecond{};
    std::uint64_t sourceEventQpc{};
    std::uint64_t captureReadyQpc{};
    std::uint64_t senderQueuedQpc{};
    std::uint64_t receivedQpc{};
};

class TcpPacketSender {
public:
    TcpPacketSender();
    TcpPacketSender(const TcpPacketSender&) = delete;
    TcpPacketSender& operator=(const TcpPacketSender&) = delete;
    ~TcpPacketSender();

    void StartLoopback(unsigned short port);
    void QueuePacket(const std::vector<std::uint8_t>& bytes,
                     std::uint64_t sampleTime,
                     std::uint64_t sampleDuration,
                     unsigned width, unsigned height,
                     std::uint64_t sourceEventQpc = 0,
                     std::uint64_t captureReadyQpc = 0,
                     unsigned framesPerSecond = 30);
    PacketStatistics Stop();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

PacketStatistics ReceiveLoopbackPackets(
    unsigned short port,
    const std::function<void(const EncodedNetworkPacket&)>& onPacket = {},
    const std::atomic_bool* stopRequested = nullptr);

} // namespace remotedesk
