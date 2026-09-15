#include <windows.h>

#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <chrono>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <string>

using Microsoft::WRL::ComPtr;

namespace {

constexpr wchar_t kWindowClassName[] = L"RemoteDeskCaptureWindow";
constexpr wchar_t kWindowTitle[] = L"RemoteDesk - Desktop Capture";

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
        break;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    default:
        break;
    }

    return DefWindowProc(window, message, wParam, lParam);
}

class DesktopCaptureApp {
public:
    void Initialize(HWND window) {
        window_ = window;

        ThrowIfFailed(CreateDXGIFactory1(IID_PPV_ARGS(&factory_)),
                      "CreateDXGIFactory1");
        ThrowIfFailed(factory_->EnumAdapters1(0, &adapter_), "EnumAdapters1");
        ThrowIfFailed(adapter_->EnumOutputs(0, &output_), "EnumOutputs");

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

        ComPtr<IDXGIOutput1> output1;
        ThrowIfFailed(output_.As(&output1), "Query IDXGIOutput1");
        ThrowIfFailed(output1->DuplicateOutput(device_.Get(), &duplication_),
                      "DuplicateOutput");

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
        factory_->MakeWindowAssociation(window_, DXGI_MWA_NO_ALT_ENTER);

        ThrowIfFailed(swapChain_->GetBuffer(0, IID_PPV_ARGS(&backBuffer_)),
                      "Get swap-chain buffer");

        statisticsStart_ = Clock::now();
    }

    void CaptureNextFrame() {
        DXGI_OUTDUPL_FRAME_INFO frameInfo{};
        ComPtr<IDXGIResource> desktopResource;

        const auto captureStart = Clock::now();
        const HRESULT result = duplication_->AcquireNextFrame(
            16, &frameInfo, &desktopResource);

        if (result == DXGI_ERROR_WAIT_TIMEOUT) {
            ++timeouts_;
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

        context_->CopyResource(backBuffer_.Get(), desktopTexture.Get());
        ThrowIfFailed(swapChain_->Present(0, 0), "Present");

        const auto captureEnd = Clock::now();
        captureTimeMilliseconds_ +=
            std::chrono::duration<double, std::milli>(captureEnd - captureStart)
                .count();
        ++frames_;
        UpdateStatisticsIfNeeded();
    }

private:
    using Clock = std::chrono::steady_clock;

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

    Clock::time_point statisticsStart_{};
    unsigned long long frames_{};
    unsigned long long timeouts_{};
    double captureTimeMilliseconds_{};
};

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

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int showCommand) {
    try {
        const HWND window = CreateMainWindow(instance);

        DesktopCaptureApp application;
        application.Initialize(window);

        ShowWindow(window, showCommand);
        UpdateWindow(window);

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

        return static_cast<int>(message.wParam);
    } catch (const std::exception& error) {
        const std::wstring message = ToWide(error.what());
        MessageBox(nullptr, message.c_str(), L"RemoteDesk error",
                   MB_OK | MB_ICONERROR);
        return 1;
    }
}
