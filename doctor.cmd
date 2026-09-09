@echo off
chcp 65001 >nul
setlocal DisableDelayedExpansion
set "DOCTOR_SELECTION_DIR=%TEMP%\codex-tool-doctor-%RANDOM%-%RANDOM%"
mkdir "%DOCTOR_SELECTION_DIR%" >nul 2>nul
if errorlevel 1 exit /b 1
set "DOCTOR_SELECTION_FILE=%DOCTOR_SELECTION_DIR%\node.cmd"
set "DOCTOR_NODE="
"%SystemRoot%\System32\cscript.exe" //nologo "%~dp0scripts\bootstrap-windows.js" --selection-file "%DOCTOR_SELECTION_FILE%"
if errorlevel 1 goto setup_failed
call "%DOCTOR_SELECTION_FILE%"
del "%DOCTOR_SELECTION_FILE%" >nul 2>nul
rmdir "%DOCTOR_SELECTION_DIR%" >nul 2>nul
if not defined DOCTOR_NODE exit /b 1
"%DOCTOR_NODE%" "%~dp0scripts\launch.mjs" %*
if not errorlevel 78 exit /b %errorlevel%
if errorlevel 79 exit /b %errorlevel%
set "DOCTOR_NODE="
mkdir "%DOCTOR_SELECTION_DIR%" >nul 2>nul
if errorlevel 1 exit /b 1
"%SystemRoot%\System32\cscript.exe" //nologo "%~dp0scripts\bootstrap-windows.js" --with-npm --selection-file "%DOCTOR_SELECTION_FILE%"
if errorlevel 1 goto setup_failed
call "%DOCTOR_SELECTION_FILE%"
del "%DOCTOR_SELECTION_FILE%" >nul 2>nul
rmdir "%DOCTOR_SELECTION_DIR%" >nul 2>nul
if not defined DOCTOR_NODE exit /b 1
"%DOCTOR_NODE%" "%~dp0scripts\launch.mjs" %*
exit /b %errorlevel%
:setup_failed
if exist "%DOCTOR_SELECTION_FILE%" del "%DOCTOR_SELECTION_FILE%" >nul 2>nul
rmdir "%DOCTOR_SELECTION_DIR%" >nul 2>nul
exit /b 1
