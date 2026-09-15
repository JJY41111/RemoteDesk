# H.264 recording validation — 2026-09-16

## Build

- Compiler: Microsoft Visual C++ 19.50.35721
- Windows SDK: 10.0.26100.0
- Command: `build.bat`
- Result: successful, without compiler errors or warnings from project code

## Automatic recording test

- Command: `out\remote_desk.exe --record-test`
- Process exit code: `0`
- Output: `capture.mp4`
- Container duration: 4.9999666 seconds
- Encoded frames: 150
- Resolution: 2560x1440
- Frame rate: 30 fps
- Video compression: H.264
- File size: 2,127,734 bytes
- Reported average video bitrate: 3,402,136 bits per second

The middle frame was decoded separately. It had a 2560x1440 BGR image, a pixel
range of 0–255, and a mean value of 33.8. Visual inspection confirmed that the
desktop was present and the video was not a black-frame-only file.

## Defect found and fixed

The first recording produced a structurally valid five-second H.264 file with
150 frames, but every decoded pixel was black. The recorder was reading the
swap-chain back buffer after `Present`. Because the swap chain uses
`DXGI_SWAP_EFFECT_FLIP_DISCARD`, its contents are not guaranteed to remain valid
after presentation.

The fix adds a dedicated `latestFrameTexture`. Each acquired desktop frame is
copied there before presentation. Both the preview back buffer and H.264
recorder now read from that stable texture.

## Current limitations

- Media Foundation is allowed to select hardware transforms, but the exact
  encoder MFT has not been identified. This run does not prove NVENC usage.
- Encoding currently performs a GPU-to-CPU readback through a staging texture.
- Recording is fixed at 30 fps and a requested 8 Mbps target bitrate.
- No decoder, network transport, remote input, audio, or cursor composition has
  been implemented yet.
- This is one successful short validation run, not a long-duration stability
  result.
