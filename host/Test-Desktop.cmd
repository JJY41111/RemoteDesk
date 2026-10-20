@echo off
setlocal
cd /d "%~dp0.."
for /f "usebackq tokens=*" %%i in (`"C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSROOT=%%i"
if not defined VSROOT exit /b 1
call "%VSROOT%\Common7\Tools\VsDevCmd.bat" -arch=x64
if errorlevel 1 exit /b %errorlevel%
if not exist out\system-host mkdir out\system-host
cl /nologo /std:c++20 /O2 /EHsc /W4 /DUNICODE /D_UNICODE /DNOMINMAX /Fe:out\system-host\desktop-access-test.exe bridge\test\desktop-access.cpp /link user32.lib
if errorlevel 1 exit /b %errorlevel%
cl /nologo /std:c++20 /O2 /EHsc /W4 /DUNICODE /D_UNICODE /DNOMINMAX /Fe:out\system-host\desktop-worker-test.exe bridge\test\desktop-worker.cpp /link user32.lib advapi32.lib d3d11.lib dxgi.lib ole32.lib
exit /b %errorlevel%
