#include "h264_loopback.h"

#include <codecapi.h>
#include <mfapi.h>
#include <mferror.h>
#include <mfidl.h>
#include <mftransform.h>
#include <wmcodecdsp.h>

#include <algorithm>
#include <cstring>
#include <sstream>
#include <stdexcept>
#include <utility>

using Microsoft::WRL::ComPtr;

namespace remotedesk {
namespace {

struct SampleBytes {
    std::vector<std::uint8_t> bytes;
    LONGLONG sampleTime{};
    LONGLONG sampleDuration{};
};

std::runtime_error TransformError(const char* operation, HRESULT result) {
    std::ostringstream message;
    message << operation << " failed (HRESULT 0x" << std::hex
            << static_cast<unsigned long>(result) << ')';
    return std::runtime_error(message.str());
}

void Check(HRESULT result, const char* operation) {
    if (FAILED(result)) {
        throw TransformError(operation, result);
    }
}

std::uint8_t ClampByte(int value) {
    return static_cast<std::uint8_t>(std::clamp(value, 0, 255));
}

ComPtr<IMFMediaType> CreateVideoType(const GUID& subtype, UINT width,
                                     UINT height, UINT framesPerSecond) {
    ComPtr<IMFMediaType> type;
    Check(MFCreateMediaType(&type), "MFCreateMediaType");
    Check(type->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video),
          "Set video major type");
    Check(type->SetGUID(MF_MT_SUBTYPE, subtype), "Set video subtype");
    Check(MFSetAttributeSize(type.Get(), MF_MT_FRAME_SIZE, width, height),
          "Set video frame size");
    Check(MFSetAttributeRatio(type.Get(), MF_MT_FRAME_RATE, framesPerSecond, 1),
          "Set video frame rate");
    Check(MFSetAttributeRatio(type.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1, 1),
          "Set pixel aspect ratio");
    Check(type->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive),
          "Set progressive video");
    return type;
}

ComPtr<IMFSample> CreateInputSample(const std::vector<std::uint8_t>& bytes,
                                    LONGLONG sampleTime,
                                    LONGLONG sampleDuration) {
    ComPtr<IMFMediaBuffer> buffer;
    Check(MFCreateMemoryBuffer(static_cast<DWORD>(bytes.size()), &buffer),
          "Create transform input buffer");

    BYTE* destination = nullptr;
    Check(buffer->Lock(&destination, nullptr, nullptr),
          "Lock transform input buffer");
    std::memcpy(destination, bytes.data(), bytes.size());
    buffer->Unlock();
    Check(buffer->SetCurrentLength(static_cast<DWORD>(bytes.size())),
          "Set transform input length");

    ComPtr<IMFSample> sample;
    Check(MFCreateSample(&sample), "Create transform input sample");
    Check(sample->AddBuffer(buffer.Get()), "Attach transform input buffer");
    Check(sample->SetSampleTime(sampleTime), "Set transform sample time");
    Check(sample->SetSampleDuration(sampleDuration),
          "Set transform sample duration");
    return sample;
}

ComPtr<IMFSample> CreateOutputSample(const MFT_OUTPUT_STREAM_INFO& streamInfo,
                                     DWORD minimumSize) {
    if ((streamInfo.dwFlags & MFT_OUTPUT_STREAM_PROVIDES_SAMPLES) != 0 ||
        (streamInfo.dwFlags & MFT_OUTPUT_STREAM_CAN_PROVIDE_SAMPLES) != 0) {
        return nullptr;
    }

    const DWORD bufferSize = std::max(streamInfo.cbSize, minimumSize);
    const DWORD alignmentMask =
        streamInfo.cbAlignment > 0 ? streamInfo.cbAlignment - 1 : 0;

    ComPtr<IMFMediaBuffer> buffer;
    Check(MFCreateAlignedMemoryBuffer(bufferSize, alignmentMask, &buffer),
          "Create transform output buffer");

    ComPtr<IMFSample> sample;
    Check(MFCreateSample(&sample), "Create transform output sample");
    Check(sample->AddBuffer(buffer.Get()), "Attach transform output buffer");
    return sample;
}

std::vector<SampleBytes> DrainTransform(IMFTransform* transform,
                                        DWORD minimumOutputSize,
                                        const char* operation) {
    MFT_OUTPUT_STREAM_INFO streamInfo{};
    Check(transform->GetOutputStreamInfo(0, &streamInfo),
          "Get transform output stream info");

    std::vector<SampleBytes> outputs;
    for (;;) {
        ComPtr<IMFSample> callerSample =
            CreateOutputSample(streamInfo, minimumOutputSize);

        MFT_OUTPUT_DATA_BUFFER output{};
        output.dwStreamID = 0;
        output.pSample = callerSample.Get();
        DWORD status = 0;
        const HRESULT result = transform->ProcessOutput(0, 1, &output, &status);

        if (output.pEvents != nullptr) {
            output.pEvents->Release();
        }
        if (result == MF_E_TRANSFORM_NEED_MORE_INPUT) {
            break;
        }
        if (result == MF_E_TRANSFORM_STREAM_CHANGE) {
            throw std::runtime_error(
                "Media Foundation transform requested an unexpected format "
                "change");
        }
        Check(result, operation);

        ComPtr<IMFSample> producedSample;
        if (output.pSample == callerSample.Get()) {
            producedSample = callerSample;
        } else if (output.pSample != nullptr) {
            producedSample.Attach(output.pSample);
        }
        if (!producedSample) {
            throw std::runtime_error(
                "Media Foundation transform returned no output sample");
        }

        ComPtr<IMFMediaBuffer> contiguousBuffer;
        Check(producedSample->ConvertToContiguousBuffer(&contiguousBuffer),
              "Get contiguous transform output");
        BYTE* source = nullptr;
        DWORD currentLength = 0;
        Check(contiguousBuffer->Lock(&source, nullptr, &currentLength),
              "Lock transform output");

        SampleBytes bytes;
        bytes.bytes.assign(source, source + currentLength);
        contiguousBuffer->Unlock();
        producedSample->GetSampleTime(&bytes.sampleTime);
        producedSample->GetSampleDuration(&bytes.sampleDuration);
        outputs.push_back(std::move(bytes));
    }
    return outputs;
}

void StartTransform(IMFTransform* transform) {
    Check(transform->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0),
          "Begin transform streaming");
    Check(transform->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0),
          "Start transform stream");
}

void SetOptionalBooleanCodecProperty(IMFTransform* transform,
                                     const GUID& property, bool value) {
    ComPtr<ICodecAPI> codecApi;
    if (FAILED(transform->QueryInterface(IID_PPV_ARGS(&codecApi)))) {
        return;
    }

    VARIANT setting;
    VariantInit(&setting);
    setting.vt = VT_BOOL;
    setting.boolVal = value ? VARIANT_TRUE : VARIANT_FALSE;
    codecApi->SetValue(&property, &setting);
    VariantClear(&setting);
}

void SetOptionalDecoderLowLatency(IMFTransform* transform) {
    ComPtr<ICodecAPI> codecApi;
    if (FAILED(transform->QueryInterface(IID_PPV_ARGS(&codecApi)))) {
        return;
    }
    VARIANT setting;
    VariantInit(&setting);
    setting.vt = VT_UI4;
    setting.ulVal = 1;
    codecApi->SetValue(&CODECAPI_AVLowLatencyMode, &setting);
    VariantClear(&setting);
}

} // namespace

H264Loopback::~H264Loopback() {
    encoder_.Reset();
    decoder_.Reset();
    stagingTexture_.Reset();
    context_.Reset();
    if (mediaFoundationStarted_) {
        MFShutdown();
    }
}

void H264Loopback::SetPacketCallback(std::function<void(
    const std::vector<std::uint8_t>&, LONGLONG, LONGLONG,
    std::uint64_t, std::uint64_t)> callback) {
    if (running_) {
        throw std::runtime_error("Cannot change H.264 packet callback while running");
    }
    packetCallback_ = std::move(callback);
}

void H264Loopback::Start(ID3D11Device* device, ID3D11DeviceContext* context,
                         UINT sourceWidth, UINT sourceHeight, UINT outputWidth,
                         UINT outputHeight, UINT framesPerSecond, UINT bitrate,
                         bool decodeLocally) {
    if (running_) {
        throw std::runtime_error("H.264 loopback is already active");
    }
    if (device == nullptr || context == nullptr || sourceWidth == 0 ||
        sourceHeight == 0 || outputWidth == 0 || outputHeight == 0 ||
        framesPerSecond == 0 || (outputWidth % 2) != 0 ||
        (outputHeight % 2) != 0) {
        throw std::invalid_argument("Invalid H.264 loopback configuration");
    }

    Check(MFStartup(MF_VERSION), "MFStartup for H.264 loopback");
    mediaFoundationStarted_ = true;

    try {
        Check(CoCreateInstance(CLSID_CMSH264EncoderMFT, nullptr,
                               CLSCTX_INPROC_SERVER,
                               IID_PPV_ARGS(&encoder_)),
              "Create Microsoft H.264 encoder MFT");
        if (decodeLocally) {
            Check(CoCreateInstance(CLSID_CMSH264DecoderMFT, nullptr,
                                   CLSCTX_INPROC_SERVER,
                                   IID_PPV_ARGS(&decoder_)),
                  "Create Microsoft H.264 decoder MFT");
        }

        SetOptionalBooleanCodecProperty(encoder_.Get(), CODECAPI_AVLowLatencyMode,
                                        true);
        if (decodeLocally) {
            SetOptionalDecoderLowLatency(decoder_.Get());
        }

        auto encodedType = CreateVideoType(MFVideoFormat_H264, outputWidth,
                                           outputHeight, framesPerSecond);
        Check(encodedType->SetUINT32(MF_MT_AVG_BITRATE, bitrate),
              "Set loopback H.264 bitrate");
        Check(encodedType->SetUINT32(MF_MT_MPEG2_PROFILE,
                                     eAVEncH264VProfile_Main),
              "Set loopback H.264 profile");
        Check(encoder_->SetOutputType(0, encodedType.Get(), 0),
              "Set H.264 encoder output type");

        auto nv12Type = CreateVideoType(MFVideoFormat_NV12, outputWidth,
                                        outputHeight, framesPerSecond);
        Check(nv12Type->SetUINT32(MF_MT_DEFAULT_STRIDE, outputWidth),
              "Set NV12 stride");
        Check(nv12Type->SetUINT32(MF_MT_SAMPLE_SIZE,
                                  outputWidth * outputHeight * 3 / 2),
              "Set NV12 sample size");
        Check(encoder_->SetInputType(0, nv12Type.Get(), 0),
              "Set H.264 encoder input type");

        if (decodeLocally) {
            auto decoderInput = CreateVideoType(MFVideoFormat_H264_ES,
                                                outputWidth, outputHeight,
                                                framesPerSecond);
            Check(decoder_->SetInputType(0, decoderInput.Get(), 0),
                  "Set H.264 decoder input type");
            Check(decoder_->SetOutputType(0, nv12Type.Get(), 0),
                  "Set H.264 decoder output type");
        }

        StartTransform(encoder_.Get());
        if (decodeLocally) {
            StartTransform(decoder_.Get());
        }

        D3D11_TEXTURE2D_DESC stagingDescription{};
        stagingDescription.Width = sourceWidth;
        stagingDescription.Height = sourceHeight;
        stagingDescription.MipLevels = 1;
        stagingDescription.ArraySize = 1;
        stagingDescription.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        stagingDescription.SampleDesc.Count = 1;
        stagingDescription.Usage = D3D11_USAGE_STAGING;
        stagingDescription.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        Check(device->CreateTexture2D(&stagingDescription, nullptr,
                                      &stagingTexture_),
              "Create loopback staging texture");

        context_ = context;
        sourceWidth_ = sourceWidth;
        sourceHeight_ = sourceHeight;
        outputWidth_ = outputWidth;
        outputHeight_ = outputHeight;
        framesPerSecond_ = framesPerSecond;
        sampleDuration_ = 10'000'000LL / framesPerSecond;
        nextSampleTime_ = 0;
        nextFrameDue_ = Clock::now();
        nv12Frame_.resize(outputWidth_ * outputHeight_ * 3 / 2);
        encodedQueue_.clear();
        sourceTimestampsBySample_.clear();
        statistics_ = {};
        totalConversionMilliseconds_ = 0.0;
        totalEncodeMilliseconds_ = 0.0;
        totalQueueMilliseconds_ = 0.0;
        totalDecodeMilliseconds_ = 0.0;
        decodeLocally_ = decodeLocally;
        running_ = true;
    } catch (...) {
        encoder_.Reset();
        decoder_.Reset();
        stagingTexture_.Reset();
        context_.Reset();
        MFShutdown();
        mediaFoundationStarted_ = false;
        throw;
    }
}

bool H264Loopback::ProcessFrameIfDue(ID3D11Texture2D* sourceTexture,
                                     std::uint64_t sourceEventQpc,
                                     std::uint64_t captureReadyQpc) {
    if (!running_ || sourceTexture == nullptr) {
        return false;
    }

    const auto now = Clock::now();
    if (now < nextFrameDue_) {
        return false;
    }

    context_->CopyResource(stagingTexture_.Get(), sourceTexture);
    ConvertLatestFrameToNv12();
    if (packetCallback_) {
        sourceTimestampsBySample_[nextSampleTime_] = {
            sourceEventQpc, captureReadyQpc};
        while (sourceTimestampsBySample_.size() > 128) {
            sourceTimestampsBySample_.erase(sourceTimestampsBySample_.begin());
        }
    }
    SubmitNv12Frame();
    if (decodeLocally_) {
        DecodeQueuedPackets();
    }

    ++statistics_.submittedFrames;
    nextSampleTime_ += sampleDuration_;
    const auto interval =
        std::chrono::nanoseconds(1'000'000'000LL / framesPerSecond_);
    nextFrameDue_ += interval;
    if (nextFrameDue_ + interval < now) {
        nextFrameDue_ = now + interval;
    }
    UpdateAverages();
    return true;
}

void H264Loopback::ConvertLatestFrameToNv12() {
    const auto conversionStart = Clock::now();
    D3D11_MAPPED_SUBRESOURCE mapped{};
    Check(context_->Map(stagingTexture_.Get(), 0, D3D11_MAP_READ, 0, &mapped),
          "Map loopback staging texture");

    const auto* source = static_cast<const std::uint8_t*>(mapped.pData);
    auto* yPlane = nv12Frame_.data();
    auto* uvPlane = yPlane + outputWidth_ * outputHeight_;

    for (UINT y = 0; y < outputHeight_; ++y) {
        const UINT sourceY = y * sourceHeight_ / outputHeight_;
        const auto* sourceRow = source + sourceY * mapped.RowPitch;
        for (UINT x = 0; x < outputWidth_; ++x) {
            const UINT sourceX = x * sourceWidth_ / outputWidth_;
            const auto* pixel = sourceRow + sourceX * 4;
            const int blue = pixel[0];
            const int green = pixel[1];
            const int red = pixel[2];
            yPlane[y * outputWidth_ + x] = ClampByte(
                ((66 * red + 129 * green + 25 * blue + 128) >> 8) + 16);
        }
    }

    for (UINT y = 0; y < outputHeight_; y += 2) {
        for (UINT x = 0; x < outputWidth_; x += 2) {
            int sumU = 0;
            int sumV = 0;
            for (UINT offsetY = 0; offsetY < 2; ++offsetY) {
                const UINT sourceY =
                    (y + offsetY) * sourceHeight_ / outputHeight_;
                const auto* sourceRow = source + sourceY * mapped.RowPitch;
                for (UINT offsetX = 0; offsetX < 2; ++offsetX) {
                    const UINT sourceX =
                        (x + offsetX) * sourceWidth_ / outputWidth_;
                    const auto* pixel = sourceRow + sourceX * 4;
                    const int blue = pixel[0];
                    const int green = pixel[1];
                    const int red = pixel[2];
                    sumU += ((-38 * red - 74 * green + 112 * blue + 128) >>
                             8) +
                            128;
                    sumV += ((112 * red - 94 * green - 18 * blue + 128) >> 8) +
                            128;
                }
            }
            const size_t uvIndex = (y / 2) * outputWidth_ + x;
            uvPlane[uvIndex] = ClampByte(sumU / 4);
            uvPlane[uvIndex + 1] = ClampByte(sumV / 4);
        }
    }

    context_->Unmap(stagingTexture_.Get(), 0);
    totalConversionMilliseconds_ +=
        std::chrono::duration<double, std::milli>(Clock::now() - conversionStart)
            .count();
}

void H264Loopback::SubmitNv12Frame() {
    const auto encodeStart = Clock::now();
    auto input =
        CreateInputSample(nv12Frame_, nextSampleTime_, sampleDuration_);

    HRESULT result = encoder_->ProcessInput(0, input.Get(), 0);
    if (result == MF_E_NOTACCEPTING) {
        DrainEncoder();
        result = encoder_->ProcessInput(0, input.Get(), 0);
    }
    Check(result, "Submit NV12 frame to H.264 encoder");
    DrainEncoder();

    totalEncodeMilliseconds_ +=
        std::chrono::duration<double, std::milli>(Clock::now() - encodeStart)
            .count();
}

void H264Loopback::DrainEncoder() {
    const DWORD minimumBufferSize = outputWidth_ * outputHeight_;
    auto encodedSamples = DrainTransform(encoder_.Get(), minimumBufferSize,
                                         "Get H.264 encoder output");
    for (auto& sample : encodedSamples) {
        EncodedPacket packet;
        packet.bytes = std::move(sample.bytes);
        packet.sampleTime = sample.sampleTime;
        packet.sampleDuration = sample.sampleDuration;
        packet.queuedAt = Clock::now();
        statistics_.encodedBytes += packet.bytes.size();
        ++statistics_.encodedFrames;
        if (packetCallback_ && !packet.bytes.empty()) {
            SourceTimestamps timestamps{};
            const auto timing =
                sourceTimestampsBySample_.find(packet.sampleTime);
            if (timing != sourceTimestampsBySample_.end()) {
                timestamps = timing->second;
                sourceTimestampsBySample_.erase(timing);
            }
            packetCallback_(packet.bytes, packet.sampleTime,
                            packet.sampleDuration,
                            timestamps.sourceEventQpc,
                            timestamps.captureReadyQpc);
        }
        if (decodeLocally_) {
            encodedQueue_.push_back(std::move(packet));
        }
    }
}

void H264Loopback::DecodeQueuedPackets() {
    while (!encodedQueue_.empty()) {
        EncodedPacket packet = std::move(encodedQueue_.front());
        encodedQueue_.pop_front();
        totalQueueMilliseconds_ +=
            std::chrono::duration<double, std::milli>(Clock::now() -
                                                       packet.queuedAt)
                .count();

        const auto decodeStart = Clock::now();
        auto input = CreateInputSample(packet.bytes, packet.sampleTime,
                                       packet.sampleDuration);
        HRESULT result = decoder_->ProcessInput(0, input.Get(), 0);
        if (result == MF_E_NOTACCEPTING) {
            DrainDecoder();
            result = decoder_->ProcessInput(0, input.Get(), 0);
        }
        Check(result, "Submit H.264 packet to decoder");
        DrainDecoder();
        totalDecodeMilliseconds_ +=
            std::chrono::duration<double, std::milli>(Clock::now() - decodeStart)
                .count();
    }
}

void H264Loopback::DrainDecoder() {
    const DWORD decodedFrameSize = outputWidth_ * outputHeight_ * 3 / 2;
    auto decodedSamples = DrainTransform(decoder_.Get(), decodedFrameSize,
                                         "Get H.264 decoder output");
    for (const auto& sample : decodedSamples) {
        if (sample.bytes.size() >= decodedFrameSize) {
            const auto nonBlack = std::any_of(
                sample.bytes.begin(),
                sample.bytes.begin() + outputWidth_ * outputHeight_,
                [](std::uint8_t value) { return value > 16; });
            statistics_.decodedFrameContainsImage =
                statistics_.decodedFrameContainsImage || nonBlack;
        }
        ++statistics_.decodedFrames;
    }
}

void H264Loopback::UpdateAverages() {
    const double submitted =
        static_cast<double>(std::max<std::uint64_t>(statistics_.submittedFrames,
                                                    1));
    const double encoded =
        static_cast<double>(std::max<std::uint64_t>(statistics_.encodedFrames,
                                                    1));
    statistics_.averageConversionMilliseconds =
        totalConversionMilliseconds_ / submitted;
    statistics_.averageEncodeMilliseconds = totalEncodeMilliseconds_ / submitted;
    statistics_.averageQueueMilliseconds = totalQueueMilliseconds_ / encoded;
    statistics_.averageDecodeMilliseconds = totalDecodeMilliseconds_ / encoded;
}

void H264Loopback::Stop(bool emitFinalPackets) {
    if (!running_) {
        return;
    }

    if (!emitFinalPackets) {
        packetCallback_ = {};
    }

    Check(encoder_->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0),
          "Drain H.264 encoder");
    DrainEncoder();
    if (decodeLocally_) {
        DecodeQueuedPackets();
        Check(decoder_->ProcessMessage(MFT_MESSAGE_COMMAND_DRAIN, 0),
              "Drain H.264 decoder");
        DrainDecoder();
    }
    UpdateAverages();

    encoder_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
    if (decodeLocally_) {
        decoder_->ProcessMessage(MFT_MESSAGE_NOTIFY_END_OF_STREAM, 0);
    }
    encoder_.Reset();
    decoder_.Reset();
    stagingTexture_.Reset();
    context_.Reset();
    nv12Frame_.clear();
    encodedQueue_.clear();
    sourceTimestampsBySample_.clear();
    running_ = false;

    Check(MFShutdown(), "MFShutdown for H.264 loopback");
    mediaFoundationStarted_ = false;
}

} // namespace remotedesk
