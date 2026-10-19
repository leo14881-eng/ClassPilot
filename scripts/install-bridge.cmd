@echo off
rem One-time: lets Claude maintain the ClassPilot server through fixed actions (check/install/status/upload-config/restart).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-bridge.ps1"
pause
