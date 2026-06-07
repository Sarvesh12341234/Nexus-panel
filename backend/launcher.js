const { spawnSync } = require('node:child_process');
const { hasSystemd, install, serviceName, startService, status } = require('./service');

function runForeground() {
  require('./index');
}

function isRoot() {
  return typeof process.getuid !== 'function' || process.getuid() === 0;
}

function sudoInstall() {
  const result = spawnSync('sudo', [process.execPath, require.resolve('./service'), 'install'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  return !result.error && result.status === 0;
}

function main() {
  const foreground = process.argv.includes('--foreground')
    || process.env.NEXUSPANEL_SERVICE === '1'
    || process.env.NEXUSPANEL_FOREGROUND === '1'
    || process.env.NEXUSPANEL_NO_SERVICE === '1';

  if (foreground || process.platform !== 'linux' || !hasSystemd()) {
    runForeground();
    return;
  }

  const current = status({ quiet: true });
  if (current.installed) {
    if (!current.active) {
      if (isRoot()) startService();
      else if (!sudoInstall()) {
        console.log(`Service exists but is stopped. Run: sudo systemctl start ${serviceName}`);
        return;
      }
    }
    console.log(`NexusPanel is running in background as system service: ${serviceName}`);
    console.log(`Logs: journalctl -u ${serviceName} -f`);
    return;
  }

  if (isRoot()) {
    install({ start: true });
  } else if (!sudoInstall()) {
    console.log('Could not install the background service automatically.');
    console.log('Run: sudo npm run service:install');
    console.log('Or run foreground mode: npm run foreground');
    return;
  }

  console.log(`NexusPanel installed as ${serviceName} and will auto-start after VPS reboot.`);
}

main();
