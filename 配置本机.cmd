@echo off
setlocal
if /I "%~1"=="--self-test" (
  "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup-windows.ps1" -SelfTest
  exit /b
)
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\setup-windows.ps1"
exit /b
