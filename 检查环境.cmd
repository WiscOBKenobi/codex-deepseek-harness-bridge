@echo off
setlocal
if /I "%~1"=="--self-test" (
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1" -Action check-quiet
  exit /b
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\launch.ps1" -Action check
exit /b
