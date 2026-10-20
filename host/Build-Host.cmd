@echo off
setlocal
cd /d "%~dp0.."
set "VSWHERE=C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
for /f "usebackq tokens=*" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSROOT=%%i"
if not defined VSROOT exit /b 1
call "%VSROOT%\Common7\Tools\VsDevCmd.bat" -arch=x64
if errorlevel 1 exit /b %errorlevel%
if not exist out\system-host mkdir out\system-host
cl /nologo /std:c++20 /O2 /EHsc /W4 /permissive- /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /DNOMINMAX /Fe:out\system-host\remote_desk_host.exe src\host_service.cpp /link user32.lib advapi32.lib wtsapi32.lib userenv.lib ole32.lib
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++20 /O2 /EHsc /W4 /permissive- /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /DNOMINMAX /Fe:out\system-host\remote_desk_input.exe src\remote_input.cpp /link user32.lib dxgi.lib advapi32.lib
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++20 /O2 /EHsc /W4 /permissive- /DUNICODE /D_UNICODE /DWIN32_LEAN_AND_MEAN /DNOMINMAX /Fe:out\system-host\remote_desk.exe src\main.cpp src\h264_recorder.cpp src\h264_loopback.cpp src\network_transport.cpp /link d3d11.lib dxgi.lib user32.lib gdi32.lib ole32.lib oleaut32.lib advapi32.lib mf.lib mfplat.lib mfreadwrite.lib mfuuid.lib wmcodecdspuuid.lib ws2_32.lib
exit /b %errorlevel%
