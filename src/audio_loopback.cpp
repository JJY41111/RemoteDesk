#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>
#include <wrl/client.h>
#include <fcntl.h>
#include <io.h>

#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {
void Check(HRESULT result, const char* step) {
    if (FAILED(result)) {
        throw std::runtime_error(std::string(step) + " failed (HRESULT " +
                                 std::to_string(static_cast<unsigned>(result)) + ")");
    }
}
}

int main() {
    try {
        if (_setmode(_fileno(stdout), _O_BINARY) == -1) {
            throw std::runtime_error("Cannot enable binary stdout");
        }
        Check(CoInitializeEx(nullptr, COINIT_MULTITHREADED), "CoInitializeEx");
        ComPtr<IMMDeviceEnumerator> enumerator;
        Check(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                               IID_PPV_ARGS(&enumerator)), "Create audio enumerator");
        ComPtr<IMMDevice> device;
        Check(enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device),
              "Get default playback device");
        ComPtr<IAudioClient> client;
        Check(device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                               reinterpret_cast<void**>(client.GetAddressOf())),
              "Activate audio client");

        WAVEFORMATEX format{};
        format.wFormatTag = WAVE_FORMAT_PCM;
        format.nChannels = 2;
        format.nSamplesPerSec = 48000;
        format.wBitsPerSample = 16;
        format.nBlockAlign = 4;
        format.nAvgBytesPerSec = 48000 * 4;
        const DWORD flags = AUDCLNT_STREAMFLAGS_LOOPBACK |
                            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                            AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
        Check(client->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 1000000, 0,
                                 &format, nullptr), "Initialize 48 kHz loopback");
        ComPtr<IAudioCaptureClient> capture;
        Check(client->GetService(IID_PPV_ARGS(&capture)), "Get audio capture service");
        Check(client->Start(), "Start audio capture");

        std::vector<char> silence;
        for (;;) {
            UINT32 available = 0;
            Check(capture->GetNextPacketSize(&available), "GetNextPacketSize");
            if (available == 0) {
                Sleep(5);
                continue;
            }
            BYTE* bytes = nullptr;
            UINT32 frames = 0;
            DWORD bufferFlags = 0;
            Check(capture->GetBuffer(&bytes, &frames, &bufferFlags, nullptr, nullptr),
                  "GetBuffer");
            const size_t length = static_cast<size_t>(frames) * format.nBlockAlign;
            if (bufferFlags & AUDCLNT_BUFFERFLAGS_SILENT) {
                silence.assign(length, 0);
                std::cout.write(silence.data(), static_cast<std::streamsize>(length));
            } else {
                std::cout.write(reinterpret_cast<const char*>(bytes),
                                static_cast<std::streamsize>(length));
            }
            Check(capture->ReleaseBuffer(frames), "ReleaseBuffer");
            std::cout.flush();
            if (!std::cout) break;
        }
        client->Stop();
        CoUninitialize();
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}
