#include "../frame-surface.h"
#include <iostream>

int main() {
    HDC screen = GetDC(nullptr);
    HDC target = CreateCompatibleDC(screen);
    HBITMAP bitmap = CreateCompatibleBitmap(screen, 96, 80);
    HGDIOBJ original = SelectObject(target, bitmap);
    RECT warmup{0, 0, 96, 80};
    FillRect(target, &warmup, static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
    SetPixel(target, 8, 8, RGB(0, 255, 0));
    // Windows lazily allocates/caches process-wide GDI resources. Exercise
    // each operation once before measuring resources owned by the surface.
    {
        FrameSurface warmSurface;
        if (!warmSurface.Ensure(screen, 96, 80)) return 2;
        HBRUSH brush = CreateSolidBrush(RGB(0, 0, 255));
        FillRect(warmSurface.Dc(), &warmup, brush); DeleteObject(brush);
        warmSurface.Present(target, warmup); GdiFlush();
    }
    GdiFlush();
    const DWORD baseline = GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS);
    bool ok = true;
    {
        FrameSurface surface;
        for (int i = 0; i < 500 && ok; ++i) {
            const int width = i % 2 ? 64 : 96, height = i % 2 ? 48 : 80;
            ok = surface.Ensure(screen, width, height);
            if (!ok) break;
            RECT full{0, 0, width, height}, image{4, 4, width - 4, height - 4};
            FillRect(surface.Dc(), &full, static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
            HBRUSH color = CreateSolidBrush(i % 2 ? RGB(255, 0, 0) : RGB(0, 0, 255));
            FillRect(surface.Dc(), &image, color); DeleteObject(color);
            // Clearing/rendering the next frame must leave the visible target
            // untouched until the completed frame is explicitly presented.
            SetPixel(target, 8, 8, RGB(0, 255, 0));
            ok = GetPixel(target, 8, 8) == RGB(0, 255, 0) && surface.Present(target, full);
            ok = ok && GetPixel(target, 8, 8) == (i % 2 ? RGB(255, 0, 0) : RGB(0, 0, 255));
            ok = ok && GetPixel(target, 0, 0) == RGB(0, 0, 0);
            GdiFlush();
            const DWORD handles = GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS);
            if (!ok || handles > baseline + 2) {
                std::cerr << "iteration=" << i << " pixels=" << ok << " handles=" << handles << " baseline=" << baseline << '\n';
                ok = false;
            }
        }
    }
    GdiFlush();
    const DWORD after = GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS);
    if (after != baseline) std::cerr << "after=" << after << " baseline=" << baseline << '\n';
    ok = ok && after == baseline;
    SelectObject(target, original); DeleteObject(bitmap); DeleteDC(target); ReleaseDC(nullptr, screen);
    if (!ok) { std::cerr << "FAIL: buffered presentation pixels or GDI handle lifetime\n"; return 1; }
    std::cout << "PASS: 500 buffered frames/resizes, complete image and letterbox, no GDI handle leak\n";
}
