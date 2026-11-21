@echo off
setlocal
where python >nul 2>nul
if %errorlevel%==0 (
  python "%~dp0open_folder_host.py"
) else (
  py -3 "%~dp0open_folder_host.py"
)
