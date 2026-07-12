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

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function packetEntityId(packet) {
  return String(
    packet?.runtime_id
    ?? packet?.runtime_entity_id
    ?? packet?.entity_runtime_id
    ?? packet?.entity_id
    ?? packet?.unique_id
    ?? packet?.uuid
    ?? '',
  );
}

function packetPosition(packet) {
  const position = packet?.position || packet?.pos || packet?.player_position || packet || {};
  if (Array.isArray(position)) {
    return { x: finiteNumber(position[0]), y: finiteNumber(position[1]), z: finiteNumber(position[2]) };
  }
  return {
    x: finiteNumber(position.x ?? position.X ?? packet?.x),
    y: finiteNumber(position.y ?? position.Y ?? packet?.y),
    z: finiteNumber(position.z ?? position.Z ?? packet?.z),
  };
}

function sendEntities(values) {
  const entities = values
    .map((entity) => {
      const name = cleanPlayerName(entity?.name || entity?.username || entity?.id);
      if (!name) return null;
      return {
        id: String(entity.id || name).slice(0, 80),
        name,
        x: finiteNumber(entity.x),
        y: finiteNumber(entity.y),
        z: finiteNumber(entity.z),
        yaw: finiteNumber(entity.yaw),
        pitch: finiteNumber(entity.pitch),
        self: Boolean(entity.self),
        updatedAt: Date.now(),
      };
    })
    .filter(Boolean)
    .slice(0, 80);
  send('entities', { entities });
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
  const publishEntities = () => {
    const entities = [];
    if (bot.entity?.position) {
      entities.push({
        id: config.username,
        name: config.username,
        x: bot.entity.position.x,
        y: bot.entity.position.y,
        z: bot.entity.position.z,
        yaw: bot.entity.yaw || 0,
        pitch: bot.entity.pitch || 0,
        self: true,
      });
    }
    for (const [username, player] of Object.entries(bot.players || {})) {
      const entity = player?.entity;
      if (!entity?.position) continue;
      entities.push({
        id: username,
        name: username,
        x: entity.position.x,
        y: entity.position.y,
        z: entity.position.z,
        yaw: entity.yaw || 0,
        pitch: entity.pitch || 0,
        self: username === config.username,
      });
    }
    sendEntities(entities);
  };

  bot.once('spawn', () => {
    send('status', { status: 'connected', target: config.username, message: `Java spectate bot joined ${config.host}:${config.port}.` });
    publishPlayers();
    setTimeout(() => {
      bot.chat(`/gamemode spectator ${config.username}`);
    }, 1200);
  });
  const entityTimer = setInterval(publishEntities, 250);
  entityTimer.unref();
  bot.on('playerJoined', publishPlayers);
  bot.on('playerLeft', publishPlayers);
  bot.on('kicked', (reason) => {
    const detail = typeof reason === 'string' ? reason : JSON.stringify(reason);
    const hint = /auth|verify|login|premium|microsoft|online/i.test(detail) ? ' If this Java server has online-mode=true, set NEXUSPANEL_SPECTATE_JAVA_AUTH=microsoft and install the bot with Microsoft auth support.' : '';
    send('error', { message: `Java bot kicked: ${detail}.${hint}` });
  });
  bot.on('error', (error) => send('error', { message: `Java bot error: ${error.message}` }));
  bot.on('end', (reason) => {
    clearInterval(entityTimer);
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
  const entities = new Map();
  let connected = false;

  const publishPlayers = () => send('players', { players: [...players].map(cleanPlayerName).filter(Boolean) });
  const rememberEntity = (id, patch) => {
    const key = String(id || patch?.name || '').slice(0, 80);
    if (!key) return;
    const previous = entities.get(key) || {};
    const next = {
      ...previous,
      ...patch,
      id: key,
      updatedAt: Date.now(),
    };
    if (next.name) players.add(String(next.name));
    entities.set(key, next);
  };
  const publishEntities = () => {
    const now = Date.now();
    for (const [id, entity] of [...entities.entries()]) {
      if (!entity.self && now - Number(entity.updatedAt || 0) > 30 * 1000) entities.delete(id);
    }
    sendEntities([...entities.values()]);
  };
  const markConnected = (packet = null) => {
    if (connected) return;
    connected = true;
    players.add(config.username);
    rememberEntity(config.username, { name: config.username, x: 0, y: 64, z: 0, yaw: 0, pitch: 0, self: true });
    const selfRuntimeId = packetEntityId(packet);
    if (selfRuntimeId) {
      entities.delete(config.username);
      rememberEntity(selfRuntimeId, { name: config.username, ...packetPosition(packet), self: true });
    }
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
    const id = packetEntityId(packet) || packet?.username;
    const name = packet?.username || packet?.name || packet?.display_name || id || '';
    if (name) players.add(String(name));
    rememberEntity(id, {
      name,
      ...packetPosition(packet),
      yaw: finiteNumber(packet?.yaw ?? packet?.head_yaw),
      pitch: finiteNumber(packet?.pitch),
      self: cleanPlayerName(name) === cleanPlayerName(config.username),
    });
    publishPlayers();
  });
  client.on('move_player', (packet) => {
    const id = packetEntityId(packet);
    if (!id) return;
    const previous = entities.get(id) || {};
    rememberEntity(id, {
      name: previous.name || (previous.self ? config.username : id),
      ...packetPosition(packet),
      yaw: finiteNumber(packet?.yaw ?? packet?.head_yaw, previous.yaw || 0),
      pitch: finiteNumber(packet?.pitch, previous.pitch || 0),
      self: previous.self || cleanPlayerName(previous.name) === cleanPlayerName(config.username),
    });
  });
  client.on('move_entity', (packet) => {
    const id = packetEntityId(packet);
    if (!id) return;
    const previous = entities.get(id) || {};
    const position = packetPosition(packet);
    rememberEntity(id, {
      name: previous.name || id,
      x: position.x || previous.x || 0,
      y: position.y || previous.y || 0,
      z: position.z || previous.z || 0,
      yaw: finiteNumber(packet?.yaw ?? packet?.head_yaw, previous.yaw || 0),
      pitch: finiteNumber(packet?.pitch, previous.pitch || 0),
      self: previous.self,
    });
  });
  client.on('remove_entity', (packet) => {
    const id = packetEntityId(packet);
    if (id) entities.delete(id);
  });
  client.on('player_list', (packet) => {
    for (const record of packet?.records?.records || packet?.records || []) {
      if (record?.username) {
        players.add(String(record.username));
        rememberEntity(packetEntityId(record) || record.username, {
          name: record.username,
          self: cleanPlayerName(record.username) === cleanPlayerName(config.username),
        });
      }
    }
    publishPlayers();
  });
  const entityTimer = setInterval(publishEntities, 250);
  entityTimer.unref();
  client.on('disconnect', (packet) => {
    clearInterval(entityTimer);
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
    clearInterval(entityTimer);
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
