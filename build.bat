@echo off
setlocal

set "VSWHERE=C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (
    echo Visual Studio Installer was not found.
    exit /b 1
)

set "VSROOT="
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSROOT=%%i"

if not defined VSROOT (
    echo Visual Studio with the C++ desktop workload was not found.
    exit /b 1
)

call "%VSROOT%\Common7\Tools\VsDevCmd.bat" -arch=x64
if errorlevel 1 exit /b %errorlevel%

if not exist out mkdir out

cl.exe /nologo /std:c++20 /O2 /EHsc /W4 /permissive- ^
    /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /DNOMINMAX ^
    /Fe:out\remote_desk.exe src\main.cpp src\h264_recorder.cpp ^
    src\h264_loopback.cpp src\network_transport.cpp ^
    /link d3d11.lib dxgi.lib user32.lib gdi32.lib ole32.lib oleaut32.lib ^
    mf.lib mfplat.lib mfreadwrite.lib mfuuid.lib wmcodecdspuuid.lib ws2_32.lib

if errorlevel 1 exit /b %errorlevel%

cl.exe /nologo /std:c++20 /O2 /EHsc /W4 /permissive- ^
    /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /DNOMINMAX ^
    /Fe:out\remote_desk_receiver.exe src\receiver_main.cpp ^
    src\network_transport.cpp src\h264_network_decoder.cpp ^
    /link ws2_32.lib user32.lib gdi32.lib ole32.lib oleaut32.lib ^
    mf.lib mfplat.lib mfreadwrite.lib mfuuid.lib wmcodecdspuuid.lib

if errorlevel 1 exit /b %errorlevel%

cl.exe /nologo /std:c++20 /O2 /EHsc /W4 /permissive- ^
    /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /DNOMINMAX ^
    /Fe:out\remote_desk_input.exe src\remote_input.cpp ^
    /link user32.lib dxgi.lib

if errorlevel 1 exit /b %errorlevel%

cl.exe /nologo /std:c++20 /O2 /EHsc /W4 /permissive- ^
    /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /DNOMINMAX ^
    /Fe:out\remote_desk_audio.exe src\audio_loopback.cpp ^
    /link ole32.lib mmdevapi.lib user32.lib

if errorlevel 1 exit /b %errorlevel%

echo.
echo Build complete: capture, receiver, input, and audio helpers
