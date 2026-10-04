#pragma once

#include <d3d11.h>
#include <wrl/client.h>

#include <chrono>
#include <array>
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
    std::uint64_t gpuQueueSkips{};
    std::uint64_t gpuStaleFrames{};
    double gpuReadbackAgeMilliseconds{};
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
               UINT bitrate = 4'000'000, bool decodeLocally = true,
               bool preferGpuConversion = true, bool recoveryKeyframes = false,
               bool boundedBitrate = false, bool adaptiveRecovery = false);
    bool ProcessFrameIfDue(ID3D11Texture2D* sourceTexture,
                           std::uint64_t sourceEventQpc = 0,
                           std::uint64_t captureReadyQpc = 0);
    bool SetTargetBitrate(UINT bitrate);
    void RequestRecoveryKeyframe() { nextRecoveryKeyframe_ = Clock::now(); }
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
    [[nodiscard]] bool UsesGpuConversion() const noexcept { return gpuConversion_; }
    [[nodiscard]] bool DecodesLocally() const noexcept { return decodeLocally_; }
    [[nodiscard]] UINT MillisecondsUntilNextFrame() const noexcept;

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

    struct GpuReadback {
        Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
        bool pending{};
        std::uint64_t sequence{};
        LONGLONG sampleTime{};
        SourceTimestamps source;
        Clock::time_point queuedAt{};
    };

    void ConvertLatestFrameToNv12();
    bool TryInitializeGpuConversion(ID3D11Device* device,
                                    ID3D11DeviceContext* context);
    bool ConvertOnGpu(ID3D11Texture2D* sourceTexture);
    bool QueueGpuConversion(ID3D11Texture2D* sourceTexture,
                            ID3D11Texture2D* destination);
    bool ProcessGpuFrame(ID3D11Texture2D* sourceTexture,
                         SourceTimestamps source, Clock::time_point now);
    bool ReadLatestGpuFrame();
    void CopyMappedNv12(const D3D11_MAPPED_SUBRESOURCE& mapped);
    void SubmitNv12Frame();
    void DrainEncoder();
    void DecodeQueuedPackets();
    void DrainDecoder();
    void UpdateAverages();

    Microsoft::WRL::ComPtr<ID3D11DeviceContext> context_;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> stagingTexture_;
    Microsoft::WRL::ComPtr<ID3D11VideoDevice> videoDevice_;
    Microsoft::WRL::ComPtr<ID3D11VideoContext> videoContext_;
    Microsoft::WRL::ComPtr<ID3D11VideoProcessorEnumerator> videoEnumerator_;
    Microsoft::WRL::ComPtr<ID3D11VideoProcessor> videoProcessor_;
    Microsoft::WRL::ComPtr<ID3D11VideoProcessorInputView> videoInputView_;
    Microsoft::WRL::ComPtr<ID3D11VideoProcessorOutputView> videoOutputView_;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> gpuNv12Texture_;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> gpuNv12Staging_;
    std::array<GpuReadback, 3> gpuReadbacks_;
    std::uint64_t gpuSequence_{};
    std::uint64_t gpuDeliveredSequence_{};
    Microsoft::WRL::ComPtr<ID3D11Texture2D> videoInputTexture_;
    Microsoft::WRL::ComPtr<IMFTransform> encoder_;
    Microsoft::WRL::ComPtr<IMFTransform> decoder_;

    std::deque<EncodedPacket> encodedQueue_;
    std::map<LONGLONG, SourceTimestamps> sourceTimestampsBySample_;
    std::function<void(const std::vector<std::uint8_t>&, LONGLONG, LONGLONG,
                       std::uint64_t, std::uint64_t)>
        packetCallback_;
    std::vector<std::uint8_t> nv12Frame_;
    std::vector<UINT> sourceXOffsets_;
    std::vector<UINT> sourceYIndexes_;

    UINT sourceWidth_{};
    UINT sourceHeight_{};
    UINT outputWidth_{};
    UINT outputHeight_{};
    UINT framesPerSecond_{};
    LONGLONG nextSampleTime_{};
    LONGLONG sampleDuration_{};
    Clock::time_point nextFrameDue_{};
    Clock::time_point streamStartedAt_{};
    Clock::time_point nextRecoveryKeyframe_{};
    bool recoveryKeyframes_{};
    bool adaptiveRecovery_{};

    LoopbackStatistics statistics_{};
    double totalConversionMilliseconds_{};
    double totalEncodeMilliseconds_{};
    double totalQueueMilliseconds_{};
    double totalDecodeMilliseconds_{};
    bool mediaFoundationStarted_{};
    bool running_{};
    bool decodeLocally_{true};
    bool gpuConversion_{};
};

} // namespace remotedesk
