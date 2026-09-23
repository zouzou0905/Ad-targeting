@echo off
chcp 65001 >nul
set "TOOL_DIR=%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%TOOL_DIR%run_tool.ps1"
if errorlevel 1 pause
