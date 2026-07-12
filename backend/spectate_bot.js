const path = require('node:path');

function send(type, payload = {}) {
  if (process.send) process.send({ type, ...payload });
  else console.log(JSON.stringify({ type, ...payload }));
}

function readConfig() {
  try {
    return JSON.parse(Buffer.from(process.argv[2] || '', 'base64url').toString('utf8'));
  } catch (error) {
    throw new Error(`Invalid spectate config: ${error.message}`);
  }
}

function cleanPlayerName(value) {
  return String(value || '').replace(/[^A-Za-z0-9_ -]/g, '').slice(0, 32);
}

function startJavaBot(config) {
  const mineflayer = require('mineflayer');
  const bot = mineflayer.createBot({
    host: config.host,
    port: config.port,
    username: config.username,
    auth: config.auth || 'offline',
    hideErrors: false,
  });

  const publishPlayers = () => {
    send('players', { players: Object.keys(bot.players || {}).map(cleanPlayerName).filter(Boolean) });
  };

  bot.once('spawn', () => {
    send('status', { status: 'connected', target: config.username, message: `Java spectate bot joined ${config.host}:${config.port}.` });
    publishPlayers();
    setTimeout(() => {
      bot.chat(`/gamemode spectator ${config.username}`);
    }, 1200);
  });
  bot.on('playerJoined', publishPlayers);
  bot.on('playerLeft', publishPlayers);
  bot.on('kicked', (reason) => {
    const detail = typeof reason === 'string' ? reason : JSON.stringify(reason);
    const hint = /auth|verify|login|premium|microsoft|online/i.test(detail) ? ' If this Java server has online-mode=true, set NEXUSPANEL_SPECTATE_JAVA_AUTH=microsoft and install the bot with Microsoft auth support.' : '';
    send('error', { message: `Java bot kicked: ${detail}.${hint}` });
  });
  bot.on('error', (error) => send('error', { message: `Java bot error: ${error.message}` }));
  bot.on('end', (reason) => {
    send('status', { status: 'stopped', message: `Java spectate bot disconnected${reason ? `: ${reason}` : ''}.` });
    process.exit(0);
  });

  process.on('message', (message) => {
    if (message?.type === 'target') send('status', { status: 'connected', target: cleanPlayerName(message.target), message: `Following ${cleanPlayerName(message.target) || 'overview'}.` });
    if (message?.type === 'stop') bot.quit('NexusPanel spectate stopped');
  });
}

function startBedrockBot(config) {
  const bedrock = require('bedrock-protocol');
  const profilesFolder = path.join(config.runtimeDir, 'bedrock-profiles');
  const client = bedrock.createClient({
    host: config.host,
    port: config.port,
    username: config.username,
    offline: (config.auth || 'offline') === 'offline',
    auth: config.auth || 'offline',
    profilesFolder,
  });
  const players = new Set();
  let connected = false;

  const publishPlayers = () => send('players', { players: [...players].map(cleanPlayerName).filter(Boolean) });
  const markConnected = () => {
    if (connected) return;
    connected = true;
    players.add(config.username);
    send('status', { status: 'connected', target: config.username, message: `Bedrock spectate bot joined ${config.host}:${config.port}.` });
    publishPlayers();
    setTimeout(() => {
      try {
        client.queue('command_request', {
          command: `/gamemode spectator ${config.username}`,
          origin: { type: 0, uuid: '', request_id: '' },
          internal: false,
          version: 66,
        });
      } catch {}
    }, 1200);
  };

  client.once('join', markConnected);
  client.once('start_game', markConnected);
  client.once('spawn', markConnected);
  client.on('add_player', (packet) => {
    const name = packet?.username || packet?.runtime_entity_id || '';
    if (name) players.add(String(name));
    publishPlayers();
  });
  client.on('player_list', (packet) => {
    for (const record of packet?.records?.records || packet?.records || []) {
      if (record?.username) players.add(String(record.username));
    }
    publishPlayers();
  });
  client.on('disconnect', (packet) => {
    const detail = packet?.message || packet?.reason || 'closed';
    const hint = /auth|xbox|login|token|online/i.test(String(detail)) ? ' If online-mode=true, set NEXUSPANEL_SPECTATE_BEDROCK_AUTH=microsoft and restart NexusPanel.' : '';
    send('status', { status: 'stopped', message: `Bedrock spectate bot disconnected: ${detail}.${hint}` });
    process.exit(0);
  });
  client.on('kick', (packet) => {
    const detail = packet?.message || packet?.reason || JSON.stringify(packet);
    const hint = /auth|xbox|login|token|online/i.test(String(detail)) ? ' If online-mode=true, set NEXUSPANEL_SPECTATE_BEDROCK_AUTH=microsoft and restart NexusPanel.' : '';
    send('error', { message: `Bedrock bot kicked: ${detail}.${hint}` });
  });
  client.on('error', (error) => send('error', { message: `Bedrock bot error: ${error.message}` }));
  client.on('close', () => {
    send('status', { status: 'stopped', message: 'Bedrock spectate bot connection closed.' });
    process.exit(0);
  });

  process.on('message', (message) => {
    if (message?.type === 'target') send('status', { status: 'connected', target: cleanPlayerName(message.target), message: `Following ${cleanPlayerName(message.target) || 'overview'}.` });
    if (message?.type === 'stop') {
      try { client.disconnect('NexusPanel spectate stopped'); } catch {}
      process.exit(0);
    }
  });
}

try {
  const config = readConfig();
  send('status', { status: 'connecting', message: `Connecting ${config.type} spectate bot to ${config.host}:${config.port}...` });
  if (config.type === 'java') startJavaBot(config);
  else startBedrockBot(config);
} catch (error) {
  send('error', { message: error.message });
  process.exit(1);
}
