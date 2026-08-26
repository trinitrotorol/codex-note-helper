@echo off
setlocal
set "NODE_ROOT=%~dp0..\.tools\node"
if not exist "%NODE_ROOT%\npm.cmd" (
  echo Local Node.js is not installed. Run scripts\setup-local-node.ps1 first. 1>&2
  exit /b 1
)
set "npm_config_cache=%~dp0..\.npm-cache"
set "PATH=%NODE_ROOT%;%PATH%"
call "%NODE_ROOT%\npm.cmd" %*
exit /b %ERRORLEVEL%
