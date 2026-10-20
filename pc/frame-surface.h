#pragma once
#include <windows.h>

// Keep background clearing and scaling off the visible DC. Only the completed
// frame is committed to the window, using one BitBlt per repaint.
class FrameSurface {
public:
    FrameSurface() = default;
    FrameSurface(const FrameSurface&) = delete;
    FrameSurface& operator=(const FrameSurface&) = delete;
    ~FrameSurface() { Reset(); }
    bool Ensure(HDC reference, int width, int height) {
        if (width <= 0 || height <= 0) return false;
        if (dc_ && width == width_ && height == height_) return true;
        Reset();
        dc_ = CreateCompatibleDC(reference);
        bitmap_ = CreateCompatibleBitmap(reference, width, height);
        if (!dc_ || !bitmap_) { Reset(); return false; }
        previous_ = SelectObject(dc_, bitmap_);
        if (!previous_ || previous_ == HGDI_ERROR) { previous_ = nullptr; Reset(); return false; }
        width_ = width; height_ = height;
        return true;
    }
    HDC Dc() const { return dc_; }
    bool Present(HDC target, const RECT& area) const {
        return dc_ && BitBlt(target, area.left, area.top,
            area.right - area.left, area.bottom - area.top,
            dc_, area.left, area.top, SRCCOPY);
    }
private:
    void Reset() {
        if (dc_ && previous_) SelectObject(dc_, previous_);
        if (bitmap_) DeleteObject(bitmap_);
        if (dc_) DeleteDC(dc_);
        dc_ = nullptr; bitmap_ = nullptr; previous_ = nullptr;
        width_ = height_ = 0;
    }
    HDC dc_{};
    HBITMAP bitmap_{};
    HGDIOBJ previous_{};
    int width_{}, height_{};
};
