@echo off
chcp 65001 >nul
call "%~dp0doctor.cmd" gui %*
if errorlevel 1 pause
