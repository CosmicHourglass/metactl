@echo off
rem metactl launcher. %~dp0 resolves relative to this script, works on any drive / path.
node "%~dp0bin\cli.js" %*
