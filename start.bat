@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
if not exist server\dist\index.js call npm run build
node scripts\start.mjs
