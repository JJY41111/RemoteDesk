#include <windows.h>

#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include "h264_recorder.h"
#include "h264_loopback.h"
#include "network_transport.h"

#include <chrono>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>

using Microsoft::WRL::ComPtr;

namespace {

constexpr wchar_t kWindowClassName[] = L"RemoteDeskCaptureWindow";
constexpr wchar_t kWindowTitle[] = L"RemoteDesk - Desktop Capture";
constexpr UINT_PTR kMoveCaptureTimer = 1;
bool gToggleRecordingRequested = false;
bool gToggleLoopbackRequested = false;
std::string gMoveCaptureError;
unsigned long long gMoveCaptureFrames = 0;

void CaptureWhileMoving(HWND window);

void Log(const std::string& message) {
    std::ofstream stream("runtime.log", std::ios::app);
    stream << message << '\n';
}

std::string HResultText(const char* operation, HRESULT hr) {
    std::ostringstream stream;
    stream << operation << " failed (HRESULT 0x" << std::hex
           << static_cast<unsigned long>(hr) << ")";
    return stream.str();
}

void ThrowIfFailed(HRESULT hr, const char* operation) {
    if (FAILED(hr)) {
        throw std::runtime_error(HResultText(operation, hr));
    }
}

std::wstring ToWide(const std::string& text) {
    if (text.empty()) {
        return {};
    }

    const int required = MultiByteToWideChar(
        CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
    if (required <= 0) {
        return L"Unknown error";
    }

    std::wstring result(static_cast<size_t>(required), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()),
                        result.data(), required);
    return result;
}

LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    switch (message) {
    case WM_KEYDOWN:
        if (wParam == VK_ESCAPE) {
            DestroyWindow(window);
            return 0;
        }
        if (wParam == 'R') {
            gToggleRecordingRequested = true;
            return 0;
        }
        if (wParam == 'L') {
            gToggleLoopbackRequested = true;
            return 0;
        }
        break;
    case WM_ENTERSIZEMOVE:
        gMoveCaptureFrames = 0;
        if (SetTimer(window, kMoveCaptureTimer, 16, nullptr) == 0) {
            Log("capture: failed to start move timer");
        }
        return 0;
    case WM_EXITSIZEMOVE:
        KillTimer(window, kMoveCaptureTimer);
        Log("capture: move timer processed " +
            std::to_string(gMoveCaptureFrames) + " frames");
        return 0;
    case WM_TIMER:
        if (wParam == kMoveCaptureTimer) {
            CaptureWhileMoving(window);
            return 0;
        }
        break;
    case WM_DESTROY:
        KillTimer(window, kMoveCaptureTimer);
        PostQuitMessage(0);
        return 0;
    default:
        break;
    }

    return DefWindowProc(window, message, wParam, lParam);
}

class DesktopCaptureApp {
public:
    void Initialize(HWND window, bool automaticRecordingTest,
                    bool automaticLoopbackTest, bool automaticNetworkTest,
                    bool continuousNetwork) {
        window_ = window;
        automaticRecordingTest_ = automaticRecordingTest;
        automaticLoopbackTest_ = automaticLoopbackTest;
        automaticNetworkTest_ = automaticNetworkTest;
        continuousNetwork_ = continuousNetwork;
        Log("initialize: start");

        if ((automaticNetworkTest_ || continuousNetwork_) &&
            !SetWindowDisplayAffinity(window_, WDA_EXCLUDEFROMCAPTURE)) {
            Log("network: warning: capture window exclusion failed (Win32 " +
                std::to_string(GetLastError()) + ")");
        }

        ThrowIfFailed(CreateDXGIFactory1(IID_PPV_ARGS(&factory_)),
                      "CreateDXGIFactory1");
        Log("initialize: DXGI factory created");
        ThrowIfFailed(factory_->EnumAdapters1(0, &adapter_), "EnumAdapters1");
        Log("initialize: adapter selected");
        ThrowIfFailed(adapter_->EnumOutputs(0, &output_), "EnumOutputs");
        Log("initialize: output selected");

        output_->GetDesc(&outputDescription_);
        width_ = static_cast<UINT>(outputDescription_.DesktopCoordinates.right -
                                   outputDescription_.DesktopCoordinates.left);
        height_ = static_cast<UINT>(outputDescription_.DesktopCoordinates.bottom -
                                    outputDescription_.DesktopCoordinates.top);

        constexpr UINT deviceFlags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
        const D3D_FEATURE_LEVEL requestedLevels[] = {
            D3D_FEATURE_LEVEL_11_1,
            D3D_FEATURE_LEVEL_11_0,
        };

        D3D_FEATURE_LEVEL createdLevel{};
        HRESULT result = D3D11CreateDevice(
            adapter_.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, deviceFlags,
            requestedLevels, ARRAYSIZE(requestedLevels), D3D11_SDK_VERSION,
            &device_, &createdLevel, &context_);

        if (result == E_INVALIDARG) {
            result = D3D11CreateDevice(
                adapter_.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, deviceFlags,
                &requestedLevels[1], 1, D3D11_SDK_VERSION, &device_,
                &createdLevel, &context_);
        }
        ThrowIfFailed(result, "D3D11CreateDevice");
        Log("initialize: D3D11 device created");

        ComPtr<IDXGIOutput1> output1;
        ThrowIfFailed(output_.As(&output1), "Query IDXGIOutput1");
        ThrowIfFailed(output1->DuplicateOutput(device_.Get(), &duplication_),
                      "DuplicateOutput");
        Log("initialize: desktop duplication created");

        DXGI_SWAP_CHAIN_DESC1 swapChainDescription{};
        swapChainDescription.Width = width_;
        swapChainDescription.Height = height_;
        swapChainDescription.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        swapChainDescription.SampleDesc.Count = 1;
        swapChainDescription.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
        swapChainDescription.BufferCount = 2;
        swapChainDescription.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
        swapChainDescription.Scaling = DXGI_SCALING_STRETCH;
        swapChainDescription.AlphaMode = DXGI_ALPHA_MODE_IGNORE;

        ThrowIfFailed(factory_->CreateSwapChainForHwnd(
                          device_.Get(), window_, &swapChainDescription, nullptr,
                          nullptr, &swapChain_),
                      "CreateSwapChainForHwnd");
        Log("initialize: swap chain created");
        factory_->MakeWindowAssociation(window_, DXGI_MWA_NO_ALT_ENTER);

        ThrowIfFailed(swapChain_->GetBuffer(0, IID_PPV_ARGS(&backBuffer_)),
                      "Get swap-chain buffer");

        D3D11_TEXTURE2D_DESC latestFrameDescription{};
        latestFrameDescription.Width = width_;
        latestFrameDescription.Height = height_;
        latestFrameDescription.MipLevels = 1;
        latestFrameDescription.ArraySize = 1;
        latestFrameDescription.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        latestFrameDescription.SampleDesc.Count = 1;
        latestFrameDescription.Usage = D3D11_USAGE_DEFAULT;
        latestFrameDescription.BindFlags = D3D11_BIND_RENDER_TARGET;
        latestFrameDescription.MiscFlags = D3D11_RESOURCE_MISC_GDI_COMPATIBLE;
        ThrowIfFailed(device_->CreateTexture2D(&latestFrameDescription, nullptr,
                                               &latestFrameTexture_),
                      "Create latest-frame texture");
        ThrowIfFailed(latestFrameTexture_.As(&latestFrameSurface_),
                      "Query latest-frame GDI surface");
        Log("initialize: complete");

        statisticsStart_ = Clock::now();
    }

    void Shutdown() {
        if (automaticNetworkStarted_ && loopback_.IsRunning()) {
            StopNetwork(continuousNetwork_ ? "network live" : "network test");
        }
    }

    void CaptureNextFrame() {
        ProcessRecordingRequest();
        ProcessLoopbackRequest();
        ProcessAutomaticRecording();
        ProcessAutomaticLoopback();
        ProcessAutomaticNetwork();

        DXGI_OUTDUPL_FRAME_INFO frameInfo{};
        ComPtr<IDXGIResource> desktopResource;

        const auto captureStart = Clock::now();
        const HRESULT result = duplication_->AcquireNextFrame(
            16, &frameInfo, &desktopResource);

        if (result == DXGI_ERROR_WAIT_TIMEOUT) {
            ++timeouts_;
            EncodeCurrentFrameIfDue();
            ProcessLoopbackFrameIfDue();
            ProcessAutomaticLoopback();
            ProcessAutomaticNetwork();
            UpdateStatisticsIfNeeded();
            return;
        }

        if (result == DXGI_ERROR_ACCESS_LOST) {
            throw std::runtime_error(
                "Desktop duplication access was lost. Restart the program after "
                "a display-mode or monitor change.");
        }
        ThrowIfFailed(result, "AcquireNextFrame");

        struct FrameReleaser {
            IDXGIOutputDuplication* duplication;
            ~FrameReleaser() { duplication->ReleaseFrame(); }
        } releaseFrame{duplication_.Get()};

        ComPtr<ID3D11Texture2D> desktopTexture;
        ThrowIfFailed(desktopResource.As(&desktopTexture),
                      "Query desktop texture");

        context_->CopyResource(latestFrameTexture_.Get(), desktopTexture.Get());
        if (frameInfo.LastMouseUpdateTime.QuadPart != 0) {
            pointerVisible_ = frameInfo.PointerPosition.Visible != FALSE;
            if (pointerVisible_) {
                pointerPosition_ = frameInfo.PointerPosition.Position;
            }
        }
        DrawPointerIfNeeded();
        context_->CopyResource(backBuffer_.Get(), latestFrameTexture_.Get());
        ThrowIfFailed(swapChain_->Present(0, 0), "Present");

        const auto captureEnd = Clock::now();
        captureTimeMilliseconds_ +=
            std::chrono::duration<double, std::milli>(captureEnd - captureStart)
                .count();
        ++frames_;
        if (!firstFrameCaptured_) {
            Log("capture: first frame presented");
            firstFrameCaptured_ = true;
        }
        ProcessAutomaticRecording();
        ProcessAutomaticLoopback();
        ProcessAutomaticNetwork();
        EncodeCurrentFrameIfDue();
        ProcessLoopbackFrameIfDue();
        ProcessAutomaticLoopback();
        ProcessAutomaticNetwork();
        UpdateStatisticsIfNeeded();
    }

private:
    using Clock = std::chrono::steady_clock;

    void DrawPointerIfNeeded() {
        if (!pointerVisible_) {
            return;
        }

        CURSORINFO cursorInfo{};
        cursorInfo.cbSize = sizeof(cursorInfo);
        if (!GetCursorInfo(&cursorInfo) ||
            (cursorInfo.flags & CURSOR_SHOWING) == 0 ||
            cursorInfo.hCursor == nullptr) {
            return;
        }

        HDC dc{};
        ThrowIfFailed(latestFrameSurface_->GetDC(FALSE, &dc),
                      "Get latest-frame GDI DC");
        const BOOL drawn = DrawIconEx(dc, pointerPosition_.x, pointerPosition_.y,
                                     cursorInfo.hCursor, 0, 0, 0, nullptr,
                                     DI_NORMAL);
        const HRESULT releaseResult = latestFrameSurface_->ReleaseDC(nullptr);
        ThrowIfFailed(releaseResult, "Release latest-frame GDI DC");
        if (!drawn) {
            throw std::runtime_error("Draw desktop pointer failed");
        }
        if (++pointerCompositedFrames_ == 1) {
            Log("capture: first pointer composed");
        }
    }

    void ProcessRecordingRequest() {
        if (!gToggleRecordingRequested) {
            return;
        }
        gToggleRecordingRequested = false;

        if (recorder_.IsRecording()) {
            const auto encodedFrames = recorder_.EncodedFrames();
            recorder_.Stop();
            Log("recording: stopped after " + std::to_string(encodedFrames) +
                " frames");
            return;
        }

        if (!firstFrameCaptured_) {
            MessageBeep(MB_ICONWARNING);
            Log("recording: ignored because no desktop frame is available yet");
            return;
        }
        if (loopback_.IsRunning()) {
            MessageBeep(MB_ICONWARNING);
            Log("recording: ignored while H.264 loopback is active");
            return;
        }

        recorder_.Start(L"capture.mp4", device_.Get(), context_.Get(), width_,
                        height_, 30, 8'000'000);
        Log("recording: started capture.mp4 at 30 FPS and 8 Mbps");
    }

    void EncodeCurrentFrameIfDue() {
        if (firstFrameCaptured_) {
            recorder_.WriteFrameIfDue(latestFrameTexture_.Get());
        }
    }

    void ProcessLoopbackRequest() {
        if (!gToggleLoopbackRequested) {
            return;
        }
        gToggleLoopbackRequested = false;

        if (automaticNetworkTest_ || continuousNetwork_) {
            MessageBeep(MB_ICONWARNING);
            Log("loopback: ignored while network streaming is active");
            return;
        }

        if (loopback_.IsRunning()) {
            loopback_.Stop();
            LogLoopbackResult("loopback: stopped");
            return;
        }

        if (!firstFrameCaptured_) {
            MessageBeep(MB_ICONWARNING);
            Log("loopback: ignored because no desktop frame is available yet");
            return;
        }
        if (recorder_.IsRecording()) {
            MessageBeep(MB_ICONWARNING);
            Log("loopback: ignored while file recording is active");
            return;
        }

        loopback_.Start(device_.Get(), context_.Get(), width_, height_);
        Log("loopback: started 1280x720 H.264 memory pipeline");
    }

    void ProcessLoopbackFrameIfDue() {
        if (firstFrameCaptured_ && loopback_.IsRunning()) {
            loopback_.ProcessFrameIfDue(latestFrameTexture_.Get());
        }
    }

    void LogLoopbackResult(const std::string& prefix) {
        const auto& stats = loopback_.Statistics();
        std::ostringstream message;
        message << prefix << ": submitted=" << stats.submittedFrames
                << ", encoded=" << stats.encodedFrames
                << ", decoded=" << stats.decodedFrames
                << ", bytes=" << stats.encodedBytes << ", convert_avg_ms="
                << std::fixed << std::setprecision(2)
                << stats.averageConversionMilliseconds << ", encode_avg_ms="
                << stats.averageEncodeMilliseconds << ", queue_avg_ms="
                << stats.averageQueueMilliseconds << ", decode_avg_ms="
                << stats.averageDecodeMilliseconds << ", image="
                << (loopback_.DecodesLocally()
                        ? (stats.decodedFrameContainsImage ? "yes" : "no")
                        : "n/a (receiver decodes)");
        Log(message.str());
    }

    void StopNetwork(const char* prefix) {
        loopback_.Stop();
        const auto network = networkSender_.Stop();
        LogLoopbackResult(std::string(prefix) + ": codec completed");
        Log(std::string(prefix) + ": sent=" +
            std::to_string(network.packets) + ", bytes=" +
            std::to_string(network.bytes) + ", checksum=" +
            std::to_string(network.checksum));
    }

    void ProcessAutomaticRecording() {
        if (!automaticRecordingTest_ || !firstFrameCaptured_) {
            return;
        }

        if (!automaticRecordingStarted_) {
            recorder_.Start(L"capture.mp4", device_.Get(), context_.Get(), width_,
                            height_, 30, 8'000'000);
            automaticRecordingStarted_ = true;
            automaticRecordingStart_ = Clock::now();
            Log("recording test: started 5-second H.264 capture");
            return;
        }

        const double elapsedSeconds = std::chrono::duration<double>(
                                          Clock::now() - automaticRecordingStart_)
                                          .count();
        if (recorder_.IsRecording() && elapsedSeconds >= 5.0) {
            const auto encodedFrames = recorder_.EncodedFrames();
            recorder_.Stop();
            Log("recording test: completed after " +
                std::to_string(encodedFrames) + " frames, pointer_draws=" +
                std::to_string(pointerCompositedFrames_));
            PostMessage(window_, WM_CLOSE, 0, 0);
        }
    }

    void ProcessAutomaticLoopback() {
        if (!automaticLoopbackTest_ || !firstFrameCaptured_) {
            return;
        }

        if (!automaticLoopbackStarted_) {
            loopback_.Start(device_.Get(), context_.Get(), width_, height_);
            automaticLoopbackStarted_ = true;
            automaticLoopbackStart_ = Clock::now();
            Log("loopback test: started 5-second in-memory codec test");
            return;
        }

        const double elapsedSeconds = std::chrono::duration<double>(
                                          Clock::now() - automaticLoopbackStart_)
                                          .count();
        if (loopback_.IsRunning() && elapsedSeconds >= 5.0) {
            loopback_.Stop();
            LogLoopbackResult("loopback test: completed");
            PostMessage(window_, WM_CLOSE, 0, 0);
        }
    }

    void ProcessAutomaticNetwork() {
        if ((!automaticNetworkTest_ && !continuousNetwork_) ||
            !firstFrameCaptured_) {
            return;
        }

        if (!automaticNetworkStarted_) {
            networkSender_.StartLoopback(5000);
            loopback_.SetPacketCallback(
                [this](const std::vector<std::uint8_t>& bytes,
                       LONGLONG sampleTime, LONGLONG sampleDuration) {
                    networkSender_.QueuePacket(
                        bytes, static_cast<std::uint64_t>(sampleTime),
                        static_cast<std::uint64_t>(sampleDuration),
                        loopback_.OutputWidth(), loopback_.OutputHeight());
                });
            loopback_.Start(device_.Get(), context_.Get(), width_, height_,
                            1280, 720, 30, 4'000'000, false);
            automaticNetworkStarted_ = true;
            automaticNetworkStart_ = Clock::now();
            Log(std::string(continuousNetwork_ ? "network live" :
                                             "network test") +
                ": connected to 127.0.0.1:5000");
            return;
        }

        if (continuousNetwork_) {
            return;
        }
        const double elapsedSeconds = std::chrono::duration<double>(
                                          Clock::now() - automaticNetworkStart_)
                                          .count();
        if (loopback_.IsRunning() && elapsedSeconds >= 5.0) {
            StopNetwork("network test");
            PostMessage(window_, WM_CLOSE, 0, 0);
        }
    }

    void UpdateStatisticsIfNeeded() {
        const auto now = Clock::now();
        const double seconds =
            std::chrono::duration<double>(now - statisticsStart_).count();
        if (seconds < 1.0) {
            return;
        }

        const double fps = static_cast<double>(frames_) / seconds;
        const double averageCaptureMilliseconds =
            frames_ == 0 ? 0.0
                         : captureTimeMilliseconds_ / static_cast<double>(frames_);

        std::wostringstream title;
        title << L"RemoteDesk | " << width_ << L"x" << height_ << L" | "
              << std::fixed << std::setprecision(1) << fps << L" FPS | avg "
              << std::setprecision(2) << averageCaptureMilliseconds
              << L" ms | timeouts " << timeouts_;
        if (recorder_.IsRecording()) {
            title << L" | REC H.264 " << recorder_.EncodedFrames()
                  << L" frames";
        } else if (loopback_.IsRunning()) {
            const auto& loopbackStats = loopback_.Statistics();
            if (automaticNetworkStarted_) {
                title << L" | NET 720p enc " << loopbackStats.encodedFrames
                      << L" | convert/encode " << std::setprecision(1)
                      << loopbackStats.averageConversionMilliseconds << L"/"
                      << loopbackStats.averageEncodeMilliseconds << L" ms";
            } else {
                title << L" | LOOP 720p enc " << loopbackStats.encodedFrames
                      << L" dec " << loopbackStats.decodedFrames << L" | "
                      << std::setprecision(1)
                      << loopbackStats.averageEncodeMilliseconds << L"/"
                      << loopbackStats.averageDecodeMilliseconds << L" ms";
            }
        } else {
            title << L" | R: record | L: loopback";
        }
        SetWindowText(window_, title.str().c_str());

        frames_ = 0;
        timeouts_ = 0;
        captureTimeMilliseconds_ = 0.0;
        statisticsStart_ = now;
    }

    HWND window_{};
    UINT width_{};
    UINT height_{};
    DXGI_OUTPUT_DESC outputDescription_{};

    ComPtr<IDXGIFactory2> factory_;
    ComPtr<IDXGIAdapter1> adapter_;
    ComPtr<IDXGIOutput> output_;
    ComPtr<ID3D11Device> device_;
    ComPtr<ID3D11DeviceContext> context_;
    ComPtr<IDXGIOutputDuplication> duplication_;
    ComPtr<IDXGISwapChain1> swapChain_;
    ComPtr<ID3D11Texture2D> backBuffer_;
    ComPtr<ID3D11Texture2D> latestFrameTexture_;
    ComPtr<IDXGISurface1> latestFrameSurface_;
    remotedesk::H264Recorder recorder_;
    remotedesk::H264Loopback loopback_;
    remotedesk::TcpPacketSender networkSender_;
    POINT pointerPosition_{};
    bool pointerVisible_{};
    unsigned long long pointerCompositedFrames_{};

    Clock::time_point statisticsStart_{};
    unsigned long long frames_{};
    unsigned long long timeouts_{};
    double captureTimeMilliseconds_{};
    bool firstFrameCaptured_{};
    bool automaticRecordingTest_{};
    bool automaticRecordingStarted_{};
    Clock::time_point automaticRecordingStart_{};
    bool automaticLoopbackTest_{};
    bool automaticLoopbackStarted_{};
    Clock::time_point automaticLoopbackStart_{};
    bool automaticNetworkTest_{};
    bool continuousNetwork_{};
    bool automaticNetworkStarted_{};
    Clock::time_point automaticNetworkStart_{};
};

DesktopCaptureApp* gApplication = nullptr;

void CaptureWhileMoving(HWND window) {
    if (gApplication == nullptr || !gMoveCaptureError.empty()) {
        return;
    }
    try {
        gApplication->CaptureNextFrame();
        ++gMoveCaptureFrames;
    } catch (const std::exception& error) {
        gMoveCaptureError = error.what();
        PostMessage(window, WM_CLOSE, 0, 0);
    }
}

HWND CreateMainWindow(HINSTANCE instance) {
    WNDCLASSEX windowClass{};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.lpfnWndProc = WindowProc;
    windowClass.hInstance = instance;
    windowClass.hCursor = LoadCursor(nullptr, IDC_ARROW);
    windowClass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    windowClass.lpszClassName = kWindowClassName;

    if (RegisterClassEx(&windowClass) == 0) {
        ThrowIfFailed(HRESULT_FROM_WIN32(GetLastError()), "RegisterClassEx");
    }

    RECT windowRectangle{0, 0, 1280, 720};
    const DWORD windowStyle =
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX;
    AdjustWindowRect(&windowRectangle, windowStyle, FALSE);

    HWND window = CreateWindowEx(
        0, kWindowClassName, kWindowTitle, windowStyle, CW_USEDEFAULT,
        CW_USEDEFAULT, windowRectangle.right - windowRectangle.left,
        windowRectangle.bottom - windowRectangle.top, nullptr, nullptr, instance,
        nullptr);
    if (window == nullptr) {
        ThrowIfFailed(HRESULT_FROM_WIN32(GetLastError()), "CreateWindowEx");
    }

    return window;
}

} // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR commandLine,
                    int showCommand) {
    try {
        const HRESULT comResult =
            CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        ThrowIfFailed(comResult, "CoInitializeEx");
        struct ComUninitializer {
            ~ComUninitializer() { CoUninitialize(); }
        } comUninitializer;

        {
            std::ofstream resetLog("runtime.log", std::ios::trunc);
            resetLog << "RemoteDesk runtime started\n";
        }
        const HWND window = CreateMainWindow(instance);
        Log("window: created");

        DesktopCaptureApp application;
        const bool automaticRecordingTest =
            commandLine != nullptr &&
            wcsstr(commandLine, L"--record-test") != nullptr;
        const bool automaticLoopbackTest =
            commandLine != nullptr &&
            wcsstr(commandLine, L"--loopback-test") != nullptr;
        const bool automaticNetworkTest =
            commandLine != nullptr &&
            wcsstr(commandLine, L"--network-test") != nullptr;
        const bool continuousNetwork =
            commandLine != nullptr &&
            wcsstr(commandLine, L"--network-live") != nullptr;
        if (static_cast<int>(automaticRecordingTest) +
                static_cast<int>(automaticLoopbackTest) +
                static_cast<int>(automaticNetworkTest) +
                static_cast<int>(continuousNetwork) > 1) {
            throw std::invalid_argument("Choose only one test or live mode");
        }
        application.Initialize(window, automaticRecordingTest,
                               automaticLoopbackTest, automaticNetworkTest,
                               continuousNetwork);
        gApplication = &application;

        ShowWindow(window, showCommand);
        UpdateWindow(window);
        Log("window: shown");

        MSG message{};
        bool running = true;
        while (running) {
            while (PeekMessage(&message, nullptr, 0, 0, PM_REMOVE)) {
                if (message.message == WM_QUIT) {
                    running = false;
                    break;
                }
                TranslateMessage(&message);
                DispatchMessage(&message);
            }

            if (running) {
                application.CaptureNextFrame();
            }
        }

        application.Shutdown();
        gApplication = nullptr;
        if (!gMoveCaptureError.empty()) {
            throw std::runtime_error(gMoveCaptureError);
        }

        return static_cast<int>(message.wParam);
    } catch (const std::exception& error) {
        Log(std::string("fatal: ") + error.what());
        const std::wstring message = ToWide(error.what());
        MessageBox(nullptr, message.c_str(), L"RemoteDesk error",
                   MB_OK | MB_ICONERROR);
        return 1;
    }
}
