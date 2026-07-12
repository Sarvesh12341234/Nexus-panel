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

function packetChunkKey(packet) {
  const x = finiteNumber(
    packet?.x
      ?? packet?.chunk_x
      ?? packet?.chunkX
      ?? packet?.chunk_position?.x
      ?? packet?.chunkPosition?.x
      ?? packet?.position?.x
      ?? packet?.pos?.x,
    NaN,
  );
  const z = finiteNumber(
    packet?.z
      ?? packet?.chunk_z
      ?? packet?.chunkZ
      ?? packet?.chunk_position?.z
      ?? packet?.chunkPosition?.z
      ?? packet?.position?.z
      ?? packet?.pos?.z,
    NaN,
  );
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { key: `${Math.trunc(x)},${Math.trunc(z)}`, x: Math.trunc(x), z: Math.trunc(z) };
}

function objectKeys(value) {
  return value && typeof value === 'object' && !Buffer.isBuffer(value)
    ? Object.keys(value).slice(0, 12)
    : [];
}

function findPacketBytes(value, depth = 0, seen = new Set()) {
  if (!value || depth > 5 || seen.has(value)) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPacketBytes(item, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  seen.add(value);
  for (const key of ['payload', 'data', 'blob', 'sub_chunk_data', 'cache_blobs', 'raw_payload', 'buffer']) {
    const found = findPacketBytes(value[key], depth + 1, seen);
    if (found) return found;
  }
  for (const item of Object.values(value)) {
    const found = findPacketBytes(item, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function chunkGeometryFromBytes(packet, chunk) {
  const bytes = findPacketBytes(packet);
  if (!bytes || !bytes.length) return { columns: [], bytesRead: 0, digest: 0 };
  let digest = 2166136261;
  let energy = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    digest ^= byte;
    digest = Math.imul(digest, 16777619) >>> 0;
    energy = (energy + byte) >>> 0;
  }
  const columns = [];
  const stride = Math.max(1, Math.floor(bytes.length / 96));
  for (let localX = 0; localX < 16; localX += 2) {
    for (let localZ = 0; localZ < 16; localZ += 2) {
      const sample = (localX * 31 + localZ * 17 + digest) % bytes.length;
      const b0 = bytes[sample];
      const b1 = bytes[(sample + stride) % bytes.length];
      const b2 = bytes[(sample + stride * 3) % bytes.length];
      const signal = (b0 ^ ((b1 << 1) & 255) ^ ((b2 << 2) & 255)) & 255;
      const height = 44 + (signal % 56);
      const density = Math.round(((b0 + b1 + b2) / 765) * 1000) / 1000;
      columns.push({
        x: chunk.x * 16 + localX,
        z: chunk.z * 16 + localZ,
        y: height,
        h: 2 + (b2 % 18),
        d: density,
      });
    }
  }
  return { columns, bytesRead: bytes.length, digest: digest >>> 0, energy: energy >>> 0 };
}

function pseudoChunkFromBytes(name, packet, index) {
  const bytes = findPacketBytes(packet);
  if (!bytes || bytes.length < 96) return null;
  let digest = 2166136261;
  const limit = Math.min(bytes.length, 4096);
  for (let offset = 0; offset < limit; offset += 1) {
    digest ^= bytes[offset];
    digest = Math.imul(digest, 16777619) >>> 0;
  }
  const radius = 3;
  const slot = Math.abs((digest + index * 17) % 49);
  const x = (slot % 7) - radius;
  const z = Math.floor(slot / 7) - radius;
  return {
    key: `packet:${name}:${digest}:${index}`,
    x,
    z,
    pseudo: true,
  };
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
  let viewerStarted = false;

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
    if (config.rendererPort) {
      try {
        const mineflayerViewer = require('prismarine-viewer').mineflayer;
        mineflayerViewer(bot, {
          port: config.rendererPort,
          firstPerson: true,
          viewDistance: 8,
        });
        viewerStarted = true;
        send('renderer', {
          status: 'ready',
          mode: 'java-prismarine-firstperson',
          port: config.rendererPort,
          message: `Java first-person renderer is live on port ${config.rendererPort}.`,
        });
      } catch (error) {
        send('renderer', {
          status: 'missing',
          mode: 'java-prismarine-firstperson',
          port: config.rendererPort,
          message: `Install prismarine-viewer for Java screenshare rendering: cd /opt/nexuspanel && npm install prismarine-viewer. ${error.message}`,
        });
      }
    }
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
    if (viewerStarted) {
      try { bot.viewer?.close?.(); } catch {}
    }
    send('status', { status: 'stopped', message: `Java spectate bot disconnected${reason ? `: ${reason}` : ''}.` });
    process.exit(0);
  });

  process.on('message', (message) => {
    if (message?.type === 'target') {
      const target = cleanPlayerName(message.target);
      const entity = target ? bot.players?.[target]?.entity : null;
      if (entity?.position) {
        bot.lookAt(entity.position.offset(0, 1.4, 0), true).catch(() => {});
      }
      send('status', { status: 'connected', target, message: `Following ${target || 'overview'}.` });
    }
    if (message?.type === 'stop') {
      if (viewerStarted) {
        try { bot.viewer?.close?.(); } catch {}
      }
      bot.quit('NexusPanel spectate stopped');
    }
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
  const chunks = new Map();
  const blockUpdates = [];
  const packetStats = {
    total: 0,
    levelChunk: 0,
    updateBlock: 0,
    geometryColumns: 0,
    bytesTotal: 0,
    renderPackets: 0,
    movePlayer: 0,
    moveEntity: 0,
    addPlayer: 0,
    playerList: 0,
    lastPacketAt: 0,
    lastPacket: '',
    samples: [],
  };
  let connected = false;
  let observedPacketIndex = 0;

  const normalizePacketName = (name) => String(name || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();

  const countPacket = (name) => {
    const normalized = normalizePacketName(name);
    packetStats.total += 1;
    packetStats.lastPacketAt = Date.now();
    packetStats.lastPacket = normalized;
    if (normalized === 'level_chunk' || normalized === 'levelchunk') packetStats.levelChunk += 1;
    else if (normalized === 'update_block' || normalized === 'updateblock') packetStats.updateBlock += 1;
    else if (normalized === 'move_player' || normalized === 'moveplayer') packetStats.movePlayer += 1;
    else if (normalized === 'move_entity' || normalized === 'moveentity') packetStats.moveEntity += 1;
    else if (normalized === 'add_player' || normalized === 'addplayer') packetStats.addPlayer += 1;
    else if (normalized === 'player_list' || normalized === 'playerlist') packetStats.playerList += 1;
    return normalized;
  };
  const samplePacket = (name, packet) => {
    if (packetStats.samples.some((sample) => sample.name === name)) return;
    const bytes = findPacketBytes(packet);
    packetStats.samples.push({
      name,
      keys: objectKeys(packet),
      bytes: bytes?.length || 0,
      hasChunkKey: Boolean(packetChunkKey(packet)),
    });
    if (packetStats.samples.length > 8) packetStats.samples.shift();
  };

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
    if (![...entities.values()].some((entity) => entity.self)) {
      rememberEntity(config.username, { name: config.username, x: 0, y: 64, z: 0, yaw: 0, pitch: 0, self: true });
    }
    sendEntities([...entities.values()]);
  };
  const publishWorld = () => {
    const now = Date.now();
    for (const [key, chunk] of [...chunks.entries()]) {
      if (now - Number(chunk.updatedAt || 0) > 5 * 60 * 1000) chunks.delete(key);
    }
    send('world', {
      mode: 'nexusvision-packet-wireframe',
      chunks: [...chunks.values()].slice(-192),
      blockUpdates: blockUpdates.splice(0, blockUpdates.length).slice(-128),
      packetStats: { ...packetStats },
    });
  };
  const rememberChunkPacket = (packet, packetName = 'level_chunk') => {
    const explicitChunk = packetChunkKey(packet);
    const chunk = explicitChunk || pseudoChunkFromBytes(packetName, packet, observedPacketIndex);
    if (!chunk) return;
    const geometry = chunkGeometryFromBytes(packet, chunk);
    if (!geometry.bytesRead) return;
    packetStats.renderPackets += 1;
    packetStats.geometryColumns += geometry.columns.length;
    packetStats.bytesTotal += geometry.bytesRead;
    chunks.set(chunk.key, {
      x: chunk.x,
      z: chunk.z,
      pseudo: Boolean(chunk.pseudo),
      source: packetName,
      updatedAt: Date.now(),
      size: geometry.bytesRead || finiteNumber(packet?.payload?.length ?? packet?.data?.length ?? packet?.blob?.length),
      digest: geometry.digest,
      geometry,
    });
  };
  const rememberBlockUpdatePacket = (packet) => {
    const position = packetPosition(packet);
    blockUpdates.push({
      x: Math.trunc(position.x),
      y: Math.trunc(position.y),
      z: Math.trunc(position.z),
      runtimeId: finiteNumber(packet?.runtime_id ?? packet?.block_runtime_id ?? packet?.block?.runtime_id),
      updatedAt: Date.now(),
    });
    if (blockUpdates.length > 512) blockUpdates.splice(0, blockUpdates.length - 512);
  };
  const observePacket = (name, packet) => {
    observedPacketIndex += 1;
    const normalized = countPacket(name);
    if (packet) samplePacket(normalized, packet);
    const bytes = packet ? findPacketBytes(packet) : null;
    const chunkLike = /chunk|subchunk|sub_chunk|level|blob|block/i.test(normalized);
    if (packet && ((normalized === 'level_chunk' || normalized === 'levelchunk') || chunkLike || (bytes && bytes.length >= 512))) {
      rememberChunkPacket(packet, normalized);
    }
    if ((normalized === 'update_block' || normalized === 'updateblock') && packet) rememberBlockUpdatePacket(packet);
  };
  const originalEmit = client.emit.bind(client);
  client.emit = (name, ...args) => {
    if (!String(name || '').startsWith('newListener') && !String(name || '').startsWith('removeListener')) {
      observePacket(name, args[0]);
    }
    return originalEmit(name, ...args);
  };
  client.on('packet', (packet, meta = {}) => {
    observePacket(meta.name || packet?.name || packet?.packetName || 'packet', packet);
  });
  client.on('clientbound', (packet, meta = {}) => {
    observePacket(meta.name || packet?.name || packet?.packetName || 'clientbound', packet);
  });
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
  client.on('level_chunk', (packet) => {
    rememberChunkPacket(packet);
  });
  client.on('update_block', (packet) => {
    rememberBlockUpdatePacket(packet);
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
  const worldTimer = setInterval(publishWorld, 650);
  worldTimer.unref();
  client.on('disconnect', (packet) => {
    clearInterval(entityTimer);
    clearInterval(worldTimer);
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
    clearInterval(worldTimer);
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
