#include <windows.h>
#include <objbase.h>

#include "h264_network_decoder.h"
#include "network_transport.h"

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <deque>
#include <fstream>
#include <iomanip>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <numeric>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr wchar_t kViewerClass[] = L"RemoteDeskReceiverWindow";
constexpr UINT kFrameReady = WM_APP + 1;
constexpr UINT kStreamDone = WM_APP + 2;
constexpr UINT_PTR kCancelTestTimer = 1;
constexpr std::size_t kMaxLatencySamples = 1800;

struct FrameSnapshot {
    std::vector<std::uint8_t> bgra;
    std::uint64_t serial{};
    std::uint64_t senderQueuedQpc{};
    std::uint64_t receivedQpc{};
    std::uint64_t decodedQpc{};
};

struct LatencySample {
    double networkMilliseconds{};
    double decodeMilliseconds{};
    double uiMilliseconds{};
    double totalMilliseconds{};
};

struct ViewerState {
    HWND window{};
    std::mutex mutex;
    std::shared_ptr<const FrameSnapshot> latestFrame;
    remotedesk::PacketStatistics packets;
    remotedesk::NetworkDecodeStatistics decoding;
    std::string error;
    std::atomic_bool stopRequested{};
    bool autoCloseOnDone{};
    bool successful{};
    std::uint64_t timingMatches{};
    std::uint64_t paintedFrames{};
    std::uint64_t lastPaintedSerial{};
    double qpcTicksPerMillisecond{};
    std::deque<LatencySample> recentLatencySamples;
};

std::uint64_t CurrentQpc() noexcept {
    LARGE_INTEGER value{};
    QueryPerformanceCounter(&value);
    return static_cast<std::uint64_t>(value.QuadPart);
}

void SaveTestFrame(ViewerState& state) {
    std::shared_ptr<const FrameSnapshot> frame;
    {
        std::lock_guard lock(state.mutex);
        frame = state.latestFrame;
    }
    if (!frame || frame->bgra.size() != 1280u * 720u * 4u) {
        throw std::runtime_error("No complete preview frame to save");
    }
    BITMAPFILEHEADER fileHeader{};
    fileHeader.bfType = 0x4D42;
    fileHeader.bfOffBits =
        sizeof(BITMAPFILEHEADER) + sizeof(BITMAPINFOHEADER);
    fileHeader.bfSize = fileHeader.bfOffBits +
                        static_cast<DWORD>(frame->bgra.size());
    BITMAPINFOHEADER bitmapHeader{};
    bitmapHeader.biSize = sizeof(BITMAPINFOHEADER);
    bitmapHeader.biWidth = 1280;
    bitmapHeader.biHeight = -720;
    bitmapHeader.biPlanes = 1;
    bitmapHeader.biBitCount = 32;
    bitmapHeader.biCompression = BI_RGB;
    bitmapHeader.biSizeImage = static_cast<DWORD>(frame->bgra.size());

    std::ofstream image("out\\receiver_last_frame.bmp",
                        std::ios::binary | std::ios::trunc);
    image.write(reinterpret_cast<const char*>(&fileHeader),
                sizeof(fileHeader));
    image.write(reinterpret_cast<const char*>(&bitmapHeader),
                sizeof(bitmapHeader));
    image.write(reinterpret_cast<const char*>(frame->bgra.data()),
                static_cast<std::streamsize>(frame->bgra.size()));
    if (!image) {
        throw std::runtime_error("Save receiver test frame failed");
    }
}

LRESULT CALLBACK ViewerWindowProc(HWND window, UINT message, WPARAM wParam,
                                  LPARAM lParam) {
    if (message == WM_NCCREATE) {
        const auto* create = reinterpret_cast<const CREATESTRUCT*>(lParam);
        SetWindowLongPtr(window, GWLP_USERDATA,
                         reinterpret_cast<LONG_PTR>(create->lpCreateParams));
    }
    auto* state = reinterpret_cast<ViewerState*>(
        GetWindowLongPtr(window, GWLP_USERDATA));
    switch (message) {
    case WM_KEYDOWN:
        if (wParam == VK_ESCAPE) {
            DestroyWindow(window);
            return 0;
        }
        break;
    case WM_PAINT: {
        PAINTSTRUCT paint{};
        HDC dc = BeginPaint(window, &paint);
        RECT client{};
        GetClientRect(window, &client);
        std::shared_ptr<const FrameSnapshot> frame;
        if (state != nullptr) {
            std::lock_guard lock(state->mutex);
            frame = state->latestFrame;
        }
        if (frame) {
            BITMAPINFO bitmap{};
            bitmap.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
            bitmap.bmiHeader.biWidth = 1280;
            bitmap.bmiHeader.biHeight = -720;
            bitmap.bmiHeader.biPlanes = 1;
            bitmap.bmiHeader.biBitCount = 32;
            bitmap.bmiHeader.biCompression = BI_RGB;
            StretchDIBits(dc, 0, 0, client.right, client.bottom, 0, 0, 1280,
                          720, frame->bgra.data(), &bitmap, DIB_RGB_COLORS,
                          SRCCOPY);
        } else {
            FillRect(dc, &client,
                     static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, RGB(255, 255, 255));
            const wchar_t waiting[] =
                L"Waiting for 127.0.0.1:5000 H.264 stream...";
            TextOut(dc, 24, 24, waiting,
                    static_cast<int>(sizeof(waiting) / sizeof(wchar_t) - 1));
        }
        EndPaint(window, &paint);
        if (state != nullptr && frame &&
            frame->serial != state->lastPaintedSerial) {
            state->lastPaintedSerial = frame->serial;
            ++state->paintedFrames;
            const std::uint64_t paintedQpc = CurrentQpc();
            if (frame->senderQueuedQpc != 0 &&
                frame->senderQueuedQpc <= frame->receivedQpc &&
                frame->receivedQpc <= frame->decodedQpc &&
                frame->decodedQpc <= paintedQpc) {
                const double ticks = state->qpcTicksPerMillisecond;
                const LatencySample sample{
                    (frame->receivedQpc - frame->senderQueuedQpc) / ticks,
                    (frame->decodedQpc - frame->receivedQpc) / ticks,
                    (paintedQpc - frame->decodedQpc) / ticks,
                    (paintedQpc - frame->senderQueuedQpc) / ticks};
                state->recentLatencySamples.push_back(sample);
                if (state->recentLatencySamples.size() >
                    kMaxLatencySamples) {
                    state->recentLatencySamples.pop_front();
                }
                if (state->paintedFrames % 30 == 0) {
                    const std::wstring title =
                        L"RemoteDesk Receiver | packet-to-paint " +
                        std::to_wstring(
                            static_cast<int>(sample.totalMilliseconds)) +
                        L" ms";
                    SetWindowText(window, title.c_str());
                }
            }
        }
        return 0;
    }
    case kFrameReady:
        InvalidateRect(window, nullptr, FALSE);
        return 0;
    case kStreamDone:
        if (state != nullptr) {
            std::wstring title;
            {
                std::lock_guard lock(state->mutex);
                title = state->error.empty()
                            ? L"RemoteDesk Receiver | stream ended | Esc closes"
                            : L"RemoteDesk Receiver | error | Esc closes";
            }
            SetWindowText(window, title.c_str());
            if (state->autoCloseOnDone) {
                InvalidateRect(window, nullptr, FALSE);
                UpdateWindow(window);
                DestroyWindow(window);
            }
        }
        return 0;
    case WM_TIMER:
        if (wParam == kCancelTestTimer) {
            DestroyWindow(window);
            return 0;
        }
        break;
    case WM_DESTROY:
        KillTimer(window, kCancelTestTimer);
        if (state != nullptr) {
            state->stopRequested = true;
        }
        PostQuitMessage(0);
        return 0;
    default:
        break;
    }
    return DefWindowProc(window, message, wParam, lParam);
}

void ReceiveAndDecode(ViewerState& state) {
    const HRESULT comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(comResult)) {
        std::lock_guard lock(state.mutex);
        state.error = "CoInitializeEx failed";
        PostMessage(state.window, kStreamDone, 0, 0);
        return;
    }
    struct ComCleanup {
        ~ComCleanup() { CoUninitialize(); }
    } cleanup;

    try {
        remotedesk::H264NetworkDecoder decoder;
        struct PacketTiming {
            std::uint64_t senderQueuedQpc{};
            std::uint64_t receivedQpc{};
        };
        std::map<std::uint64_t, PacketTiming> timingBySample;
        std::uint64_t nextFrameSerial = 0;
        decoder.Start(1280, 720, 30,
                      [&state, &timingBySample, &nextFrameSerial](
                          std::vector<std::uint8_t>&& bgra, unsigned,
                          unsigned, std::uint64_t sampleTime) {
                          auto frame = std::make_shared<FrameSnapshot>();
                          frame->bgra = std::move(bgra);
                          frame->serial = ++nextFrameSerial;
                          const auto timing = timingBySample.find(sampleTime);
                          if (timing != timingBySample.end()) {
                              frame->senderQueuedQpc =
                                  timing->second.senderQueuedQpc;
                              frame->receivedQpc =
                                  timing->second.receivedQpc;
                              timingBySample.erase(timing);
                              ++state.timingMatches;
                          }
                          frame->decodedQpc = CurrentQpc();
                          {
                              std::lock_guard lock(state.mutex);
                              state.latestFrame = std::move(frame);
                          }
                          PostMessage(state.window, kFrameReady, 0, 0);
                      });

        const auto packets = remotedesk::ReceiveLoopbackPackets(
            5000,
            [&decoder, &timingBySample](
                const remotedesk::EncodedNetworkPacket& packet) {
                timingBySample[packet.sampleTime] = {
                    packet.senderQueuedQpc, packet.receivedQpc};
                while (timingBySample.size() > 128) {
                    timingBySample.erase(timingBySample.begin());
                }
                decoder.DecodePacket(packet.bytes, packet.sampleTime,
                                     packet.sampleDuration);
            },
            &state.stopRequested);
        const auto decoding = decoder.Stop();
        if (decoding.inputPackets != packets.packets ||
            decoding.decodedFrames != packets.packets ||
            !decoding.decodedFrameContainsImage) {
            throw std::runtime_error(
                "Received H.264 frames did not all decode into an image");
        }
        if (state.autoCloseOnDone) {
            SaveTestFrame(state);
        }

        std::ofstream log("receiver.log", std::ios::trunc);
        log << "received=" << packets.packets << ", bytes=" << packets.bytes
            << ", checksum=" << packets.checksum
            << ", decoded=" << decoding.decodedFrames
            << ", image=yes, decode_avg_ms="
            << decoding.averageDecodeMilliseconds
            << ", low_latency="
            << (decoding.lowLatencyEnabled ? "yes" : "no")
            << ", timing_matches=" << state.timingMatches << '\n';
        std::cout << "received=" << packets.packets << ", bytes="
                  << packets.bytes << ", checksum=" << packets.checksum
                  << ", decoded=" << decoding.decodedFrames
                  << ", low_latency="
                  << (decoding.lowLatencyEnabled ? "yes" : "no")
                  << ", timing_matches=" << state.timingMatches
                  << ", image=yes\n";
        {
            std::lock_guard lock(state.mutex);
            state.packets = packets;
            state.decoding = decoding;
            state.successful = true;
        }
    } catch (const std::exception& error) {
        if (!state.stopRequested.load()) {
            std::lock_guard lock(state.mutex);
            state.error = error.what();
            std::cerr << "receiver error: " << error.what() << '\n';
        }
    }
    PostMessage(state.window, kStreamDone, 0, 0);
}

HWND CreateViewerWindow(HINSTANCE instance, ViewerState& state) {
    WNDCLASSEX windowClass{};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.lpfnWndProc = ViewerWindowProc;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursor(nullptr, IDC_ARROW);
    windowClass.lpszClassName = kViewerClass;
    if (RegisterClassEx(&windowClass) == 0) {
        throw std::runtime_error("Register receiver window class failed");
    }

    RECT rectangle{0, 0, 1280, 720};
    constexpr DWORD style =
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
    AdjustWindowRect(&rectangle, style, FALSE);
    HWND window = CreateWindowEx(
        0, kViewerClass, L"RemoteDesk Receiver | waiting", style,
        CW_USEDEFAULT, CW_USEDEFAULT, rectangle.right - rectangle.left,
        rectangle.bottom - rectangle.top, nullptr, nullptr, instance, &state);
    if (window == nullptr) {
        throw std::runtime_error("Create receiver window failed");
    }
    return window;
}

} // namespace

int main(int argc, char* argv[]) {
    const bool autoClose = argc == 2 && std::string(argv[1]) == "--test";
    const bool cancelTest =
        argc == 2 && std::string(argv[1]) == "--cancel-test";
    if (argc > 1 && !autoClose && !cancelTest) {
        std::cerr << "Usage: remote_desk_receiver.exe [--test|--cancel-test]\n";
        return 2;
    }
    try {
        ViewerState state;
        state.autoCloseOnDone = autoClose;
        LARGE_INTEGER frequency{};
        if (!QueryPerformanceFrequency(&frequency) ||
            frequency.QuadPart <= 0) {
            throw std::runtime_error("QueryPerformanceFrequency failed");
        }
        state.qpcTicksPerMillisecond =
            static_cast<double>(frequency.QuadPart) / 1000.0;
        state.window = CreateViewerWindow(GetModuleHandle(nullptr), state);
        ShowWindow(state.window, SW_SHOW);
        UpdateWindow(state.window);
        std::thread receiver([&state] { ReceiveAndDecode(state); });
        if (cancelTest && SetTimer(state.window, kCancelTestTimer, 1000,
                                   nullptr) == 0) {
            state.stopRequested = true;
            receiver.join();
            DestroyWindow(state.window);
            throw std::runtime_error("Start cancellation test timer failed");
        }

        MSG message{};
        while (GetMessage(&message, nullptr, 0, 0) > 0) {
            TranslateMessage(&message);
            DispatchMessage(&message);
        }
        state.stopRequested = true;
        receiver.join();
        if (state.successful) {
            std::ofstream log("receiver.log", std::ios::app);
            const std::size_t timed = state.recentLatencySamples.size();
            log << "painted=" << state.paintedFrames << ", timed=" << timed;
            if (timed != 0) {
                std::vector<double> sorted;
                sorted.reserve(timed);
                double networkTotal = 0.0;
                double decodeTotal = 0.0;
                double uiTotal = 0.0;
                for (const auto& sample : state.recentLatencySamples) {
                    sorted.push_back(sample.totalMilliseconds);
                    networkTotal += sample.networkMilliseconds;
                    decodeTotal += sample.decodeMilliseconds;
                    uiTotal += sample.uiMilliseconds;
                }
                std::sort(sorted.begin(), sorted.end());
                const double count = static_cast<double>(timed);
                const double total = std::accumulate(
                    sorted.begin(), sorted.end(), 0.0);
                const std::size_t p95Index = (95 * timed + 99) / 100 - 1;
                log << std::fixed << std::setprecision(2)
                    << ", queue_network_avg_ms="
                    << networkTotal / count
                    << ", decode_convert_avg_ms="
                    << decodeTotal / count
                    << ", ui_avg_ms=" << uiTotal / count
                    << ", packet_to_paint_avg_ms=" << total / count
                    << ", packet_to_paint_p95_ms=" << sorted[p95Index]
                    << ", packet_to_paint_max_ms=" << sorted.back();
            }
            log << '\n';
            std::cout << "painted=" << state.paintedFrames
                      << ", timed=" << timed << '\n';
        }
        if (!state.error.empty()) {
            return 1;
        }
        if (cancelTest) {
            std::cout << "cancel test: receiver closed while waiting\n";
            return 0;
        }
        return state.successful || !autoClose ? 0 : 1;
    } catch (const std::exception& error) {
        std::cerr << "receiver error: " << error.what() << '\n';
        return 1;
    }
}
