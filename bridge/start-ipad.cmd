@echo off
cd /d "%~dp0"
rem The launcher detects this computer's LAN address; no personal IP is stored here.
start "" wscript.exe "%~dp0..\RemoteDesk-Launcher.vbs"
