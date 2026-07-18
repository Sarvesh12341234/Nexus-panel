@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (
  echo Node.js 24 or newer is required.
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)" || (
  echo Upgrade Node.js to version 24 LTS or newer.
  exit /b 1
)
call npm install --no-audit --no-fund || exit /b 1
echo NexusPanel dependencies installed successfully.
