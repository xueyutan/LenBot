@echo off
rem Launch LenBot Desktop from terminals that inherit ELECTRON_RUN_AS_NODE / NODE_OPTIONS.
rem Double-clicking LenBot.exe directly does not need this wrapper.
setlocal
set "ELECTRON_RUN_AS_NODE="
set "NODE_OPTIONS="
start "" "%~dp0LenBot.exe"
endlocal
