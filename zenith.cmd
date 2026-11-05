@echo off
if not defined NODE_OPTIONS set "NODE_OPTIONS=--max-old-space-size=48"
node "%~dp0src\index.js" %*
