#include <windows.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <algorithm>
#include <array>
#include <iostream>
#include <set>
#include <sstream>
#include <stdexcept>
#include <string>

namespace {

RECT DisplayRect(unsigned adapterIndex, unsigned outputIndex) {
    Microsoft::WRL::ComPtr<IDXGIFactory1> factory;
    Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
    Microsoft::WRL::ComPtr<IDXGIOutput> output;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory))) ||
        FAILED(factory->EnumAdapters1(adapterIndex, &adapter)) ||
        FAILED(adapter->EnumOutputs(outputIndex, &output))) {
        throw std::runtime_error("Selected capture display is unavailable");
    }
    DXGI_OUTPUT_DESC description{};
    if (FAILED(output->GetDesc(&description))) {
        throw std::runtime_error("Cannot get capture display coordinates");
    }
    return description.DesktopCoordinates;
}

int ListDisplays() {
    Microsoft::WRL::ComPtr<IDXGIFactory1> factory;
    if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) return 1;
    for (UINT adapterIndex = 0; adapterIndex < 10; ++adapterIndex) {
        Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter;
        if (factory->EnumAdapters1(adapterIndex, &adapter) == DXGI_ERROR_NOT_FOUND) break;
        for (UINT outputIndex = 0; outputIndex < 10; ++outputIndex) {
            Microsoft::WRL::ComPtr<IDXGIOutput> output;
            if (adapter->EnumOutputs(outputIndex, &output) == DXGI_ERROR_NOT_FOUND) break;
            DXGI_OUTPUT_DESC description{};
            if (FAILED(output->GetDesc(&description))) continue;
            const RECT bounds = description.DesktopCoordinates;
            std::wcout << adapterIndex << L":" << outputIndex << L" "
                       << description.DeviceName << L" "
                       << bounds.left << L"," << bounds.top << L" "
                       << bounds.right - bounds.left << L"x"
                       << bounds.bottom - bounds.top << L"\n";
        }
    }
    return 0;
}

bool Send(INPUT input) {
    return SendInput(1, &input, sizeof(input)) == 1;
}

void MouseMove(int x, int y, const RECT& display) {
    const int virtualLeft = GetSystemMetrics(SM_XVIRTUALSCREEN);
    const int virtualTop = GetSystemMetrics(SM_YVIRTUALSCREEN);
    const int virtualWidth = GetSystemMetrics(SM_CXVIRTUALSCREEN);
    const int virtualHeight = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if (virtualWidth < 2 || virtualHeight < 2) return;
    const int targetX = display.left +
        static_cast<int>((static_cast<long long>(x) *
                          (display.right - display.left - 1)) / 65535);
    const int targetY = display.top +
        static_cast<int>((static_cast<long long>(y) *
                          (display.bottom - display.top - 1)) / 65535);
    INPUT input{};
    input.type = INPUT_MOUSE;
    input.mi.dx = static_cast<LONG>((static_cast<long long>(targetX - virtualLeft) *
                                    65535) / (virtualWidth - 1));
    input.mi.dy = static_cast<LONG>((static_cast<long long>(targetY - virtualTop) *
                                    65535) / (virtualHeight - 1));
    input.mi.dwFlags = MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK |
                       MOUSEEVENTF_MOVE;
    Send(input);
}

void MouseButton(int button, bool down) {
    constexpr std::array<DWORD, 3> downFlags = {
        MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_RIGHTDOWN};
    constexpr std::array<DWORD, 3> upFlags = {
        MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_RIGHTUP};
    if (button < 0 || button >= static_cast<int>(downFlags.size())) return;
    INPUT input{};
    input.type = INPUT_MOUSE;
    input.mi.dwFlags = down ? downFlags[button] : upFlags[button];
    Send(input);
}

void MouseWheel(int delta) {
    INPUT input{};
    input.type = INPUT_MOUSE;
    input.mi.mouseData = static_cast<DWORD>(delta);
    input.mi.dwFlags = MOUSEEVENTF_WHEEL;
    Send(input);
}

void Key(unsigned key, bool down) {
    if (key > 255) return;
    INPUT input{};
    input.type = INPUT_KEYBOARD;
    const UINT scan = MapVirtualKeyW(key, MAPVK_VK_TO_VSC_EX);
    if (scan != 0) {
        input.ki.wScan = static_cast<WORD>(scan & 0xff);
        input.ki.dwFlags = KEYEVENTF_SCANCODE |
            ((scan & 0xff00) == 0xe000 ? KEYEVENTF_EXTENDEDKEY : 0);
    } else {
        input.ki.wVk = static_cast<WORD>(key);
    }
    if (!down) input.ki.dwFlags |= KEYEVENTF_KEYUP;
    Send(input);
}

void UnicodeUnit(WORD character) {
    for (const bool down : {true, false}) {
        INPUT input{};
        input.type = INPUT_KEYBOARD;
        input.ki.wScan = character;
        input.ki.dwFlags = KEYEVENTF_UNICODE |
            (down ? 0 : KEYEVENTF_KEYUP);
        Send(input);
    }
}

void Text(unsigned codepoint) {
    if (codepoint > 0x10ffff || (codepoint >= 0xd800 && codepoint <= 0xdfff)) return;
    if (codepoint <= 0xffff) {
        UnicodeUnit(static_cast<WORD>(codepoint));
        return;
    }
    const unsigned value = codepoint - 0x10000;
    UnicodeUnit(static_cast<WORD>(0xd800 + (value >> 10)));
    UnicodeUnit(static_cast<WORD>(0xdc00 + (value & 0x3ff)));
}

} // namespace

int main(int argc, char** argv) {
    if (argc > 1 && std::string(argv[1]) == "--list-displays") {
        return ListDisplays();
    }
    unsigned adapterIndex = 0, outputIndex = 0;
    if (argc > 1) {
        const std::string argument(argv[1]);
        if (argument.size() != 13 || argument.substr(0, 10) != "--display=" ||
            argument[10] < '0' || argument[10] > '9' ||
            argument[11] != ':' || argument[12] < '0' ||
            argument[12] > '9') {
            std::cerr << "Expected --display=adapter:output\n";
            return 2;
        }
        adapterIndex = static_cast<unsigned>(argument[10] - '0');
        outputIndex = static_cast<unsigned>(argument[12] - '0');
    }
    RECT display{};
    try { display = DisplayRect(adapterIndex, outputIndex); }
    catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
    std::set<unsigned> heldKeys;
    std::set<int> heldButtons;
    const auto releaseHeld = [&] {
        for (unsigned key : heldKeys) Key(key, false);
        for (int button : heldButtons) MouseButton(button, false);
        heldKeys.clear();
        heldButtons.clear();
    };
    std::string line;
    while (std::getline(std::cin, line)) {
        std::istringstream command(line);
        char kind = 0;
        command >> kind;
        if (kind == 'M') {
            int x = -1, y = -1;
            if (command >> x >> y && x >= 0 && x <= 65535 &&
                y >= 0 && y <= 65535) MouseMove(x, y, display);
        } else if (kind == 'B') {
            int button = -1, down = -1;
            if (command >> button >> down && button >= 0 && button <= 2 &&
                (down == 0 || down == 1)) {
                MouseButton(button, down != 0);
                if (down) heldButtons.insert(button);
                else heldButtons.erase(button);
            }
        } else if (kind == 'K') {
            unsigned key = 0;
            int down = -1;
            if (command >> key >> down && key > 0 && key <= 255 &&
                (down == 0 || down == 1)) {
                Key(key, down != 0);
                if (down) heldKeys.insert(key);
                else heldKeys.erase(key);
            }
        } else if (kind == 'R') {
            releaseHeld();
        } else if (kind == 'W') {
            int delta = 0;
            if (command >> delta && (delta == -120 || delta == 120)) {
                MouseWheel(delta);
            }
        } else if (kind == 'T') {
            unsigned codepoint = 0;
            if (command >> codepoint) Text(codepoint);
        }
    }
    releaseHeld();
    return 0;
}
