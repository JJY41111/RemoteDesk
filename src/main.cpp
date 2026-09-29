#include <windows.h>

#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include "h264_recorder.h"
#include "h264_loopback.h"
#include "network_transport.h"

#include <algorithm>
#include <chrono>
#include <cstdint>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>
#include <utility>

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

std::string ReceiverAddressFromCommandLine(const wchar_t* commandLine) {
    if (commandLine == nullptr) {
        return "127.0.0.1";
    }
    const std::wstring arguments(commandLine);
    constexpr wchar_t option[] = L"--connect=";
    const auto optionStart = arguments.find(option);
    if (optionStart == std::wstring::npos) {
        return "127.0.0.1";
    }
    const auto addressStart =
        optionStart + sizeof(option) / sizeof(option[0]) - 1;
    const auto addressEnd = arguments.find_first_of(L" \t\r\n\"", addressStart);
    const std::wstring address = arguments.substr(
        addressStart, addressEnd == std::wstring::npos
                          ? std::wstring::npos : addressEnd - addressStart);
    if (address.empty() ||
        !std::all_of(address.begin(), address.end(),
                     [](wchar_t character) {
                         return (character >= L'0' && character <= L'9') ||
                                character == L'.';
                     })) {
        throw std::invalid_argument(
            "--connect requires a numeric IPv4 address");
    }
    std::string asciiAddress;
    asciiAddress.reserve(address.size());
    for (const wchar_t character : address) {
        asciiAddress.push_back(static_cast<char>(character));
    }
    return asciiAddress;
}

std::pair<UINT, UINT> DisplayFromCommandLine(const wchar_t* commandLine) {
    if (commandLine == nullptr) return {0, 0};
    const std::wstring arguments(commandLine);
    constexpr wchar_t option[] = L"--display=";
    const auto start = arguments.find(option);
    if (start == std::wstring::npos) return {0, 0};
    const auto valueStart = start + sizeof(option) / sizeof(option[0]) - 1;
    const auto valueEnd = arguments.find_first_of(L" \t\r\n\"", valueStart);
    const std::wstring value = arguments.substr(valueStart,
        valueEnd == std::wstring::npos ? std::wstring::npos : valueEnd - valueStart);
    if (value.size() != 3 || value[0] < L'0' || value[0] > L'9' ||
        value[1] != L':' || value[2] < L'0' || value[2] > L'9') {
        throw std::invalid_argument("--display expects adapter:output, such as 0:0");
    }
    return {static_cast<UINT>(value[0] - L'0'),
            static_cast<UINT>(value[2] - L'0')};
}

unsigned short NetworkPortFromCommandLine(const wchar_t* commandLine) {
    if (commandLine == nullptr) return 5000;
    const std::wstring arguments(commandLine);
    constexpr wchar_t option[] = L"--tcp-port=";
    const auto start = arguments.find(option);
    if (start == std::wstring::npos) return 5000;
    const auto valueStart = start + sizeof(option) / sizeof(option[0]) - 1;
    const auto valueEnd = arguments.find_first_of(L" \t\r\n\"", valueStart);
    const std::wstring value = arguments.substr(
        valueStart, valueEnd == std::wstring::npos ? std::wstring::npos
                                                   : valueEnd - valueStart);
    if (value.empty() || value.size() > 5 ||
        !std::all_of(value.begin(), value.end(), [](wchar_t character) {
            return character >= L'0' && character <= L'9';
        })) {
        throw std::invalid_argument("--tcp-port expects 1024 to 65535");
    }
    const unsigned port = static_cast<unsigned>(std::stoul(value));
    if (port < 1024 || port > 65535) {
        throw std::invalid_argument("--tcp-port expects 1024 to 65535");
    }
    return static_cast<unsigned short>(port);
}

unsigned NetworkTestDurationFromCommandLine(const wchar_t* commandLine) {
    if (commandLine == nullptr) {
        return 5;
    }
    const std::wstring arguments(commandLine);
    constexpr wchar_t option[] = L"--duration=";
    const auto optionStart = arguments.find(option);
    if (optionStart == std::wstring::npos) {
        return 5;
    }
    const auto valueStart =
        optionStart + sizeof(option) / sizeof(option[0]) - 1;
    const auto valueEnd = arguments.find_first_of(L" \t\r\n\"", valueStart);
    const std::wstring value = arguments.substr(
        valueStart, valueEnd == std::wstring::npos
                        ? std::wstring::npos : valueEnd - valueStart);
    if (value.empty() || value.size() > 3 ||
        !std::all_of(value.begin(), value.end(),
                     [](wchar_t character) {
                         return character >= L'0' && character <= L'9';
                     })) {
        throw std::invalid_argument("--duration expects 1 to 300 seconds");
    }
    const unsigned seconds = static_cast<unsigned>(std::stoul(value));
    if (seconds < 1 || seconds > 300) {
        throw std::invalid_argument("--duration expects 1 to 300 seconds");
    }
    return seconds;
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
                    bool automaticLoopbackTest, bool loopback1080Test,
                    bool loopbackNativeTest,
                    bool cpuConversion, bool networkNative,
                    bool automaticNetworkTest,
                    bool continuousNetwork, unsigned networkFramesPerSecond,
                    unsigned networkOutputWidth,
                    unsigned networkOutputHeight,
                    std::string networkReceiverIpv4,
                    unsigned networkTestDurationSeconds,
                    unsigned short networkTcpPort,
                    UINT adapterIndex, UINT outputIndex) {
        window_ = window;
        automaticRecordingTest_ = automaticRecordingTest;
        automaticLoopbackTest_ = automaticLoopbackTest;
        loopback1080Test_ = loopback1080Test;
        loopbackNativeTest_ = loopbackNativeTest;
        cpuConversion_ = cpuConversion;
        networkNative_ = networkNative;
        automaticNetworkTest_ = automaticNetworkTest;
        continuousNetwork_ = continuousNetwork;
        networkFramesPerSecond_ = networkFramesPerSecond;
        networkOutputWidth_ = networkOutputWidth;
        networkOutputHeight_ = networkOutputHeight;
        networkReceiverIpv4_ = std::move(networkReceiverIpv4);
        networkTestDurationSeconds_ = networkTestDurationSeconds;
        networkTcpPort_ = networkTcpPort;
        Log("initialize: start");

        if ((automaticNetworkTest_ || continuousNetwork_) &&
            !SetWindowDisplayAffinity(window_, WDA_EXCLUDEFROMCAPTURE)) {
            Log("network: warning: capture window exclusion failed (Win32 " +
                std::to_string(GetLastError()) + ")");
        }

        ThrowIfFailed(CreateDXGIFactory1(IID_PPV_ARGS(&factory_)),
                      "CreateDXGIFactory1");
        Log("initialize: DXGI factory created");
        ThrowIfFailed(factory_->EnumAdapters1(adapterIndex, &adapter_), "EnumAdapters1");
        Log("initialize: adapter selected");
        ThrowIfFailed(adapter_->EnumOutputs(outputIndex, &output_), "EnumOutputs");
        Log("initialize: output selected: adapter=" + std::to_string(adapterIndex) +
            ", output=" + std::to_string(outputIndex));

        output_->GetDesc(&outputDescription_);
        width_ = static_cast<UINT>(outputDescription_.DesktopCoordinates.right -
                                   outputDescription_.DesktopCoordinates.left);
        height_ = static_cast<UINT>(outputDescription_.DesktopCoordinates.bottom -
                                    outputDescription_.DesktopCoordinates.top);
        if (networkNative_) {
            if (width_ != 2560 || height_ != 1440) {
                throw std::invalid_argument(
                    "Native stream currently requires a 2560x1440 capture source");
            }
            networkOutputWidth_ = width_;
            networkOutputHeight_ = height_;
        }
        Log("initialize: capture source=" + std::to_string(width_) + "x" +
            std::to_string(height_));

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
        firstFrameWaitStart_ = statisticsStart_;
    }

    void Shutdown() {
        if (automaticNetworkStarted_ && loopback_.IsRunning()) {
            if (continuousNetwork_) {
                try {
                    StopNetwork("network live", false);
                } catch (const std::exception& error) {
                    Log(std::string("network live: stopped after disconnect: ") +
                        error.what());
                }
            } else {
                StopNetwork("network test");
            }
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
        const UINT captureTimeout =
            automaticNetworkStarted_ && networkFramesPerSecond_ == 60
                ? loopback_.MillisecondsUntilNextFrame()
                : 16;
        const HRESULT result = duplication_->AcquireNextFrame(
            captureTimeout, &frameInfo, &desktopResource);

        if (result == DXGI_ERROR_WAIT_TIMEOUT) {
            ++timeouts_;
            if (!firstFrameCaptured_ &&
                !initialFrameFallbackAttempted_ &&
                (automaticNetworkTest_ || continuousNetwork_) &&
                Clock::now() - firstFrameWaitStart_ >=
                    std::chrono::milliseconds(250)) {
                initialFrameFallbackAttempted_ = true;
                try {
                    SeedFirstFrameFromScreen();
                } catch (const std::exception& error) {
                    Log(std::string("capture: initial GDI frame unavailable: ") +
                        error.what());
                }
                if (firstFrameCaptured_) {
                    ProcessAutomaticNetwork();
                }
            }
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
        // The local preview competes with a full-screen game for GPU time.
        // Live/network capture only needs latestFrameTexture_ for encoding.
        if (!automaticNetworkTest_ && !continuousNetwork_) {
            context_->CopyResource(backBuffer_.Get(), latestFrameTexture_.Get());
            ThrowIfFailed(swapChain_->Present(0, 0), "Present");
        }

        const LONGLONG sourceEventQpc = std::max(
            frameInfo.LastPresentTime.QuadPart,
            frameInfo.LastMouseUpdateTime.QuadPart);
        if (sourceEventQpc > 0) {
            latestSourceEventQpc_ =
                static_cast<std::uint64_t>(sourceEventQpc);
        }
        LARGE_INTEGER captureReadyQpc{};
        if (!QueryPerformanceCounter(&captureReadyQpc)) {
            throw std::runtime_error("Query capture performance counter failed");
        }
        latestCaptureReadyQpc_ =
            static_cast<std::uint64_t>(captureReadyQpc.QuadPart);

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

    void SeedFirstFrameFromScreen() {
        HDC screenDc = GetDC(nullptr);
        if (screenDc == nullptr) {
            throw std::runtime_error("Get screen DC for initial frame failed");
        }
        HDC frameDc = nullptr;
        const HRESULT getResult = latestFrameSurface_->GetDC(TRUE, &frameDc);
        if (FAILED(getResult)) {
            ReleaseDC(nullptr, screenDc);
            ThrowIfFailed(getResult, "Get initial-frame GDI DC");
        }
        const BOOL copied = BitBlt(
            frameDc, 0, 0, static_cast<int>(width_),
            static_cast<int>(height_), screenDc,
            outputDescription_.DesktopCoordinates.left,
            outputDescription_.DesktopCoordinates.top,
            SRCCOPY | CAPTUREBLT);
        const DWORD copyError = copied ? 0 : GetLastError();
        const HRESULT releaseResult = latestFrameSurface_->ReleaseDC(nullptr);
        ReleaseDC(nullptr, screenDc);
        ThrowIfFailed(releaseResult, "Release initial-frame GDI DC");
        if (!copied) {
            throw std::runtime_error(
                "Copy initial desktop frame failed (Win32 " +
                std::to_string(copyError) + ")");
        }

        CURSORINFO cursor{};
        cursor.cbSize = sizeof(cursor);
        if (GetCursorInfo(&cursor) &&
            (cursor.flags & CURSOR_SHOWING) != 0) {
            pointerVisible_ = true;
            pointerPosition_.x = cursor.ptScreenPos.x -
                                 outputDescription_.DesktopCoordinates.left;
            pointerPosition_.y = cursor.ptScreenPos.y -
                                 outputDescription_.DesktopCoordinates.top;
            DrawPointerIfNeeded();
        }
        if (!automaticNetworkTest_ && !continuousNetwork_) {
            context_->CopyResource(backBuffer_.Get(), latestFrameTexture_.Get());
            ThrowIfFailed(swapChain_->Present(0, 0), "Present initial frame");
        }
        latestSourceEventQpc_ = 0;
        LARGE_INTEGER captureReadyQpc{};
        if (!QueryPerformanceCounter(&captureReadyQpc)) {
            throw std::runtime_error("Query initial frame timer failed");
        }
        latestCaptureReadyQpc_ =
            static_cast<std::uint64_t>(captureReadyQpc.QuadPart);
        firstFrameCaptured_ = true;
        Log("capture: seeded first frame from GDI after DXGI timeout");
    }

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
            try {
                loopback_.ProcessFrameIfDue(latestFrameTexture_.Get(),
                                            latestSourceEventQpc_,
                                            latestCaptureReadyQpc_);
            } catch (const std::exception& error) {
                if (!continuousNetwork_ || !automaticNetworkStarted_) {
                    throw;
                }
                Log(std::string("network live: receiver disconnected: ") +
                    error.what());
                try {
                    StopNetwork("network live", false);
                } catch (const std::exception& stopError) {
                    Log(std::string("network live: stopped after disconnect: ") +
                        stopError.what());
                }
                PostMessage(window_, WM_CLOSE, 0, 0);
            }
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

    void StopNetwork(const char* prefix, bool emitFinalPackets = true) {
        loopback_.Stop(emitFinalPackets);
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
            if (loopbackNativeTest_) {
                loopback_.Start(device_.Get(), context_.Get(), width_, height_,
                                width_, height_, 60, 24'000'000, true,
                                !cpuConversion_);
            } else if (loopback1080Test_) {
                loopback_.Start(device_.Get(), context_.Get(), width_, height_,
                                1920, 1080, 60, 16'000'000, true,
                                !cpuConversion_);
            } else {
                loopback_.Start(device_.Get(), context_.Get(), width_, height_);
            }
            automaticLoopbackStarted_ = true;
            automaticLoopbackStart_ = Clock::now();
            Log(std::string("loopback test: started 5-second ") +
                (loopbackNativeTest_ ? "native60" :
                 loopback1080Test_ ? "1080p60" : "720p30") +
                " codec test; conversion=" +
                (loopback_.UsesGpuConversion() ? "gpu" : "cpu"));
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
            networkSender_.Start(networkReceiverIpv4_, networkTcpPort_);
            loopback_.SetPacketCallback(
                [this](const std::vector<std::uint8_t>& bytes,
                       LONGLONG sampleTime, LONGLONG sampleDuration,
                       std::uint64_t sourceEventQpc,
                       std::uint64_t captureReadyQpc) {
                    networkSender_.QueuePacket(
                        bytes, static_cast<std::uint64_t>(sampleTime),
                        static_cast<std::uint64_t>(sampleDuration),
                        loopback_.OutputWidth(), loopback_.OutputHeight(),
                        sourceEventQpc, captureReadyQpc,
                        networkFramesPerSecond_);
                });
            loopback_.Start(device_.Get(), context_.Get(), width_, height_,
                            networkOutputWidth_, networkOutputHeight_,
                            networkFramesPerSecond_,
                            networkOutputHeight_ > 1080 ? 24'000'000
                                : networkOutputHeight_ == 1080 ? 16'000'000
                                : networkFramesPerSecond_ == 60 ? 8'000'000
                                                                : 4'000'000,
                            false, !cpuConversion_);
            automaticNetworkStarted_ = true;
            automaticNetworkStart_ = Clock::now();
            Log(std::string("network live: conversion=") +
                (loopback_.UsesGpuConversion() ? "D3D11 video processor" :
                                                 "CPU fallback"));
            Log(std::string(continuousNetwork_ ? "network live" :
                                             "network test") +
                ": connected to " + networkReceiverIpv4_ + ":" +
                std::to_string(networkTcpPort_) + " at " +
                std::to_string(networkOutputWidth_) + "x" +
                std::to_string(networkOutputHeight_) + "@" +
                std::to_string(networkFramesPerSecond_));
            return;
        }

        if (continuousNetwork_) {
            return;
        }
        const double elapsedSeconds = std::chrono::duration<double>(
                                          Clock::now() - automaticNetworkStart_)
                                          .count();
        if (loopback_.IsRunning() &&
            elapsedSeconds >= networkTestDurationSeconds_) {
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
        if (automaticNetworkStarted_ && loopback_.IsRunning()) {
            const auto& current = loopback_.Statistics();
            const double conversionTotal =
                current.averageConversionMilliseconds * current.submittedFrames;
            const double encodeTotal =
                current.averageEncodeMilliseconds * current.submittedFrames;
            const auto submitted = current.submittedFrames - lastSubmitted_;
            std::ostringstream performance;
            performance << "network perf: capture_fps=" << std::fixed
                        << std::setprecision(1) << fps
                        << ", encoded_fps="
                        << (current.encodedFrames - lastEncoded_) / seconds
                        << ", capture_avg_ms=" << std::setprecision(2)
                        << averageCaptureMilliseconds << ", convert_avg_ms="
                        << (submitted ? (conversionTotal - lastConversionTotal_) /
                                            submitted : 0.0)
                        << ", encode_avg_ms="
                        << (submitted ? (encodeTotal - lastEncodeTotal_) /
                                            submitted : 0.0)
                        << ", timeouts=" << timeouts_
                        << ", conversion="
                        << (loopback_.UsesGpuConversion() ? "gpu" : "cpu");
            Log(performance.str());
            lastSubmitted_ = current.submittedFrames;
            lastEncoded_ = current.encodedFrames;
            lastConversionTotal_ = conversionTotal;
            lastEncodeTotal_ = encodeTotal;
        }

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
                title << L" | NET " << networkOutputWidth_ << L"x"
                      << networkOutputHeight_ << L"@"
                      << networkFramesPerSecond_
                      << L" enc " << loopbackStats.encodedFrames
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
    Clock::time_point firstFrameWaitStart_{};
    unsigned long long frames_{};
    unsigned long long timeouts_{};
    double captureTimeMilliseconds_{};
    std::uint64_t lastSubmitted_{};
    std::uint64_t lastEncoded_{};
    double lastConversionTotal_{};
    double lastEncodeTotal_{};
    bool firstFrameCaptured_{};
    bool initialFrameFallbackAttempted_{};
    std::uint64_t latestSourceEventQpc_{};
    std::uint64_t latestCaptureReadyQpc_{};
    bool automaticRecordingTest_{};
    bool automaticRecordingStarted_{};
    Clock::time_point automaticRecordingStart_{};
    bool automaticLoopbackTest_{};
    bool loopback1080Test_{};
    bool loopbackNativeTest_{};
    bool cpuConversion_{};
    bool networkNative_{};
    bool automaticLoopbackStarted_{};
    Clock::time_point automaticLoopbackStart_{};
    bool automaticNetworkTest_{};
    bool continuousNetwork_{};
    unsigned networkFramesPerSecond_{30};
    unsigned networkOutputWidth_{1280};
    unsigned networkOutputHeight_{720};
    std::string networkReceiverIpv4_{"127.0.0.1"};
    unsigned networkTestDurationSeconds_{5};
    unsigned short networkTcpPort_{5000};
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
            (wcsstr(commandLine, L"--loopback-test") != nullptr ||
             wcsstr(commandLine, L"--loopback-1080-60-test") != nullptr ||
             wcsstr(commandLine, L"--loopback-native-60-test") != nullptr);
        const bool loopback1080Test = commandLine != nullptr &&
            wcsstr(commandLine, L"--loopback-1080-60-test") != nullptr;
        const bool loopbackNativeTest = commandLine != nullptr &&
            wcsstr(commandLine, L"--loopback-native-60-test") != nullptr;
        const bool cpuConversion = commandLine != nullptr &&
            wcsstr(commandLine, L"--cpu-conversion") != nullptr;
        const bool network30Test = commandLine != nullptr &&
            wcsstr(commandLine, L"--network-test") != nullptr;
        const bool network60Test = commandLine != nullptr &&
            wcsstr(commandLine, L"--network-60-test") != nullptr;
        const bool network30Live = commandLine != nullptr &&
            wcsstr(commandLine, L"--network-live") != nullptr;
        const bool network60Live = commandLine != nullptr &&
            wcsstr(commandLine, L"--network-60-live") != nullptr;
        const bool network1080Test = commandLine != nullptr &&
            wcsstr(commandLine, L"--network-1080-60-test") != nullptr;
        const bool network1080Live = commandLine != nullptr &&
            wcsstr(commandLine, L"--network-1080-60-live") != nullptr;
        const bool networkNativeTest = commandLine != nullptr &&
            wcsstr(commandLine, L"--network-native-60-test") != nullptr;
        const bool networkNativeLive = commandLine != nullptr &&
            wcsstr(commandLine, L"--network-native-60-live") != nullptr;
        if (static_cast<int>(automaticRecordingTest) +
                static_cast<int>(automaticLoopbackTest) +
                static_cast<int>(network30Test) +
                static_cast<int>(network60Test) +
                static_cast<int>(network30Live) +
                static_cast<int>(network60Live) +
                static_cast<int>(network1080Test) +
                static_cast<int>(network1080Live) +
                static_cast<int>(networkNativeTest) +
                static_cast<int>(networkNativeLive) > 1) {
            throw std::invalid_argument("Choose only one test or live mode");
        }
        const bool automaticNetworkTest =
            network30Test || network60Test || network1080Test ||
            networkNativeTest;
        const bool continuousNetwork =
            network30Live || network60Live || network1080Live ||
            networkNativeLive;
        const unsigned networkFramesPerSecond =
            network60Test || network60Live || network1080Test ||
                    network1080Live || networkNativeTest || networkNativeLive
                ? 60u
                : 30u;
        const bool network1080 = network1080Test || network1080Live;
        const bool networkNative = networkNativeTest || networkNativeLive;
        const bool durationSpecified =
            commandLine != nullptr &&
            wcsstr(commandLine, L"--duration=") != nullptr;
        if (durationSpecified && !automaticNetworkTest) {
            throw std::invalid_argument(
                "--duration requires a --network-*-test mode");
        }
        const unsigned networkTestDurationSeconds =
            NetworkTestDurationFromCommandLine(commandLine);
        const unsigned short networkTcpPort =
            NetworkPortFromCommandLine(commandLine);
        const std::string receiverIpv4 =
            ReceiverAddressFromCommandLine(commandLine);
        const auto [adapterIndex, outputIndex] =
            DisplayFromCommandLine(commandLine);
        const bool connectSpecified =
            commandLine != nullptr &&
            wcsstr(commandLine, L"--connect=") != nullptr;
        if (connectSpecified && !automaticNetworkTest &&
            !continuousNetwork) {
            throw std::invalid_argument(
                "--connect requires a --network-* mode");
        }
        if (automaticNetworkTest || continuousNetwork) {
            remotedesk::ValidatePrivateIpv4Address(receiverIpv4);
        }
        application.Initialize(window, automaticRecordingTest,
                               automaticLoopbackTest, loopback1080Test,
                               loopbackNativeTest,
                               cpuConversion, networkNative,
                               automaticNetworkTest,
                               continuousNetwork, networkFramesPerSecond,
                               network1080 ? 1920u : 1280u,
                               network1080 ? 1080u : 720u, receiverIpv4,
                               networkTestDurationSeconds, networkTcpPort,
                               adapterIndex, outputIndex);
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
