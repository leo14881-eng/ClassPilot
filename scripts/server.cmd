@echo off
rem Usage: scripts\server.cmd status ^| check ^| install ^| upload-config ^| restart
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" %*
if "%~1"=="" pause
