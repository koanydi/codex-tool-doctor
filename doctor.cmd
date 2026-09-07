@echo off
chcp 65001 >nul
setlocal
where node.exe >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 22 或更新版本。
  pause
  exit /b 1
)
if not exist "%~dp0node_modules\smol-toml\package.json" (
  echo 缺少依赖，请在本目录运行 npm.cmd ci --ignore-scripts。
  pause
  exit /b 1
)
if "%~1"=="" (
  node.exe "%~dp0src\cli.mjs" menu
) else (
  node.exe "%~dp0src\cli.mjs" %*
)
exit /b %errorlevel%
