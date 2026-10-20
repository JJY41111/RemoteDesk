#pragma once
#include <rtc/rtc.hpp>
#include <set>
#include <mutex>

class ReceiverFeedback final:public rtc::MediaHandler {
    std::mutex mutex;
    std::set<uint64_t> recent;
    uint64_t first=0,highest=0,received=0;
    bool initialized=false;
public:
    void Count(uint16_t sequence){
        std::lock_guard lock(mutex);
        if(!initialized){first=highest=sequence;initialized=true;}
        const int16_t delta=static_cast<int16_t>(sequence-static_cast<uint16_t>(highest));
        if(delta<0 && static_cast<uint64_t>(-int(delta))>highest-first)return;
        const uint64_t extended=delta>=0?highest+delta:highest-static_cast<unsigned>(-int(delta));
        if(highest>4096 && extended<highest-4096)return;
        if(recent.insert(extended).second)++received;
        highest=std::max(highest,extended);
        while(!recent.empty() && highest>*recent.begin()+4096)recent.erase(recent.begin());
    }
    void incoming(rtc::message_vector& messages,const rtc::message_callback&) override {
        for(const auto& message:messages)if(message->type==rtc::Message::Binary && message->size()>=sizeof(rtc::RtpHeader)){
            const auto* header=reinterpret_cast<const rtc::RtpHeader*>(message->data());
            if(header->version()==2)Count(header->seqNumber());
        }
    }
    std::pair<uint64_t,uint64_t> Stats(){
        std::lock_guard lock(mutex);const uint64_t expected=initialized?highest-first+1:0;
        return {received,expected>received?expected-received:0};
    }
};
