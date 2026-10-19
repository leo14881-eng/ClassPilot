@echo off
rem ClassPilot local run on this PC (development / testing before going online).
rem 1. Needs Node.js 22.13 or newer: https://nodejs.org (LTS)
rem 2. First run creates config.local.json from config\config.example.json - fill in passcode and keys, then run again.
rem 3. Opens http://localhost:8095 in the browser. Microphone works on localhost in Chrome / Edge.
setlocal
cd /d "%~dp0.."

where node >nul 2>nul || (echo Node.js not found. Install Node.js 22 LTS from https://nodejs.org & pause & exit /b 1)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" || (echo Node.js 22.13 or newer is required. Current: & node -v & pause & exit /b 1)

if not exist config.local.json (
  copy /y config\config.example.json config.local.json >nul
  echo Created config.local.json. Fill in passcode, openrouterKey, openaiKey, save, then run this again.
  notepad config.local.json
  exit /b 0
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install --no-audit --no-fund || (pause & exit /b 1)
)
echo Building...
call npm run build || (pause & exit /b 1)

set CLASSPILOT_CONFIG=%CD%\config.local.json
set CLASSPILOT_STATIC=%CD%\dist
set CLASSPILOT_DATA=%CD%\data
set CLASSPILOT_INSECURE_COOKIE=1
set NODE_NO_WARNINGS=1
start "" http://localhost:8095
echo ClassPilot is running at http://localhost:8095  (close this window to stop)
node dist-server\server.mjs
pause
