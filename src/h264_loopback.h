#pragma once

#include <d3d11.h>
#include <wrl/client.h>

#include <chrono>
#include <cstdint>
#include <deque>
#include <functional>
#include <map>
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
               UINT bitrate = 4'000'000, bool decodeLocally = true);
    bool ProcessFrameIfDue(ID3D11Texture2D* sourceTexture,
                           std::uint64_t sourceEventQpc = 0,
                           std::uint64_t captureReadyQpc = 0);
    void Stop(bool emitFinalPackets = true);
    void SetPacketCallback(std::function<void(
        const std::vector<std::uint8_t>&, LONGLONG, LONGLONG,
        std::uint64_t, std::uint64_t)> callback);

    [[nodiscard]] bool IsRunning() const noexcept { return running_; }
    [[nodiscard]] const LoopbackStatistics& Statistics() const noexcept {
        return statistics_;
    }
    [[nodiscard]] UINT OutputWidth() const noexcept { return outputWidth_; }
    [[nodiscard]] UINT OutputHeight() const noexcept { return outputHeight_; }
    [[nodiscard]] bool DecodesLocally() const noexcept { return decodeLocally_; }

private:
    using Clock = std::chrono::steady_clock;

    struct EncodedPacket {
        std::vector<std::uint8_t> bytes;
        LONGLONG sampleTime{};
        LONGLONG sampleDuration{};
        Clock::time_point queuedAt{};
    };

    struct SourceTimestamps {
        std::uint64_t sourceEventQpc{};
        std::uint64_t captureReadyQpc{};
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
    std::map<LONGLONG, SourceTimestamps> sourceTimestampsBySample_;
    std::function<void(const std::vector<std::uint8_t>&, LONGLONG, LONGLONG,
                       std::uint64_t, std::uint64_t)>
        packetCallback_;
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
    bool decodeLocally_{true};
};

} // namespace remotedesk
