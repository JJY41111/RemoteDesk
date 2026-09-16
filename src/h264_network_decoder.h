#pragma once

#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

namespace remotedesk {

struct NetworkDecodeStatistics {
    std::uint64_t inputPackets{};
    std::uint64_t decodedFrames{};
    bool decodedFrameContainsImage{};
    bool lowLatencyEnabled{};
    double averageDecodeMilliseconds{};
};

class H264NetworkDecoder {
public:
    using FrameCallback =
        std::function<void(std::vector<std::uint8_t>&&, unsigned, unsigned,
                           std::uint64_t)>;

    H264NetworkDecoder();
    H264NetworkDecoder(const H264NetworkDecoder&) = delete;
    H264NetworkDecoder& operator=(const H264NetworkDecoder&) = delete;
    ~H264NetworkDecoder();

    void Start(unsigned width, unsigned height, unsigned framesPerSecond,
               FrameCallback onFrame);
    void DecodePacket(const std::vector<std::uint8_t>& bytes,
                      std::uint64_t sampleTime,
                      std::uint64_t sampleDuration);
    NetworkDecodeStatistics Stop();

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace remotedesk
