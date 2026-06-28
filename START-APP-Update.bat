@echo off
REM Refresh desktop/taskbar shortcuts, then open the cloud app
cd /d "%~dp0"
wscript //nologo "%~dp0Install-LJC-Shortcuts.vbs"
wscript //nologo "%~dp0Launch_LJC_AI_Accounting.vbs"
exit /b 0
