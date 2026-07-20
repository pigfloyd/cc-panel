@echo off
setlocal
REM Windows hook launcher for Claude Code / Codex.
REM Prefer a real Node binary so we never depend on ELECTRON_RUN_AS_NODE.
set "HOOK_JS=%~dp0cc-panel-hook.js"

if exist "C:\Program Files\nodejs\node.exe" (
  "C:\Program Files\nodejs\node.exe" "%HOOK_JS%" %*
  exit /b %ERRORLEVEL%
)
if exist "C:\Program Files (x86)\nodejs\node.exe" (
  "C:\Program Files (x86)\nodejs\node.exe" "%HOOK_JS%" %*
  exit /b %ERRORLEVEL%
)

set "ELECTRON_EXE=%~dp0..\node_modules\electron\dist\electron.exe"
if exist "%ELECTRON_EXE%" (
  set "ELECTRON_RUN_AS_NODE=1"
  "%ELECTRON_EXE%" "%HOOK_JS%" %*
  exit /b %ERRORLEVEL%
)

where node >nul 2>nul
if %ERRORLEVEL%==0 (
  node "%HOOK_JS%" %*
  exit /b %ERRORLEVEL%
)

exit /b 1
