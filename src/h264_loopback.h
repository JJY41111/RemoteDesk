#pragma once

#include <d3d11.h>
#include <wrl/client.h>

#include <chrono>
#include <cstdint>
#include <deque>
#include <vector>

struct IMFTransform;

namespace remotedesk {

struct LoopbackStatistics {
    std::uint64_t submittedFrames{};
    std::uint64_t encodedFrames{};
    std::uint64_t decodedFrames{};
    std::uint64_t encodedBytes{};
    double averageConversionMilliseconds{};
    double averageEncodeMilliseconds{};
    double averageQueueMilliseconds{};
    double averageDecodeMilliseconds{};
    bool decodedFrameContainsImage{};
};

class H264Loopback {
public:
    H264Loopback() = default;
    H264Loopback(const H264Loopback&) = delete;
    H264Loopback& operator=(const H264Loopback&) = delete;
    ~H264Loopback();

    void Start(ID3D11Device* device, ID3D11DeviceContext* context,
               UINT sourceWidth, UINT sourceHeight, UINT outputWidth = 1280,
               UINT outputHeight = 720, UINT framesPerSecond = 30,
               UINT bitrate = 4'000'000);
    bool ProcessFrameIfDue(ID3D11Texture2D* sourceTexture);
    void Stop();

    [[nodiscard]] bool IsRunning() const noexcept { return running_; }
    [[nodiscard]] const LoopbackStatistics& Statistics() const noexcept {
        return statistics_;
    }
    [[nodiscard]] UINT OutputWidth() const noexcept { return outputWidth_; }
    [[nodiscard]] UINT OutputHeight() const noexcept { return outputHeight_; }

private:
    using Clock = std::chrono::steady_clock;

    struct EncodedPacket {
        std::vector<std::uint8_t> bytes;
        LONGLONG sampleTime{};
        LONGLONG sampleDuration{};
        Clock::time_point queuedAt{};
    };

    void ConvertLatestFrameToNv12();
    void SubmitNv12Frame();
    void DrainEncoder();
    void DecodeQueuedPackets();
    void DrainDecoder();
    void UpdateAverages();

    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> stagingTexture_;
    Microsoft::WRL::ComPtr<IMFTransform> encoder_;
    Microsoft::WRL::ComPtr<IMFTransform> decoder_;

    std::deque<EncodedPacket> encodedQueue_;
    std::vector<std::uint8_t> nv12Frame_;

    UINT sourceWidth_{};
    UINT sourceHeight_{};
    UINT outputWidth_{};
    UINT outputHeight_{};
    UINT framesPerSecond_{};
    LONGLONG nextSampleTime_{};
    LONGLONG sampleDuration_{};
    Clock::time_point nextFrameDue_{};

    LoopbackStatistics statistics_{};
    double totalConversionMilliseconds_{};
    double totalEncodeMilliseconds_{};
    double totalQueueMilliseconds_{};
    double totalDecodeMilliseconds_{};
    bool mediaFoundationStarted_{};
    bool running_{};
};

} // namespace remotedesk
