@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0register-desktop-host.ps1" %*
if errorlevel 1 exit /b 1
