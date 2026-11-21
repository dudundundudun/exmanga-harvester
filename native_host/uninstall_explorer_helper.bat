@echo off
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.exmanga.harvester" /f >nul 2>nul
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.exmanga.harvester" /f >nul 2>nul
echo [OK] ExManga Harvester Explorer Helper removed from registry.
pause
