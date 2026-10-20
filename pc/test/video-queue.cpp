#include "../video-queue.h"
#include <cassert>
#include <iostream>

int main() {
    VideoQueue<unsigned> burst;
    for (unsigned i=0;i<8;++i) {
        auto result=burst.Push(i,i==0,i*8);
        assert(result.dropped==0 && result.waitingDropped==0 && !result.requestRecovery);
    }
    for (unsigned i=0;i<8;++i) assert(burst.Pop().frame==i);

    VideoQueue<unsigned> bounded;
    for(unsigned i=0;i<24;++i) bounded.Push(i,i==0,i);
    auto overflow=bounded.Push(24,false,24);
    assert(overflow.dropped==24 && overflow.waitingDropped==1 && overflow.requestRecovery && bounded.empty());
    assert(bounded.Push(25,false,25).waitingDropped==1);
    auto resumed=bounded.Push(26,true,26);
    assert(!resumed.requestRecovery && bounded.size()==1);
    const auto restarted=bounded.Pop();assert(restarted.key && restarted.generation>0);

    VideoQueue<unsigned> recentKey;
    for(unsigned i=0;i<24;++i)recentKey.Push(i,i==0 || i==8,i);
    auto trimmed=recentKey.Push(24,false,24);
    assert(trimmed.dropped==8 && !trimmed.requestRecovery && recentKey.size()==17);
    auto fresh=recentKey.Pop();assert(fresh.frame==8 && fresh.key && fresh.generation>0);
    for(unsigned i=9;i<=24;++i){auto frame=recentKey.Pop();assert(frame.frame==i && frame.generation==fresh.generation);}

    VideoQueue<unsigned> stale;
    stale.Push(0,true,0);
    auto old=stale.Push(1,false,251);
    assert(old.dropped==1 && old.waitingDropped==1 && stale.empty());
    stale.Push(2,true,252);assert(stale.Pop().key);

    VideoQueue<unsigned> keyOnOverflow;
    for(unsigned i=0;i<24;++i)keyOnOverflow.Push(i,i==0,i);
    auto key=keyOnOverflow.Push(24,true,24);
    assert(key.dropped==24 && !key.requestRecovery && !key.waitingDropped);
    assert(keyOnOverflow.Pop().key);
    std::cout<<"PASS: delivery bursts retain references, age/size bound backlog, resync starts at a keyframe with a new decoder generation\n";
}
