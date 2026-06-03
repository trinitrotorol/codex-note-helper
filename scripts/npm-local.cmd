@echo off
setlocal
set "NODE_ROOT=%~dp0..\.tools\node"
set "PATH=%NODE_ROOT%;%PATH%"
call "%NODE_ROOT%\npm.cmd" %*
exit /b %ERRORLEVEL%
