#include <windows.h>
#include <objbase.h>

#include "h264_network_decoder.h"
#include "network_transport.h"

#include <atomic>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr wchar_t kViewerClass[] = L"RemoteDeskReceiverWindow";
constexpr UINT kFrameReady = WM_APP + 1;
constexpr UINT kStreamDone = WM_APP + 2;
constexpr UINT_PTR kCancelTestTimer = 1;

struct ViewerState {
    HWND window{};
    std::mutex mutex;
    std::shared_ptr<const std::vector<std::uint8_t>> latestFrame;
    remotedesk::PacketStatistics packets;
    remotedesk::NetworkDecodeStatistics decoding;
    std::string error;
    std::atomic_bool stopRequested{};
    bool autoCloseOnDone{};
    bool successful{};
};

void SaveTestFrame(ViewerState& state) {
    std::shared_ptr<const std::vector<std::uint8_t>> frame;
    {
        std::lock_guard lock(state.mutex);
        frame = state.latestFrame;
    }
    if (!frame || frame->size() != 1280u * 720u * 4u) {
        throw std::runtime_error("No complete preview frame to save");
    }
    BITMAPFILEHEADER fileHeader{};
    fileHeader.bfType = 0x4D42;
    fileHeader.bfOffBits =
        sizeof(BITMAPFILEHEADER) + sizeof(BITMAPINFOHEADER);
    fileHeader.bfSize = fileHeader.bfOffBits +
                        static_cast<DWORD>(frame->size());
    BITMAPINFOHEADER bitmapHeader{};
    bitmapHeader.biSize = sizeof(BITMAPINFOHEADER);
    bitmapHeader.biWidth = 1280;
    bitmapHeader.biHeight = -720;
    bitmapHeader.biPlanes = 1;
    bitmapHeader.biBitCount = 32;
    bitmapHeader.biCompression = BI_RGB;
    bitmapHeader.biSizeImage = static_cast<DWORD>(frame->size());

    std::ofstream image("out\\receiver_last_frame.bmp",
                        std::ios::binary | std::ios::trunc);
    image.write(reinterpret_cast<const char*>(&fileHeader),
                sizeof(fileHeader));
    image.write(reinterpret_cast<const char*>(&bitmapHeader),
                sizeof(bitmapHeader));
    image.write(reinterpret_cast<const char*>(frame->data()),
                static_cast<std::streamsize>(frame->size()));
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
        std::shared_ptr<const std::vector<std::uint8_t>> frame;
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
                          720, frame->data(), &bitmap, DIB_RGB_COLORS,
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
        decoder.Start(1280, 720, 30,
                      [&state](std::vector<std::uint8_t>&& bgra, unsigned,
                               unsigned) {
                          auto frame = std::make_shared<
                              const std::vector<std::uint8_t>>(std::move(bgra));
                          {
                              std::lock_guard lock(state.mutex);
                              state.latestFrame = std::move(frame);
                          }
                          PostMessage(state.window, kFrameReady, 0, 0);
                      });

        const auto packets = remotedesk::ReceiveLoopbackPackets(
            5000,
            [&decoder](const remotedesk::EncodedNetworkPacket& packet) {
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
            << decoding.averageDecodeMilliseconds << '\n';
        std::cout << "received=" << packets.packets << ", bytes="
                  << packets.bytes << ", checksum=" << packets.checksum
                  << ", decoded=" << decoding.decodedFrames << ", image=yes\n";
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
