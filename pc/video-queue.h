#pragma once
#include <cstdint>
#include <deque>
#include <utility>

// Keep compressed reference chains intact across short delivery bursts. Only
// abandon a chain for a bounded backlog, then restart at a complete keyframe.
template<class Frame> class VideoQueue {
public:
    struct Entry { Frame frame; bool key; std::uint64_t arrived, generation; };
    struct Result { std::size_t dropped{}, waitingDropped{}; bool requestRecovery{}; };
    Result Push(Frame frame, bool key, std::uint64_t now) {
        Result result;
        if (!entries_.empty() && (entries_.size() >= 24 || now - entries_.front().arrived > 250)) {
            std::size_t keep = entries_.size();
            if (!key) {
                for (std::size_t i = entries_.size(); i-- > 1;)
                    if (entries_[i].key && now - entries_[i].arrived <= 250) { keep = i; break; }
            }
            result.dropped = keep;
            entries_.erase(entries_.begin(), entries_.begin() + keep);
            ++generation_;
            for (auto& entry : entries_) entry.generation = generation_;
            waiting_ = entries_.empty();
        }
        if (waiting_ && !key) {
            result.waitingDropped = 1; result.requestRecovery = true; return result;
        }
        if (key) waiting_ = false;
        entries_.push_back({std::move(frame), key, now, generation_});
        return result;
    }
    Entry Pop() { auto value = std::move(entries_.front()); entries_.pop_front(); return value; }
    void clear() { entries_.clear(); waiting_ = true; ++generation_; }
    bool empty() const { return entries_.empty(); }
    std::size_t size() const { return entries_.size(); }
private:
    std::deque<Entry> entries_;
    bool waiting_ = true;
    std::uint64_t generation_{};
};
