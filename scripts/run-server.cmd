@echo off
cd /d "%~dp0.."
if not exist logs mkdir logs
echo [%date% %time%] starting Citysignal >> logs\server.log
"C:\Program Files\nodejs\node.exe" server\index.js >> logs\server.log 2>&1
echo [%date% %time%] Citysignal exited with code %ERRORLEVEL% >> logs\server.log
