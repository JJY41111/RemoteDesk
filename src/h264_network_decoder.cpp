#include "h264_network_decoder.h"

#include <windows.h>
#include <codecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <wmcodecdsp.h>
#include <wrl/client.h>

#include <algorithm>
#include <chrono>
#include <cstring>
#include <sstream>
#include <stdexcept>
#include <utility>

using Microsoft::WRL::ComPtr;

namespace remotedesk {
namespace {

void Check(HRESULT result, const char* operation) {
    if (FAILED(result)) {
        std::ostringstream error;
        error << operation << " failed (HRESULT 0x" << std::hex
              << static_cast<unsigned long>(result) << ')';
        throw std::runtime_error(error.str());
    }
}

ComPtr<IMFMediaType> VideoType(const GUID& subtype, unsigned width,
                               unsigned height, unsigned framesPerSecond) {
    ComPtr<IMFMediaType> type;
    Check(MFCreateMediaType(&type), "Create decoder media type");
    Check(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video),
          "Set decoder video type");
    Check(type->SetGUID(MF_MT_SUBTYPE, subtype), "Set decoder subtype");
    Check(MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, width, height),
          "Set decoder frame size");
    Check(MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, framesPerSecond, 1),
          "Set decoder frame rate");
    Check(MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1),
          "Set decoder aspect ratio");
    Check(type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive),
          "Set decoder progressive mode");
    return type;
}

ComPtr<IMFSample> InputSample(const std::vector<std::uint8_t>& bytes,
                              std::uint64_t sampleTime,
                              std::uint64_t sampleDuration) {
    ComPtr<IMFMediaBuffer> buffer;
    Check(MFCreateMemoryBuffer(static_cast<DWORD>(bytes.size()), &buffer),
          "Create received H.264 buffer");
    BYTE* destination = nullptr;
    Check(buffer->Lock(&destination, nullptr, nullptr), "Lock H.264 buffer");
    std::memcpy(destination, bytes.data(), bytes.size());
    buffer->Unlock();
    Check(buffer->SetCurrentLength(static_cast<DWORD>(bytes.size())),
          "Set H.264 buffer length");

    ComPtr<IMFSample> sample;
    Check(MFCreateSample(&sample), "Create received H.264 sample");
    Check(sample->AddBuffer(buffer.Get()), "Attach received H.264 buffer");
    Check(sample->SetSampleTime(static_cast<LONGLONG>(sampleTime)),
          "Set received H.264 time");
    Check(sample->SetSampleDuration(static_cast<LONGLONG>(sampleDuration)),
          "Set received H.264 duration");
    return sample;
}

std::uint8_t ClampByte(int value) {
    return static_cast<std::uint8_t>(std::clamp(value, 0, 255));
}

std::vector<std::uint8_t> Nv12ToBgra(const BYTE* nv12, unsigned width,
                                      unsigned height) {
    std::vector<std::uint8_t> bgra(static_cast<std::size_t>(width) * height * 4);
    const BYTE* uv = nv12 + static_cast<std::size_t>(width) * height;
    for (unsigned y = 0; y < height; ++y) {
        for (unsigned x = 0; x < width; ++x) {
            const int luminance = nv12[static_cast<std::size_t>(y) * width + x];
            const std::size_t uvIndex =
                static_cast<std::size_t>(y / 2) * width + (x & ~1u);
            const int c = std::max(luminance - 16, 0);
            const int d = uv[uvIndex] - 128;
            const int e = uv[uvIndex + 1] - 128;
            const std::size_t output =
                (static_cast<std::size_t>(y) * width + x) * 4;
            bgra[output] = ClampByte((298 * c + 516 * d + 128) >> 8);
            bgra[output + 1] =
                ClampByte((298 * c - 100 * d - 208 * e + 128) >> 8);
            bgra[output + 2] = ClampByte((298 * c + 409 * e + 128) >> 8);
            bgra[output + 3] = 255;
        }
    }
    return bgra;
}

} // namespace

struct H264NetworkDecoder::Impl {
    ComPtr<IMFTransform> decoder;
    ComPtr<IMFMediaType> outputType;
    FrameCallback onFrame;
    NetworkDecodeStatistics statistics;
    unsigned width{};
    unsigned height{};
    double totalDecodeMilliseconds{};
    bool mediaFoundationStarted{};

    void Drain() {
        MFT_OUTPUT_STREAM_INFO streamInfo{};
        Check(decoder->GetOutputStreamInfo(0, &streamInfo),
              "Get network decoder output info");
        const DWORD decodedBytes = width * height * 3 / 2;
        for (;;) {
            ComPtr<IMFSample> callerSample;
            if ((streamInfo.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES) == 0 &&
                (streamInfo.dwFlags & MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES) ==
                    0) {
                ComPtr<IMFMediaBuffer> buffer;
                const DWORD size = std::max(streamInfo.cbSize, decodedBytes);
                const DWORD alignment = streamInfo.cbAlignment > 0
                                            ? streamInfo.cbAlignment - 1
                                            : 0;
                Check(MFCreateAlignedMemoryBuffer(size, alignment, &buffer),
                      "Create network decoder output buffer");
                Check(MFCreateSample(&callerSample),
                      "Create network decoder output sample");
                Check(callerSample->AddBuffer(buffer.Get()),
                      "Attach network decoder output buffer");
            }

            MFT_OUTPUT_DATA_BUFFER output{};
            output.dwStreamID = 0;
            output.pSample = callerSample.Get();
            DWORD status = 0;
            const HRESULT result =
                decoder->ProcessOutput(0, 1, &output, &status);
            if (output.pEvents != nullptr) {
                output.pEvents->Release();
            }
            if (result == MF_E_TRANSFORM_NEED_MORE_INPUT) {
                break;
            }
            if (result == MF_E_TRANSFORM_STREAM_CHANGE) {
                Check(decoder->SetOutputType(0, outputType.Get(), 0),
                      "Restore NV12 decoder output type");
                Check(decoder->GetOutputStreamInfo(0, &streamInfo),
                      "Refresh decoder output info");
                continue;
            }
            Check(result, "Get network H.264 decoder output");

            ComPtr<IMFSample> produced;
            if (output.pSample == callerSample.Get()) {
                produced = callerSample;
            } else if (output.pSample != nullptr) {
                produced.Attach(output.pSample);
            }
            if (!produced) {
                throw std::runtime_error("Decoder returned no output sample");
            }
            ComPtr<IMFMediaBuffer> contiguous;
            Check(produced->ConvertToContiguousBuffer(&contiguous),
                  "Get contiguous decoded frame");
            BYTE* data = nullptr;
            DWORD length = 0;
            Check(contiguous->Lock(&data, nullptr, &length),
                  "Lock decoded frame");
            if (length < decodedBytes) {
                contiguous->Unlock();
                throw std::runtime_error("Decoder returned a short NV12 frame");
            }
            const bool containsImage = std::any_of(
                data, data + width * height,
                [](BYTE value) { return value > 16; });
            auto bgra = Nv12ToBgra(data, width, height);
            contiguous->Unlock();
            statistics.decodedFrameContainsImage |= containsImage;
            ++statistics.decodedFrames;
            LONGLONG sampleTime = -1;
            produced->GetSampleTime(&sampleTime);
            onFrame(std::move(bgra), width, height,
                    static_cast<std::uint64_t>(sampleTime));
        }
    }
};

H264NetworkDecoder::H264NetworkDecoder() = default;

H264NetworkDecoder::~H264NetworkDecoder() {
    if (impl_) {
        try {
            Stop();
        } catch (...) {
        }
    }
}

void H264NetworkDecoder::Start(unsigned width, unsigned height,
                               unsigned framesPerSecond,
                               FrameCallback onFrame) {
    if (impl_ || width == 0 || height == 0 || width % 2 != 0 ||
        height % 2 != 0 || framesPerSecond == 0 || !onFrame) {
        throw std::invalid_argument("Invalid network decoder configuration");
    }
    auto state = std::make_unique<Impl>();
    state->width = width;
    state->height = height;
    state->onFrame = std::move(onFrame);
    Check(MFStartup(MF_VERSION), "Start network Media Foundation");
    state->mediaFoundationStarted = true;
    try {
        Check(CoCreateInstance(CLSID_CMSH264DecoderMFT, nullptr,
                               CLSCTX_INPROC_SERVER,
                               IID_PPV_ARGS(&state->decoder)),
              "Create network H.264 decoder");
        ComPtr<ICodecAPI> codecApi;
        if (SUCCEEDED(state->decoder.As(&codecApi))) {
            VARIANT setting;
            VariantInit(&setting);
            setting.vt = VT_UI4;
            setting.ulVal = 1;
            state->statistics.lowLatencyEnabled = SUCCEEDED(
                codecApi->SetValue(&CODECAPI_AVLowLatencyMode, &setting));
            VariantClear(&setting);
        }
        auto inputType =
            VideoType(MFVideoFormat_H264_ES, width, height, framesPerSecond);
        state->outputType =
            VideoType(MFVideoFormat_NV12, width, height, framesPerSecond);
        Check(state->outputType->SetUINT32(MF_MT_DEFAULT_STRIDE, width),
              "Set network NV12 stride");
        Check(state->outputType->SetUINT32(
                  MF_MT_SAMPLE_SIZE, width * height * 3 / 2),
              "Set network NV12 size");
        Check(state->decoder->SetInputType(0, inputType.Get(), 0),
              "Set network decoder H.264 input");
        Check(state->decoder->SetOutputType(0, state->outputType.Get(), 0),
              "Set network decoder NV12 output");
        Check(state->decoder->ProcessMessage(
                  MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0),
              "Begin network decoder streaming");
        Check(state->decoder->ProcessMessage(
                  MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0),
              "Start network decoder stream");
    } catch (...) {
        MFShutdown();
        throw;
    }
    impl_ = std::move(state);
}

void H264NetworkDecoder::DecodePacket(
    const std::vector<std::uint8_t>& bytes, std::uint64_t sampleTime,
    std::uint64_t sampleDuration) {
    if (!impl_ || bytes.empty()) {
        throw std::runtime_error("Invalid received H.264 packet");
    }
    const auto started = std::chrono::steady_clock::now();
    auto sample = InputSample(bytes, sampleTime, sampleDuration);
    HRESULT result = impl_->decoder->ProcessInput(0, sample.Get(), 0);
    if (result == MF_E_NOTACCEPTING) {
        impl_->Drain();
        result = impl_->decoder->ProcessInput(0, sample.Get(), 0);
    }
    Check(result, "Submit received H.264 packet");
    ++impl_->statistics.inputPackets;
    impl_->Drain();
    impl_->totalDecodeMilliseconds +=
        std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - started)
            .count();
}

NetworkDecodeStatistics H264NetworkDecoder::Stop() {
    if (!impl_) {
        return {};
    }
    Check(impl_->decoder->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0),
          "Drain network decoder");
    impl_->Drain();
    impl_->decoder->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
    const double count = static_cast<double>(
        std::max<std::uint64_t>(impl_->statistics.inputPackets, 1));
    impl_->statistics.averageDecodeMilliseconds =
        impl_->totalDecodeMilliseconds / count;
    const NetworkDecodeStatistics statistics = impl_->statistics;
    impl_->decoder.Reset();
    Check(MFShutdown(), "Stop network Media Foundation");
    impl_.reset();
    return statistics;
}

} // namespace remotedesk
