@echo off
setlocal EnableDelayedExpansion
set "HOST_DIR=%~dp0"
if "%HOST_DIR:~-1%"=="\" set "HOST_DIR=%HOST_DIR:~0,-1%"
set "BAT_PATH=%HOST_DIR%\run_host.bat"
set "JSON_PATH=%HOST_DIR%\com.exmanga.harvester.json"
set "EXT_ID=fbfkbcpeggepocnefhialccafhmiggbe"
if not "%~1"=="" set "EXT_ID=%~1"
set "BAT_JSON=%BAT_PATH:\=\\%"
(
  echo {
  echo   "name": "com.exmanga.harvester",
  echo   "description": "ExManga Harvester Windows Explorer Helper",
  echo   "path": "!BAT_JSON!",
  echo   "type": "stdio",
  echo   "allowed_origins": [
  echo     "chrome-extension://!EXT_ID!/"
  echo   ]
  echo }
) > "%JSON_PATH%"
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.exmanga.harvester" /ve /t REG_SZ /d "%JSON_PATH%" /f >nul
reg add "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.exmanga.harvester" /ve /t REG_SZ /d "%JSON_PATH%" /f >nul 2>nul
echo.
echo [OK] ExManga Harvester Explorer Helper installed!
echo Extension ID: !EXT_ID!
echo Manifest: %JSON_PATH%
echo You can close this window and click Open Folder in Chrome.
echo.
pause
