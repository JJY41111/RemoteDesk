#pragma once

#include <d3d11.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <chrono>
#include <cstdint>

namespace remotedesk {

class H264Recorder {
public:
    H264Recorder() = default;
    H264Recorder(const H264Recorder&) = delete;
    H264Recorder& operator=(const H264Recorder&) = delete;
    ~H264Recorder();

    void Start(const wchar_t* outputPath, ID3D11Device* device,
               ID3D11DeviceContext* context, UINT width, UINT height,
               UINT framesPerSecond = 30, UINT bitrate = 8'000'000);
    bool WriteFrameIfDue(ID3D11Texture2D* sourceTexture);
    void Stop();

    [[nodiscard]] bool IsRecording() const noexcept { return recording_; }
    [[nodiscard]] std::uint64_t EncodedFrames() const noexcept {
        return encodedFrames_;
    }

private:
    using Clock = std::chrono::steady_clock;

    Microsoft::WRL::ComPtr<IMFSinkWriter> writer_;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> stagingTexture_;

    DWORD streamIndex_{};
    UINT width_{};
    UINT height_{};
    UINT framesPerSecond_{};
    LONGLONG nextSampleTime_{};
    LONGLONG sampleDuration_{};
    Clock::time_point nextFrameDue_{};
    std::uint64_t encodedFrames_{};
    bool mediaFoundationStarted_{};
    bool recording_{};
};

} // namespace remotedesk
