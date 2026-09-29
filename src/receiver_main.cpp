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
#include <sstream>
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
    unsigned width{};
    unsigned height{};
    std::uint64_t serial{};
    std::uint64_t sourceEventQpc{};
    std::uint64_t captureReadyQpc{};
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

struct SourceLatencySample {
    double eventToCaptureMilliseconds{};
    double captureToQueueMilliseconds{};
    double eventToPaintMilliseconds{};
};

struct ViewerState {
    HWND window{};
    std::string listenIpv4{"127.0.0.1"};
    bool sameHostTiming{true};
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
    std::uint64_t skippedPaintFrames{};
    std::uint64_t firstPaintedQpc{};
    std::uint64_t lastPaintedQpc{};
    double maxPaintGapMilliseconds{};
    std::uint64_t lastTimedSourceEventQpc{};
    unsigned windowStreamWidth{1280};
    unsigned windowStreamHeight{720};
    double qpcTicksPerMillisecond{};
    std::deque<std::uint64_t> recentPaintQpc;
    std::deque<double> recentReceiveToPaintMilliseconds;
    std::deque<LatencySample> recentLatencySamples;
    std::deque<SourceLatencySample> recentSourceLatencySamples;
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
    if (!frame || frame->bgra.size() !=
                      static_cast<std::size_t>(frame->width) *
                          frame->height * 4u) {
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
    bitmapHeader.biWidth = static_cast<LONG>(frame->width);
    bitmapHeader.biHeight = -static_cast<LONG>(frame->height);
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
            bitmap.bmiHeader.biWidth = static_cast<LONG>(frame->width);
            bitmap.bmiHeader.biHeight = -static_cast<LONG>(frame->height);
            bitmap.bmiHeader.biPlanes = 1;
            bitmap.bmiHeader.biBitCount = 32;
            bitmap.bmiHeader.biCompression = BI_RGB;
            StretchDIBits(dc, 0, 0, client.right, client.bottom, 0, 0,
                          static_cast<int>(frame->width),
                          static_cast<int>(frame->height), frame->bgra.data(),
                          &bitmap, DIB_RGB_COLORS, SRCCOPY);
        } else {
            FillRect(dc, &client,
                     static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
            SetBkMode(dc, TRANSPARENT);
            SetTextColor(dc, RGB(255, 255, 255));
            const std::string listenAddress =
                state != nullptr ? state->listenIpv4 : "127.0.0.1";
            const std::wstring waiting =
                L"Waiting on " +
                std::wstring(listenAddress.begin(), listenAddress.end()) +
                L":5000 for H.264 stream...";
            TextOut(dc, 24, 24, waiting.c_str(),
                    static_cast<int>(waiting.size()));
        }
        EndPaint(window, &paint);
        if (state != nullptr && frame &&
            frame->serial != state->lastPaintedSerial) {
            if (frame->serial > state->lastPaintedSerial + 1) {
                state->skippedPaintFrames +=
                    frame->serial - state->lastPaintedSerial - 1;
            }
            state->lastPaintedSerial = frame->serial;
            ++state->paintedFrames;
            const std::uint64_t paintedQpc = CurrentQpc();
            if (state->firstPaintedQpc == 0) {
                state->firstPaintedQpc = paintedQpc;
            }
            if (state->lastPaintedQpc != 0) {
                state->maxPaintGapMilliseconds = std::max(
                    state->maxPaintGapMilliseconds,
                    (paintedQpc - state->lastPaintedQpc) /
                        state->qpcTicksPerMillisecond);
            }
            state->lastPaintedQpc = paintedQpc;
            state->recentPaintQpc.push_back(paintedQpc);
            const auto oneSecondTicks = static_cast<std::uint64_t>(
                state->qpcTicksPerMillisecond * 1000.0);
            while (state->recentPaintQpc.size() > 2 &&
                   paintedQpc - state->recentPaintQpc.front() >
                       oneSecondTicks) {
                state->recentPaintQpc.pop_front();
            }
            if (frame->receivedQpc != 0 &&
                frame->receivedQpc <= frame->decodedQpc &&
                frame->decodedQpc <= paintedQpc) {
                const double ticks = state->qpcTicksPerMillisecond;
                state->recentReceiveToPaintMilliseconds.push_back(
                    (paintedQpc - frame->receivedQpc) / ticks);
                if (state->recentReceiveToPaintMilliseconds.size() >
                    kMaxLatencySamples) {
                    state->recentReceiveToPaintMilliseconds.pop_front();
                }
                if (state->sameHostTiming && frame->senderQueuedQpc != 0 &&
                    frame->senderQueuedQpc <= frame->receivedQpc) {
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
                    if (frame->sourceEventQpc >
                            state->lastTimedSourceEventQpc &&
                        frame->sourceEventQpc <= frame->captureReadyQpc &&
                        frame->captureReadyQpc <= frame->senderQueuedQpc) {
                        state->lastTimedSourceEventQpc = frame->sourceEventQpc;
                        state->recentSourceLatencySamples.push_back({
                            (frame->captureReadyQpc - frame->sourceEventQpc) /
                                ticks,
                            (frame->senderQueuedQpc - frame->captureReadyQpc) /
                                ticks,
                            (paintedQpc - frame->sourceEventQpc) / ticks});
                        if (state->recentSourceLatencySamples.size() >
                            kMaxLatencySamples) {
                            state->recentSourceLatencySamples.pop_front();
                        }
                    }
                }
                if (state->paintedFrames % 30 == 0) {
                    std::vector<double> recentTotals;
                    recentTotals.reserve(60);
                    if (state->sameHostTiming) {
                        for (auto it = state->recentLatencySamples.rbegin();
                             it != state->recentLatencySamples.rend() &&
                             recentTotals.size() < 60; ++it) {
                            recentTotals.push_back(it->totalMilliseconds);
                        }
                    } else {
                        for (auto it =
                                 state->recentReceiveToPaintMilliseconds.rbegin();
                             it != state->recentReceiveToPaintMilliseconds.rend() &&
                             recentTotals.size() < 60; ++it) {
                            recentTotals.push_back(*it);
                        }
                    }
                    std::sort(recentTotals.begin(), recentTotals.end());
                    const auto& paintTimes = state->recentPaintQpc;
                    const double paintSeconds =
                        (paintTimes.back() - paintTimes.front()) /
                        (state->qpcTicksPerMillisecond * 1000.0);
                    const double recentPaintFps =
                        paintTimes.size() > 1 && paintSeconds > 0.0
                            ? (paintTimes.size() - 1) / paintSeconds
                            : 0.0;
                    std::wostringstream title;
                    title << L"RemoteDesk Receiver " << frame->width << L"x"
                          << frame->height << L" | paint " << std::fixed
                          << std::setprecision(1) << recentPaintFps
                          << L" FPS | skipped " << state->skippedPaintFrames
                          << L" | worst gap "
                          << static_cast<int>(state->maxPaintGapMilliseconds)
                          << L" ms";
                    if (!recentTotals.empty()) {
                        const std::size_t p95Index =
                            (95 * recentTotals.size() + 99) / 100 - 1;
                        title << (state->sameHostTiming
                                      ? L" | packet p95 " : L" | recv p95 ")
                              << static_cast<int>(recentTotals[p95Index])
                              << L" ms";
                    }
                    if (!state->recentSourceLatencySamples.empty()) {
                        std::vector<double> recentSourceTotals;
                        recentSourceTotals.reserve(60);
                        for (auto it =
                                 state->recentSourceLatencySamples.rbegin();
                             it !=
                                 state->recentSourceLatencySamples.rend() &&
                             recentSourceTotals.size() < 60;
                             ++it) {
                            recentSourceTotals.push_back(
                                it->eventToPaintMilliseconds);
                        }
                        std::sort(recentSourceTotals.begin(),
                                  recentSourceTotals.end());
                        const std::size_t sourceP95Index =
                            (95 * recentSourceTotals.size() + 99) / 100 - 1;
                        title << L" | desktop p95 "
                              << static_cast<int>(
                                     recentSourceTotals[sourceP95Index])
                              << L" ms";
                    }
                    SetWindowText(window, title.str().c_str());
                }
            }
        }
        return 0;
    }
    case kFrameReady:
        if (state != nullptr) {
            std::shared_ptr<const FrameSnapshot> frame;
            {
                std::lock_guard lock(state->mutex);
                frame = state->latestFrame;
            }
            if (frame &&
                (frame->width != state->windowStreamWidth ||
                 frame->height != state->windowStreamHeight)) {
                const DWORD style = static_cast<DWORD>(
                    GetWindowLongPtr(window, GWL_STYLE));
                RECT nativeSize{0, 0, static_cast<LONG>(frame->width),
                                static_cast<LONG>(frame->height)};
                AdjustWindowRect(&nativeSize, style, FALSE);
                const int frameWidth =
                    nativeSize.right - nativeSize.left -
                    static_cast<int>(frame->width);
                const int frameHeight =
                    nativeSize.bottom - nativeSize.top -
                    static_cast<int>(frame->height);
                unsigned displayWidth = frame->width;
                unsigned displayHeight = frame->height;
                MONITORINFO monitorInfo{};
                monitorInfo.cbSize = sizeof(monitorInfo);
                if (GetMonitorInfo(MonitorFromWindow(
                                       window, MONITOR_DEFAULTTONEAREST),
                                   &monitorInfo)) {
                    const int workWidth = monitorInfo.rcWork.right -
                                          monitorInfo.rcWork.left;
                    const int workHeight = monitorInfo.rcWork.bottom -
                                           monitorInfo.rcWork.top;
                    const double scale = std::min(
                        {1.0,
                         static_cast<double>(workWidth - frameWidth) /
                             frame->width,
                         static_cast<double>(workHeight - frameHeight) /
                             frame->height});
                    if (scale > 0.0 && scale < 1.0) {
                        displayWidth = std::max(
                            1u, static_cast<unsigned>(frame->width * scale));
                        displayHeight = std::max(
                            1u, static_cast<unsigned>(frame->height * scale));
                    }
                }
                RECT displaySize{0, 0, static_cast<LONG>(displayWidth),
                                 static_cast<LONG>(displayHeight)};
                AdjustWindowRect(&displaySize, style, FALSE);
                SetWindowPos(window, nullptr, 0, 0,
                             displaySize.right - displaySize.left,
                             displaySize.bottom - displaySize.top,
                             SWP_NOMOVE | SWP_NOZORDER | SWP_NOACTIVATE);
                state->windowStreamWidth = frame->width;
                state->windowStreamHeight = frame->height;
            }
        }
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
            std::uint64_t sourceEventQpc{};
            std::uint64_t captureReadyQpc{};
            std::uint64_t senderQueuedQpc{};
            std::uint64_t receivedQpc{};
        };
        std::map<std::uint64_t, PacketTiming> timingBySample;
        std::uint64_t nextFrameSerial = 0;
        bool decoderStarted = false;
        unsigned streamFramesPerSecond = 0;
        unsigned streamWidth = 0;
        unsigned streamHeight = 0;
        std::uint64_t firstReceivedQpc = 0;
        std::uint64_t lastReceivedQpc = 0;
        auto onFrame = [&state, &timingBySample, &nextFrameSerial](
                          std::vector<std::uint8_t>&& bgra, unsigned width,
                          unsigned height, std::uint64_t sampleTime) {
                          auto frame = std::make_shared<FrameSnapshot>();
                          frame->bgra = std::move(bgra);
                          frame->width = width;
                          frame->height = height;
                          frame->serial = ++nextFrameSerial;
                          const auto timing = timingBySample.find(sampleTime);
                          if (timing != timingBySample.end()) {
                              frame->sourceEventQpc =
                                  timing->second.sourceEventQpc;
                              frame->captureReadyQpc =
                                  timing->second.captureReadyQpc;
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
                      };

        const auto packets = remotedesk::ReceivePackets(
            state.listenIpv4, 5000,
            [&decoder, &timingBySample, &decoderStarted,
             &streamFramesPerSecond, &streamWidth, &streamHeight,
             &firstReceivedQpc, &lastReceivedQpc, &onFrame](
                const remotedesk::EncodedNetworkPacket& packet) {
                if (!decoderStarted) {
                    decoder.Start(packet.width, packet.height,
                                  packet.framesPerSecond, onFrame);
                    decoderStarted = true;
                    streamFramesPerSecond = packet.framesPerSecond;
                    streamWidth = packet.width;
                    streamHeight = packet.height;
                } else if (packet.framesPerSecond != streamFramesPerSecond ||
                           packet.width != streamWidth ||
                           packet.height != streamHeight) {
                    throw std::runtime_error("Stream video format changed");
                }
                if (firstReceivedQpc == 0) {
                    firstReceivedQpc = packet.receivedQpc;
                }
                lastReceivedQpc = packet.receivedQpc;
                timingBySample[packet.sampleTime] = {
                    packet.sourceEventQpc, packet.captureReadyQpc,
                    packet.senderQueuedQpc, packet.receivedQpc};
                while (timingBySample.size() > 128) {
                    timingBySample.erase(timingBySample.begin());
                }
                decoder.DecodePacket(packet.bytes, packet.sampleTime,
                                     packet.sampleDuration);
            },
            &state.stopRequested);
        if (!decoderStarted) {
            throw std::runtime_error("No encoded packets received");
        }
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
        const double receiveSeconds =
            (lastReceivedQpc - firstReceivedQpc) /
            (state.qpcTicksPerMillisecond * 1000.0);
        const double receivedFramesPerSecond =
            packets.packets > 1 && receiveSeconds > 0.0
                ? (packets.packets - 1) / receiveSeconds
                : 0.0;
        log << "received=" << packets.packets << ", bytes=" << packets.bytes
            << ", checksum=" << packets.checksum
            << ", listen=" << state.listenIpv4
            << ", decoded=" << decoding.decodedFrames
            << ", image=yes, decode_avg_ms="
            << decoding.averageDecodeMilliseconds
            << ", low_latency="
            << (decoding.lowLatencyEnabled ? "yes" : "no")
            << ", timing_matches=" << state.timingMatches
            << ", resolution=" << streamWidth << "x" << streamHeight
            << ", fps_declared=" << streamFramesPerSecond
            << ", recv_fps=" << std::fixed << std::setprecision(2)
            << receivedFramesPerSecond << '\n';
        std::cout << "received=" << packets.packets << ", bytes="
                  << packets.bytes << ", checksum=" << packets.checksum
                  << ", decoded=" << decoding.decodedFrames
                  << ", low_latency="
                  << (decoding.lowLatencyEnabled ? "yes" : "no")
                  << ", timing_matches=" << state.timingMatches
                  << ", resolution=" << streamWidth << "x" << streamHeight
                  << ", fps_declared=" << streamFramesPerSecond
                  << ", recv_fps=" << std::fixed << std::setprecision(2)
                  << receivedFramesPerSecond << ", image=yes\n";
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
            std::ofstream log("receiver.log", std::ios::trunc);
            log << "error=" << error.what() << '\n';
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
    constexpr DWORD style = WS_OVERLAPPEDWINDOW;
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
    bool autoClose = false;
    bool cancelTest = false;
    bool listenSpecified = false;
    std::string listenIpv4 = "127.0.0.1";
    for (int index = 1; index < argc; ++index) {
        const std::string argument(argv[index]);
        if (argument == "--test" && !autoClose) {
            autoClose = true;
        } else if (argument == "--cancel-test" && !cancelTest) {
            cancelTest = true;
        } else if (argument.starts_with("--listen=") && !listenSpecified) {
            listenIpv4 = argument.substr(sizeof("--listen=") - 1);
            listenSpecified = true;
        } else {
            std::cerr << "Usage: remote_desk_receiver.exe "
                         "[--test|--cancel-test] [--listen=private-IPv4]\n";
            return 2;
        }
    }
    if (autoClose && cancelTest) {
        std::cerr << "Choose only one receiver test mode\n";
        return 2;
    }
    try {
        remotedesk::ValidatePrivateIpv4Address(listenIpv4);
        ViewerState state;
        state.autoCloseOnDone = autoClose;
        state.listenIpv4 = listenIpv4;
        state.sameHostTiming = listenIpv4.starts_with("127.");
        LARGE_INTEGER frequency{};
        if (!QueryPerformanceFrequency(&frequency) ||
            frequency.QuadPart <= 0) {
            throw std::runtime_error("QueryPerformanceFrequency failed");
        }
        state.qpcTicksPerMillisecond =
            static_cast<double>(frequency.QuadPart) / 1000.0;
        state.window = CreateViewerWindow(GetModuleHandle(nullptr), state);
        if (!SetWindowDisplayAffinity(state.window, WDA_EXCLUDEFROMCAPTURE)) {
            std::cerr << "receiver warning: capture window exclusion failed "
                      << "(Win32 " << GetLastError() << ")\n";
        }
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
            const double paintSeconds =
                (state.lastPaintedQpc - state.firstPaintedQpc) /
                (state.qpcTicksPerMillisecond * 1000.0);
            const double paintedFramesPerSecond =
                state.paintedFrames > 1 && paintSeconds > 0.0
                    ? (state.paintedFrames - 1) / paintSeconds
                    : 0.0;
            log << "painted=" << state.paintedFrames
                << ", paint_fps=" << std::fixed << std::setprecision(2)
                << paintedFramesPerSecond
                << ", skipped_paints=" << state.skippedPaintFrames
                << ", paint_max_gap_ms=" << std::fixed
                << std::setprecision(2) << state.maxPaintGapMilliseconds
                << ", timed=" << timed;
            std::vector<double> receiveToPaint(
                state.recentReceiveToPaintMilliseconds.begin(),
                state.recentReceiveToPaintMilliseconds.end());
            if (!receiveToPaint.empty()) {
                std::sort(receiveToPaint.begin(), receiveToPaint.end());
                const std::size_t p95Index =
                    (95 * receiveToPaint.size() + 99) / 100 - 1;
                const double sum = std::accumulate(
                    receiveToPaint.begin(), receiveToPaint.end(), 0.0);
                log << ", recv_to_paint_avg_ms="
                    << sum / receiveToPaint.size()
                    << ", recv_to_paint_p95_ms="
                    << receiveToPaint[p95Index];
            }
            if (timed != 0) {
                std::vector<double> sorted;
                std::vector<double> networkSorted;
                std::vector<double> decodeSorted;
                std::vector<double> uiSorted;
                sorted.reserve(timed);
                networkSorted.reserve(timed);
                decodeSorted.reserve(timed);
                uiSorted.reserve(timed);
                double networkTotal = 0.0;
                double decodeTotal = 0.0;
                double uiTotal = 0.0;
                for (const auto& sample : state.recentLatencySamples) {
                    sorted.push_back(sample.totalMilliseconds);
                    networkSorted.push_back(sample.networkMilliseconds);
                    decodeSorted.push_back(sample.decodeMilliseconds);
                    uiSorted.push_back(sample.uiMilliseconds);
                    networkTotal += sample.networkMilliseconds;
                    decodeTotal += sample.decodeMilliseconds;
                    uiTotal += sample.uiMilliseconds;
                }
                std::sort(sorted.begin(), sorted.end());
                std::sort(networkSorted.begin(), networkSorted.end());
                std::sort(decodeSorted.begin(), decodeSorted.end());
                std::sort(uiSorted.begin(), uiSorted.end());
                const double count = static_cast<double>(timed);
                const double total = std::accumulate(
                    sorted.begin(), sorted.end(), 0.0);
                const std::size_t p95Index = (95 * timed + 99) / 100 - 1;
                log << std::fixed << std::setprecision(2)
                    << ", queue_network_avg_ms="
                    << networkTotal / count
                    << ", queue_network_p95_ms="
                    << networkSorted[p95Index]
                    << ", decode_convert_avg_ms="
                    << decodeTotal / count
                    << ", decode_convert_p95_ms="
                    << decodeSorted[p95Index]
                    << ", ui_avg_ms=" << uiTotal / count
                    << ", ui_p95_ms=" << uiSorted[p95Index]
                    << ", packet_to_paint_avg_ms=" << total / count
                    << ", packet_to_paint_p95_ms=" << sorted[p95Index]
                    << ", packet_to_paint_max_ms=" << sorted.back();
            }
            log << '\n';
            const std::size_t sourceTimed =
                state.recentSourceLatencySamples.size();
            log << "source_timed=" << sourceTimed;
            if (sourceTimed != 0) {
                std::vector<double> eventToCapture;
                std::vector<double> captureToQueue;
                std::vector<double> eventToPaint;
                eventToCapture.reserve(sourceTimed);
                captureToQueue.reserve(sourceTimed);
                eventToPaint.reserve(sourceTimed);
                for (const auto& sample : state.recentSourceLatencySamples) {
                    eventToCapture.push_back(
                        sample.eventToCaptureMilliseconds);
                    captureToQueue.push_back(
                        sample.captureToQueueMilliseconds);
                    eventToPaint.push_back(sample.eventToPaintMilliseconds);
                }
                std::sort(eventToCapture.begin(), eventToCapture.end());
                std::sort(captureToQueue.begin(), captureToQueue.end());
                std::sort(eventToPaint.begin(), eventToPaint.end());
                const double count = static_cast<double>(sourceTimed);
                const std::size_t p95Index =
                    (95 * sourceTimed + 99) / 100 - 1;
                log << std::fixed << std::setprecision(2)
                    << ", event_to_capture_avg_ms="
                    << std::accumulate(eventToCapture.begin(),
                                       eventToCapture.end(), 0.0) / count
                    << ", event_to_capture_p95_ms="
                    << eventToCapture[p95Index]
                    << ", capture_to_queue_avg_ms="
                    << std::accumulate(captureToQueue.begin(),
                                       captureToQueue.end(), 0.0) / count
                    << ", capture_to_queue_p95_ms="
                    << captureToQueue[p95Index]
                    << ", event_to_paint_avg_ms="
                    << std::accumulate(eventToPaint.begin(),
                                       eventToPaint.end(), 0.0) / count
                    << ", event_to_paint_p95_ms="
                    << eventToPaint[p95Index]
                    << ", event_to_paint_max_ms="
                    << eventToPaint.back();
            }
            log << '\n';
            std::cout << "painted=" << state.paintedFrames
                      << ", paint_fps=" << std::fixed
                      << std::setprecision(2) << paintedFramesPerSecond
                      << ", skipped_paints=" << state.skippedPaintFrames
                      << ", paint_max_gap_ms="
                      << state.maxPaintGapMilliseconds
                      << ", timed=" << timed
                      << ", source_timed=" << sourceTimed << '\n';
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
