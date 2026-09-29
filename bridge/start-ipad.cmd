@echo off
cd /d "%~dp0"
echo RemoteDesk iPad bridge
echo Keep this window open while using the iPad.
echo If the LAN IPv4 is no longer 192.168.0.95, run npm.cmd run preflight first.
echo.
call npm.cmd start -- --host=192.168.0.95 --enable-input --audio --display=0:0 --gamepad=viiper
echo.
echo RemoteDesk stopped. The error, if any, is above.
pause
