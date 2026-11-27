@echo off
chcp 65001 >nul
setlocal
set "ROOT=%~dp0.."
set "PY="

if exist "%ROOT%\current.json" (
  for /f "usebackq tokens=*" %%V in (`powershell -NoProfile -Command "(Get-Content -Raw -Encoding UTF8 '%ROOT%\current.json' ^| ConvertFrom-Json).version" 2^>nul`) do set "VER=%%V"
)
if not defined VER set "VER=0.2.7"
set "PY=%ROOT%\releases\%VER%\python\python.exe"
if not exist "%PY%" (
  for /f "delims=" %%F in ('dir /b /s "%ROOT%\releases\python.exe" 2^>nul') do set "PY=%%F"
)
if not exist "%PY%" (
  echo [ERROR] Cannot find the bundled python.exe under releases\
  echo Please run: releases\%VER%\python\python.exe -X utf8 patches\reapply.py --check
  pause
  exit /b 1
)

"%PY%" -X utf8 "%~dp0reapply.py" --apply --root "%ROOT%"
echo.
pause
endlocal
