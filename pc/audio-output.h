#pragma once
#include <windows.h>
#include <mmsystem.h>
#include <opus.h>
#include <array>
#include <vector>
#include <mutex>

// Bounded native PCM output. Older audio is discarded rather than queued indefinitely.
class AudioOutput {
    struct Slot { WAVEHDR header{}; std::array<opus_int16,11520> samples{}; bool prepared=false; };
    std::array<Slot,8> slots{};
    std::mutex mutex;
    HWAVEOUT device=nullptr;
    OpusDecoder* decoder=nullptr;
    std::size_t next=0;
public:
    unsigned long long packets=0,dropped=0;
    bool enabled=true;
    ~AudioOutput(){Stop();}
    void Start(){
        std::lock_guard lock(mutex);
        packets=dropped=0;
        int error=0;decoder=opus_decoder_create(48000,2,&error);
        if(error!=OPUS_OK) throw std::runtime_error("Cannot create Opus decoder");
        WAVEFORMATEX format{WAVE_FORMAT_PCM,2,48000,48000*4,4,16,0};
        if(waveOutOpen(&device,WAVE_MAPPER,&format,0,0,CALLBACK_NULL)!=MMSYSERR_NOERROR)
            throw std::runtime_error("Cannot open default audio device");
    }
    void Push(const rtc::binary& data){
        std::lock_guard lock(mutex);
        if(!device || !decoder) return;
        auto& slot=slots[next];
        if(slot.prepared && !(slot.header.dwFlags & WHDR_DONE)){++dropped;return;}
        if(slot.prepared){waveOutUnprepareHeader(device,&slot.header,sizeof(slot.header));slot.prepared=false;}
        const int count=opus_decode(decoder,reinterpret_cast<const unsigned char*>(data.data()),static_cast<opus_int32>(data.size()),slot.samples.data(),5760,0);
        if(count<=0) return;
        ++packets;
        if(!enabled) return;
        slot.header={};slot.header.lpData=reinterpret_cast<char*>(slot.samples.data());slot.header.dwBufferLength=count*4;
        if(waveOutPrepareHeader(device,&slot.header,sizeof(slot.header))!=MMSYSERR_NOERROR)return;
        slot.prepared=true;
        if(waveOutWrite(device,&slot.header,sizeof(slot.header))!=MMSYSERR_NOERROR){++dropped;return;}
        next=(next+1)%slots.size();
    }
    void SetEnabled(bool value){std::lock_guard lock(mutex);enabled=value;if(!value && device)waveOutReset(device);}
    void Stop(){
        std::lock_guard lock(mutex);
        if(device){waveOutReset(device);for(auto& slot:slots)if(slot.prepared){waveOutUnprepareHeader(device,&slot.header,sizeof(slot.header));slot.prepared=false;}waveOutClose(device);device=nullptr;}
        if(decoder){opus_decoder_destroy(decoder);decoder=nullptr;}
    }
    std::pair<unsigned long long,unsigned long long> Stats(){std::lock_guard lock(mutex);return {packets,dropped};}
};
