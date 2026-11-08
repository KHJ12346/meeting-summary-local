@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 goto nonode
node server.js
pause
exit /b 0
:nonode
echo Node.js is not installed. Node.js 20 or later is required.
pause
exit /b 1
