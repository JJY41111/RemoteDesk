// Compile-time replacement: this executable never injects Windows input.
#include <windows.h>
#include <vector>
#include <sstream>
#include <iostream>
namespace {
std::vector<INPUT> deliveredAttempts;
const std::vector<bool> results{true, false, false, true, true, false, true, false,
    true, false, true, true, true};
UINT WINAPI SimulatedSendInput(UINT count, LPINPUT input, int) {
    if (count != 1 || deliveredAttempts.size() >= results.size()) {
        std::cerr << "Unexpected injected-input attempt\n";
        std::exit(3);
    }
    const bool accepted = results[deliveredAttempts.size()];
    deliveredAttempts.push_back(*input);
    SetLastError(accepted ? ERROR_SUCCESS : ERROR_ACCESS_DENIED);
    return accepted ? 1 : 0;
}
}
#define SendInput SimulatedSendInput
#define main RemoteInputMain
#include "../../src/remote_input.cpp"
#undef main
#undef SendInput

int main() {
    // A rejected key-up survives two failures and a successful later retry.
    // A rejected button-up survives R. A rejected key-down is never held.
    std::istringstream commands("K 17 1\nK 17 0\nC\nC\nC\nB 0 1\nR\nC\nK 18 1\nR\nK 16 1\nR\nK 65 1\nR\n");
    auto* previous = std::cin.rdbuf(commands.rdbuf());
    std::ostringstream protocol;
    auto* previousOutput = std::cout.rdbuf(protocol.rdbuf());
    char name[] = "input-release-test";
    char* argv[]{name};
    const int status = RemoteInputMain(1, argv);
    std::cin.rdbuf(previous);
    std::cout.rdbuf(previousOutput);
    if (status || deliveredAttempts.size() != results.size()) return 1;
    for (size_t i = 1; i <= 3; ++i) {
        if (deliveredAttempts[i].type != INPUT_KEYBOARD ||
            !(deliveredAttempts[i].ki.dwFlags & KEYEVENTF_KEYUP)) return 2;
    }
    if (deliveredAttempts[5].mi.dwFlags != MOUSEEVENTF_LEFTUP ||
        deliveredAttempts[6].mi.dwFlags != MOUSEEVENTF_LEFTUP) return 2;
    const auto count = [&](const std::string& word) {
        size_t found = 0, at = 0;
        while ((at = protocol.str().find(word, at)) != std::string::npos) { ++found; at += word.size(); }
        return found;
    };
    if (count("INPUT_BLOCKED 5") != 4 || count("INPUT_OK") != 4) return 4;
    if (!(deliveredAttempts[10].ki.dwFlags & KEYEVENTF_KEYUP) ||
        (deliveredAttempts[11].ki.dwFlags & KEYEVENTF_KEYUP) ||
        !(deliveredAttempts[12].ki.dwFlags & KEYEVENTF_KEYUP)) return 5;
    std::cout << "PASS: denied releases retry, successful releases stop, denied presses are not held; simulated SendInput only\n";
}
