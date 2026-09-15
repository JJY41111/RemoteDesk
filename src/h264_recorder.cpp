#include "h264_recorder.h"

#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <wrl/client.h>

#include <algorithm>
#include <sstream>
#include <stdexcept>

using Microsoft::WRL::ComPtr;

namespace remotedesk {
namespace {

std::runtime_error MediaFoundationError(const char* operation, HRESULT result) {
    std::ostringstream message;
    message << operation << " failed (HRESULT 0x" << std::hex
            << static_cast<unsigned long>(result) << ')';
    return std::runtime_error(message.str());
}

void Check(HRESULT result, const char* operation) {
    if (FAILED(result)) {
        throw MediaFoundationError(operation, result);
    }
}

class TextureMap {
public:
    TextureMap(ID3D11DeviceContext* context, ID3D11Texture2D* texture)
        : context_(context), texture_(texture) {
        const HRESULT result =
            context_->Map(texture_, 0, D3D11_MAP_READ, 0, &mapped_);
        Check(result, "Map staging texture");
        mappedSuccessfully_ = true;
    }

    TextureMap(const TextureMap&) = delete;
    TextureMap& operator=(const TextureMap&) = delete;

    ~TextureMap() {
        if (mappedSuccessfully_) {
            context_->Unmap(texture_, 0);
        }
    }

    [[nodiscard]] const D3D11_MAPPED_SUBRESOURCE& Data() const noexcept {
        return mapped_;
    }

private:
    ID3D11DeviceContext* context_{};
    ID3D11Texture2D* texture_{};
    D3D11_MAPPED_SUBRESOURCE mapped_{};
    bool mappedSuccessfully_{};
};

} // namespace

H264Recorder::~H264Recorder() {
    if (writer_) {
        writer_->Finalize();
    }
    writer_.Reset();
    stagingTexture_.Reset();
    context_.Reset();

    if (mediaFoundationStarted_) {
        MFShutdown();
    }
}

void H264Recorder::Start(const wchar_t* outputPath, ID3D11Device* device,
                         ID3D11DeviceContext* context, UINT width, UINT height,
                         UINT framesPerSecond, UINT bitrate) {
    if (recording_) {
        throw std::runtime_error("H.264 recording is already active");
    }
    if (device == nullptr || context == nullptr || width == 0 || height == 0 ||
        framesPerSecond == 0) {
        throw std::invalid_argument("Invalid H.264 recorder configuration");
    }
    if ((width % 2) != 0 || (height % 2) != 0) {
        throw std::invalid_argument(
            "H.264 recording requires an even width and height");
    }

    Check(MFStartup(MF_VERSION), "MFStartup");
    mediaFoundationStarted_ = true;

    try {
        ComPtr<IMFAttributes> attributes;
        Check(MFCreateAttributes(&attributes, 2), "MFCreateAttributes");
        Check(attributes->SetUINT32(MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
                                    TRUE),
              "Enable Media Foundation hardware transforms");
        Check(attributes->SetUINT32(MF_SINK_WRITER_DISABLE_THROTTLING, TRUE),
              "Disable sink-writer throttling");

        Check(MFCreateSinkWriterFromURL(outputPath, nullptr, attributes.Get(),
                                        &writer_),
              "MFCreateSinkWriterFromURL");

        ComPtr<IMFMediaType> outputType;
        Check(MFCreateMediaType(&outputType), "Create H.264 output type");
        Check(outputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video),
              "Set output major type");
        Check(outputType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264),
              "Set H.264 output subtype");
        Check(outputType->SetUINT32(MF_MT_AVG_BITRATE, bitrate),
              "Set H.264 bitrate");
        Check(outputType->SetUINT32(MF_MT_INTERLACE_MODE,
                                    MFVideoInterlace_Progressive),
              "Set output interlace mode");
        Check(MFSetAttributeSize(outputType.Get(), MF_MT_FRAME_SIZE, width,
                                 height),
              "Set output frame size");
        Check(MFSetAttributeRatio(outputType.Get(), MF_MT_FRAME_RATE,
                                  framesPerSecond, 1),
              "Set output frame rate");
        Check(MFSetAttributeRatio(outputType.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1,
                                  1),
              "Set output pixel aspect ratio");
        Check(writer_->AddStream(outputType.Get(), &streamIndex_),
              "Add H.264 output stream");

        ComPtr<IMFMediaType> inputType;
        Check(MFCreateMediaType(&inputType), "Create RGB input type");
        Check(inputType->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video),
              "Set input major type");
        Check(inputType->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_ARGB32),
              "Set RGB input subtype");
        Check(inputType->SetUINT32(MF_MT_INTERLACE_MODE,
                                   MFVideoInterlace_Progressive),
              "Set input interlace mode");
        Check(inputType->SetUINT32(MF_MT_DEFAULT_STRIDE, width * 4),
              "Set input stride");
        Check(MFSetAttributeSize(inputType.Get(), MF_MT_FRAME_SIZE, width,
                                 height),
              "Set input frame size");
        Check(MFSetAttributeRatio(inputType.Get(), MF_MT_FRAME_RATE,
                                  framesPerSecond, 1),
              "Set input frame rate");
        Check(MFSetAttributeRatio(inputType.Get(), MF_MT_PIXEL_ASPECT_RATIO, 1,
                                  1),
              "Set input pixel aspect ratio");
        Check(writer_->SetInputMediaType(streamIndex_, inputType.Get(), nullptr),
              "Set sink-writer input type");

        D3D11_TEXTURE2D_DESC stagingDescription{};
        stagingDescription.Width = width;
        stagingDescription.Height = height;
        stagingDescription.MipLevels = 1;
        stagingDescription.ArraySize = 1;
        stagingDescription.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
        stagingDescription.SampleDesc.Count = 1;
        stagingDescription.Usage = D3D11_USAGE_STAGING;
        stagingDescription.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
        Check(device->CreateTexture2D(&stagingDescription, nullptr,
                                      &stagingTexture_),
              "Create encoder staging texture");

        Check(writer_->BeginWriting(), "Begin H.264 writing");

        context_ = context;
        width_ = width;
        height_ = height;
        framesPerSecond_ = framesPerSecond;
        sampleDuration_ = 10'000'000LL / framesPerSecond_;
        nextSampleTime_ = 0;
        encodedFrames_ = 0;
        nextFrameDue_ = Clock::now();
        recording_ = true;
    } catch (...) {
        writer_.Reset();
        stagingTexture_.Reset();
        context_.Reset();
        MFShutdown();
        mediaFoundationStarted_ = false;
        throw;
    }
}

bool H264Recorder::WriteFrameIfDue(ID3D11Texture2D* sourceTexture) {
    if (!recording_ || sourceTexture == nullptr) {
        return false;
    }

    const auto now = Clock::now();
    if (now < nextFrameDue_) {
        return false;
    }

    context_->CopyResource(stagingTexture_.Get(), sourceTexture);
    const TextureMap mapped(context_.Get(), stagingTexture_.Get());

    const DWORD rowBytes = width_ * 4;
    const DWORD bufferSize = rowBytes * height_;
    ComPtr<IMFMediaBuffer> buffer;
    Check(MFCreateMemoryBuffer(bufferSize, &buffer),
          "Create H.264 input buffer");

    BYTE* destination = nullptr;
    DWORD maximumLength = 0;
    Check(buffer->Lock(&destination, &maximumLength, nullptr),
          "Lock H.264 input buffer");
    const HRESULT copyResult =
        MFCopyImage(destination, rowBytes,
                    static_cast<const BYTE*>(mapped.Data().pData),
                    static_cast<LONG>(mapped.Data().RowPitch), rowBytes,
                    height_);
    buffer->Unlock();
    Check(copyResult, "Copy desktop frame into Media Foundation buffer");
    Check(buffer->SetCurrentLength(bufferSize), "Set H.264 input length");

    ComPtr<IMFSample> sample;
    Check(MFCreateSample(&sample), "Create H.264 input sample");
    Check(sample->AddBuffer(buffer.Get()), "Attach H.264 input buffer");
    Check(sample->SetSampleTime(nextSampleTime_), "Set H.264 sample time");
    Check(sample->SetSampleDuration(sampleDuration_),
          "Set H.264 sample duration");
    Check(writer_->WriteSample(streamIndex_, sample.Get()),
          "Write H.264 sample");

    ++encodedFrames_;
    nextSampleTime_ += sampleDuration_;
    const auto interval =
        std::chrono::nanoseconds(1'000'000'000LL / framesPerSecond_);
    nextFrameDue_ += interval;
    if (nextFrameDue_ + interval < now) {
        nextFrameDue_ = now + interval;
    }
    return true;
}

void H264Recorder::Stop() {
    if (!recording_) {
        return;
    }

    recording_ = false;
    Check(writer_->Finalize(), "Finalize H.264 output");
    writer_.Reset();
    stagingTexture_.Reset();
    context_.Reset();

    Check(MFShutdown(), "MFShutdown");
    mediaFoundationStarted_ = false;
}

} // namespace remotedesk
