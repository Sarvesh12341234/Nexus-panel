const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const { BedrockWorldAdapter, asBuffer, chunkCoords } = require('./bedrock_adapter');

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
  const position = packet?.position || packet?.pos || packet?.player_position || packet?.spawn_position || packet || {};
  if (Array.isArray(position)) {
    return { x: finiteNumber(position[0]), y: finiteNumber(position[1], 64), z: finiteNumber(position[2]) };
  }
  return {
    x: finiteNumber(position.x ?? position.X ?? packet?.x),
    y: finiteNumber(position.y ?? position.Y ?? packet?.y, 64),
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

function objectKeys(value) {
  return value && typeof value === 'object' && !Buffer.isBuffer(value)
    ? Object.keys(value).slice(0, 12)
    : [];
}

function safeTextureKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^minecraft:/, '')
    .replace(/\.png$/i, '')
    .replace(/[^a-z0-9_./-]+/g, '_')
    .replace(/(?:^|\/)\.\.(?:\/|$)/g, '')
    .replace(/^\/+/, '')
    .slice(0, 160);
}

function textureAliases(name) {
  const key = safeTextureKey(name).replace(/^textures\/(?:blocks?|entity)\//, '');
  const aliases = new Set([key]);
  if (key.includes('grass_block')) {
    aliases.add('grass_block_side');
    aliases.add('grass_block_top');
    aliases.add('grass_side');
    aliases.add('grass_top');
  }
  if (key.includes('dirt')) aliases.add('dirt');
  if (key.includes('stone')) aliases.add('stone');
  if (key.includes('oak_log') || key.includes('log')) {
    aliases.add('oak_log');
    aliases.add('oak_log_side');
  }
  if (key.includes('leaves')) aliases.add('oak_leaves');
  if (key.includes('water')) aliases.add('water_still');
  if (key.includes('sand')) aliases.add('sand');
  return [...aliases];
}

function defaultTextureRoots(config) {
  const roots = [];
  if (Array.isArray(config.textureRoots)) roots.push(...config.textureRoots);
  if (process.env.NEXUSPANEL_SPECTATE_TEXTURE_ROOT) {
    roots.push(...String(process.env.NEXUSPANEL_SPECTATE_TEXTURE_ROOT).split(path.delimiter));
  }
  if (config.runtimeDir) roots.push(path.join(config.runtimeDir, 'textures'));
  if (process.env.APPDATA) roots.push(path.join(process.env.APPDATA, '.minecraft'));
  if (process.env.HOME) roots.push(path.join(process.env.HOME, '.minecraft'));
  return [...new Set(roots.filter(Boolean))];
}

function buildTextureIndex(config = {}) {
  const index = new Map();
  const roots = defaultTextureRoots(config)
    .map((root) => path.resolve(String(root || '')))
    .filter((root) => root && fs.existsSync(root));
  const add = (keys, absolute) => {
    if (!absolute || (typeof absolute === 'string' && !fs.existsSync(absolute))) return;
    for (const raw of Array.isArray(keys) ? keys : [keys]) {
      const key = safeTextureKey(raw);
      if (key && !index.has(key)) index.set(key, absolute);
    }
  };
  const addTextureKeys = (assetName, value) => {
    const lower = String(assetName || '').toLowerCase();
    if (!lower.endsWith('.png')) return;
    if (!lower.includes('/textures/block') && !lower.includes('/textures/entity')) return;
    const parsed = path.parse(lower);
    const kind = lower.includes('/textures/entity') ? 'entity' : 'block';
    add([parsed.name, `${kind}/${parsed.name}`, lower.replace(/\.png$/i, '')], value);
  };
  const visit = (root, dir, depth = 0, seen = { count: 0 }) => {
    if (depth > 8 || seen.count > 8000) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (seen.count > 8000) return;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).replaceAll('\\', '/');
      const lower = relative.toLowerCase();
      if (entry.isDirectory()) {
        if (
          lower === 'textures'
          || lower.startsWith('textures/')
          || lower === 'resourcepacks'
          || lower === 'server-resource-packs'
          || lower.includes('/textures')
          || lower.includes('resource')
        ) visit(root, absolute, depth + 1, seen);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.png')) continue;
      if (!lower.includes('textures/') && !lower.includes('texture/')) continue;
      seen.count += 1;
      addTextureKeys(relative, absolute);
    }
  };
  const indexJarTextures = (jarPath) => {
    let fd;
    try {
      const stat = fs.statSync(jarPath);
      const tailSize = Math.min(stat.size, 1024 * 80);
      fd = fs.openSync(jarPath, 'r');
      const tail = Buffer.alloc(tailSize);
      fs.readSync(fd, tail, 0, tailSize, stat.size - tailSize);
      let eocd = -1;
      for (let offset = tail.length - 22; offset >= 0; offset -= 1) {
        if (tail.readUInt32LE(offset) === 0x06054b50) {
          eocd = offset;
          break;
        }
      }
      if (eocd < 0) return;
      const directorySize = tail.readUInt32LE(eocd + 12);
      const directoryOffset = tail.readUInt32LE(eocd + 16);
      const directory = Buffer.alloc(directorySize);
      fs.readSync(fd, directory, 0, directorySize, directoryOffset);
      let offset = 0;
      while (offset + 46 <= directory.length && directory.readUInt32LE(offset) === 0x02014b50) {
        const method = directory.readUInt16LE(offset + 10);
        const compressedSize = directory.readUInt32LE(offset + 20);
        const fileNameLength = directory.readUInt16LE(offset + 28);
        const extraLength = directory.readUInt16LE(offset + 30);
        const commentLength = directory.readUInt16LE(offset + 32);
        const localOffset = directory.readUInt32LE(offset + 42);
        const entryName = directory.subarray(offset + 46, offset + 46 + fileNameLength).toString('utf8');
        addTextureKeys(entryName, { jarPath, entryName, method, compressedSize, localOffset });
        offset += 46 + fileNameLength + extraLength + commentLength;
      }
    } catch {
      // Ignore nonstandard jars/resource packs.
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch {}
      }
    }
  };
  const indexMinecraftAssets = (root) => {
    const indexesDir = path.join(root, 'assets', 'indexes');
    const objectsDir = path.join(root, 'assets', 'objects');
    if (!fs.existsSync(indexesDir) || !fs.existsSync(objectsDir)) return;
    const indexes = fs.readdirSync(indexesDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.join(indexesDir, entry.name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      .slice(0, 6);
    for (const indexPath of indexes) {
      let assets;
      try {
        assets = JSON.parse(fs.readFileSync(indexPath, 'utf8')).objects || {};
      } catch {
        continue;
      }
      for (const [assetName, info] of Object.entries(assets)) {
        const lower = assetName.toLowerCase();
        if (!lower.endsWith('.png') || !lower.includes('/textures/')) continue;
        if (!lower.includes('/textures/block') && !lower.includes('/textures/entity')) continue;
        const hash = String(info?.hash || '');
        if (!/^[a-f0-9]{40}$/i.test(hash)) continue;
        const absolute = path.join(objectsDir, hash.slice(0, 2), hash);
        addTextureKeys(assetName, absolute);
      }
    }
    const versionsDir = path.join(root, 'versions');
    if (fs.existsSync(versionsDir)) {
      const jars = [];
      const stack = [versionsDir];
      while (stack.length && jars.length < 12) {
        const dir = stack.pop();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const absolute = path.join(dir, entry.name);
          if (entry.isDirectory()) stack.push(absolute);
          else if (entry.isFile() && entry.name.endsWith('.jar')) jars.push(absolute);
        }
      }
      jars.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs).slice(0, 5).forEach(indexJarTextures);
    }
  };
  for (const root of roots) {
    indexMinecraftAssets(root);
    visit(root, root);
  }
  return { index, roots };
}

function readTextureValue(value) {
  if (typeof value === 'string') return fs.readFileSync(value);
  if (!value || typeof value !== 'object') return null;
  let fd;
  try {
    fd = fs.openSync(value.jarPath, 'r');
    const local = Buffer.alloc(30);
    fs.readSync(fd, local, 0, 30, value.localOffset);
    if (local.readUInt32LE(0) !== 0x04034b50) return null;
    const nameLength = local.readUInt16LE(26);
    const extraLength = local.readUInt16LE(28);
    const dataOffset = value.localOffset + 30 + nameLength + extraLength;
    const compressed = Buffer.alloc(value.compressedSize);
    fs.readSync(fd, compressed, 0, value.compressedSize, dataOffset);
    if (value.method === 0) return compressed;
    if (value.method === 8) return zlib.inflateRawSync(compressed);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch {}
    }
  }
  return null;
}

function jsonScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function closeViewer(viewer) {
  if (!viewer) return;
  if (viewer.timer) clearInterval(viewer.timer);
  for (const client of viewer.clients || []) {
    try { client.end(); } catch {}
  }
  try { viewer.server?.close(); } catch {}
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

function startBedrockBrowserViewer(config, getState) {
  if (!config.rendererPort) return null;
  let express;
  try {
    express = require('express');
  } catch (error) {
    send('renderer', {
      status: 'missing',
      mode: 'bedrock-threejs-viewer',
      port: config.rendererPort,
      message: `Install express for Bedrock browser rendering: cd /opt/nexuspanel && npm install express. ${error.message}`,
    });
    return null;
  }

  const app = express();
  const clients = new Set();
  const textureStore = buildTextureIndex(config);
  app.disable('x-powered-by');

  app.get('/texture/:kind/:name.png', (req, res) => {
    const kind = safeTextureKey(req.params.kind);
    const name = safeTextureKey(req.params.name);
    if (!['block', 'entity'].includes(kind) || !name) return res.status(404).end();
    for (const alias of textureAliases(name)) {
      const file = textureStore.index.get(`${kind}/${alias}`) || textureStore.index.get(alias);
      if (!file) continue;
      res.setHeader('Cache-Control', 'public, max-age=3600');
      if (typeof file === 'string') return res.sendFile(file);
      const png = readTextureValue(file);
      if (!png) continue;
      res.type('png').send(png);
      return;
    }
    return res.status(404).end();
  });

  app.get('/state.json', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(getState());
  });

  app.get('/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`event: spectate\ndata: ${JSON.stringify(getState())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
  });

  app.get('/', (_req, res) => {
    res.type('html').send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>NexusPanel Bedrock Live</title>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#020712;color:#e5f6ff;font-family:Inter,Segoe UI,Arial,sans-serif}
#hud{position:fixed;left:14px;top:14px;z-index:3;display:grid;gap:7px;max-width:min(420px,calc(100vw - 28px));padding:13px 15px;background:rgba(2,8,18,.74);border:1px solid rgba(123,211,255,.24);border-radius:8px;backdrop-filter:blur(10px)}
#title{font-weight:850;color:#41e69b;letter-spacing:.02em}
#meta,#debug{font-size:12px;color:#b9c9d8;line-height:1.45}
#debug{position:fixed;right:14px;top:14px;left:auto;z-index:3;max-width:min(390px,calc(100vw - 28px));padding:12px 14px;background:rgba(2,8,18,.62);border:1px solid rgba(123,211,255,.18);border-radius:8px}
#reticle{position:fixed;left:50%;top:50%;width:26px;height:26px;margin:-13px 0 0 -13px;z-index:2;opacity:.78;pointer-events:none}
#reticle:before,#reticle:after{content:"";position:absolute;background:#eaffff;border-radius:2px}
#reticle:before{left:12px;top:0;width:2px;height:26px}
#reticle:after{left:0;top:12px;width:26px;height:2px}
#empty{position:fixed;left:50%;bottom:88px;transform:translateX(-50%);z-index:4;text-align:center;padding:12px 15px;background:rgba(2,8,18,.72);border:1px solid rgba(123,211,255,.22);border-radius:8px;display:none}
#controls{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);z-index:5;display:grid;grid-template-columns:54px 54px 54px;grid-template-rows:44px 44px;gap:6px}
#controls button{border:1px solid rgba(207,250,254,.36);background:rgba(4,18,24,.78);color:#eaffff;border-radius:8px;font:850 16px Inter,Segoe UI,Arial;box-shadow:0 8px 20px rgba(0,0,0,.25)}
#controls button:active{background:#41e69b;color:#04110b;transform:translateY(1px)}
#moveForward{grid-column:2;grid-row:1}
#moveLeft{grid-column:1;grid-row:2}
#moveBack{grid-column:2;grid-row:2}
#moveRight{grid-column:3;grid-row:2}
#verticalControls{position:fixed;right:14px;bottom:14px;z-index:5;display:grid;gap:6px}
#verticalControls button{width:54px;height:40px;border:1px solid rgba(207,250,254,.36);background:rgba(4,18,24,.78);color:#eaffff;border-radius:8px;font:850 14px Inter,Segoe UI,Arial}
canvas{display:block;touch-action:none}
@media(max-width:720px){#hud{font-size:13px;padding:10px 12px}#debug{position:fixed;top:auto;right:10px;left:10px;bottom:118px;max-width:none}#meta,#debug{font-size:11px}#verticalControls{right:10px;bottom:14px}}
</style>
</head>
<body>
<div id="hud"><div id="title">Bedrock Live Renderer</div><div id="meta">Starting viewer...</div></div>
<div id="debug"></div>
<div id="reticle"></div>
<div id="empty">No real terrain decoded yet<br><small>Only decoded Bedrock chunk packets are rendered here.</small></div>
<div id="controls" aria-label="Bot movement controls">
  <button id="moveForward" type="button" data-move="forward">W</button>
  <button id="moveLeft" type="button" data-move="left">A</button>
  <button id="moveBack" type="button" data-move="back">S</button>
  <button id="moveRight" type="button" data-move="right">D</button>
</div>
<div id="verticalControls" aria-label="Bot vertical controls">
  <button type="button" data-move="up">UP</button>
  <button type="button" data-move="down">DN</button>
</div>
<script>window.__NEXUS_INITIAL__=${jsonScript(getState())};</script>
<script>window.__NEXUS_TEXTURE_COUNT__=${textureStore.index.size};</script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
<script>
(() => {
  const meta = document.getElementById('meta');
  const debug = document.getElementById('debug');
  const empty = document.getElementById('empty');
  const controls = document.getElementById('controls');
  const verticalControls = document.getElementById('verticalControls');
  if (!window.THREE) {
    meta.textContent = 'Three.js could not load in this browser.';
    empty.style.display = 'block';
    return;
  }
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x79b7e8);
  scene.fog = new THREE.Fog(0x9cc9ee, 38, 190);
  const camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 0.05, 620);
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = false;
  document.body.appendChild(renderer.domElement);
  scene.add(new THREE.HemisphereLight(0xbfe7ff, 0x536c42, 1.15));
  const sun = new THREE.DirectionalLight(0xffffff, 1.05);
  sun.position.set(55, 95, 36);
  scene.add(sun);
  const world = new THREE.Group();
  scene.add(world);
  const entityGroup = new THREE.Group();
  scene.add(entityGroup);
  const textureLoader = new THREE.TextureLoader();
  const terrainMeshes = new Map();
  const entityMeshes = new Map();
  const materialCache = new Map();
  const textureCache = new Map();
  const pendingTextureLoads = new Set();
  let rendererError = '';
  const terrainHeights = new Map();
  let terrainBounds = null;
  let blockCount = 0;
  let faceCount = 0;
  let worldSignature = '';
  let state = window.__NEXUS_INITIAL__ || {};
  let lookYawOffset = 0;
  let lookPitchOffset = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  const colorFor = (column) => {
    if (typeof column.color === 'string' && /^#[0-9a-f]{6}$/i.test(column.color)) return Number('0x' + column.color.slice(1));
    const name = String(column.name || '').toLowerCase();
    if (name.includes('water')) return 0x2f7dd3;
    if (name.includes('grass') || name.includes('leaves')) return 0x54a948;
    if (name.includes('dirt') || name.includes('mud')) return 0x806348;
    if (name.includes('sand')) return 0xd9cb87;
    if (name.includes('snow')) return 0xecf4f5;
    if (name.includes('stone') || name.includes('ore')) return 0x81878c;
    if (name.includes('wood') || name.includes('log')) return 0x8b633e;
    return 0x6fb06a;
  };
  const textureFor = (color, name) => {
    const key = color + ':' + String(name || '').slice(0, 32);
    if (textureCache.has(key)) return textureCache.get(key);
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    const base = new THREE.Color(color);
    const shade = (amount) => {
      const c = base.clone().multiplyScalar(amount);
      return '#' + c.getHexString();
    };
    ctx.fillStyle = shade(1);
    ctx.fillRect(0, 0, 16, 16);
    const lower = String(name || '').toLowerCase();
    const topBand = lower.includes('grass') ? '#6dbd4b' : lower.includes('water') ? '#58a6e8' : shade(1.16);
    ctx.fillStyle = topBand;
    ctx.fillRect(0, 0, 16, lower.includes('grass') ? 4 : 2);
    for (let y = 0; y < 16; y += 2) {
      for (let x = 0; x < 16; x += 2) {
        const bit = ((x * 19 + y * 31 + key.length * 7) % 11);
        ctx.fillStyle = shade(bit < 4 ? 0.82 : bit > 8 ? 1.22 : 1);
        ctx.fillRect(x, y, 2, 2);
      }
    }
    ctx.strokeStyle = 'rgba(0,0,0,.24)';
    ctx.strokeRect(0.5, 0.5, 15, 15);
    const texture = new THREE.CanvasTexture(canvas);
    texture.magFilter = THREE.NearestFilter;
    texture.minFilter = THREE.NearestFilter;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    textureCache.set(key, texture);
    const blockName = encodeURIComponent(String(name || '').replace(/^minecraft:/, '').replace(/\.png$/i, ''));
    if (blockName && !pendingTextureLoads.has(key)) {
      pendingTextureLoads.add(key);
      textureLoader.load('texture/block/' + blockName + '.png', (realTexture) => {
        realTexture.magFilter = THREE.NearestFilter;
        realTexture.minFilter = THREE.NearestFilter;
        realTexture.wrapS = THREE.RepeatWrapping;
        realTexture.wrapT = THREE.RepeatWrapping;
        textureCache.set(key, realTexture);
        const material = materialCache.get(key);
        if (material) {
          material.map = realTexture;
          material.needsUpdate = true;
        }
      }, undefined, () => {});
    }
    return texture;
  };
  const materialFor = (column) => {
    const color = colorFor(column);
    const key = color + ':' + String(column.name || '').slice(0, 32);
    if (!materialCache.has(key)) {
      materialCache.set(key, new THREE.MeshLambertMaterial({
        color: 0xffffff,
        map: textureFor(color, column.name),
        side: THREE.DoubleSide,
      }));
    }
    return materialCache.get(key);
  };
  const applyEntitySkin = (materials) => {
    textureLoader.load('texture/entity/steve.png', (skin) => {
      skin.magFilter = THREE.NearestFilter;
      skin.minFilter = THREE.NearestFilter;
      for (const material of materials) {
        material.map = skin;
        material.needsUpdate = true;
      }
    }, undefined, () => {});
  };
  const materialKeyFor = (block) => colorFor(block) + ':' + String(block.name || '').slice(0, 32);
  const faceDefs = [
    { bit: 1, normal: [1, 0, 0], corners: [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]] },
    { bit: 2, normal: [-1, 0, 0], corners: [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]] },
    { bit: 4, normal: [0, 1, 0], corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]] },
    { bit: 8, normal: [0, -1, 0], corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]] },
    { bit: 16, normal: [0, 0, 1], corners: [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]] },
    { bit: 32, normal: [0, 0, -1], corners: [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]] },
  ];
  const blockRowsFromChunks = (chunks) => {
    const rows = [];
    for (const chunk of chunks) {
      const blocks = Array.isArray(chunk.geometry?.blocks) ? chunk.geometry.blocks : [];
      const columns = Array.isArray(chunk.geometry?.columns) ? chunk.geometry.columns : [];
      for (const block of blocks.length ? blocks : columns) rows.push(block);
    }
    return rows.slice(-80000);
  };
  const geometryForBlocks = (blocks) => {
    const positions = [];
    const normals = [];
    const uvs = [];
    const indices = [];
    let faces = 0;
    const uv = [[0, 0], [0, 1], [1, 1], [1, 0]];
    for (const block of blocks) {
      const mask = Number(block.faces || 63);
      const x = Number(block.x || 0);
      const y = Number(block.y || 64);
      const z = Number(block.z || 0);
      for (const face of faceDefs) {
        if (!(mask & face.bit)) continue;
        const base = positions.length / 3;
        for (let index = 0; index < 4; index += 1) {
          const corner = face.corners[index];
          positions.push(x + corner[0], y + corner[1], z + corner[2]);
          normals.push(face.normal[0], face.normal[1], face.normal[2]);
          uvs.push(uv[index][0], uv[index][1]);
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
        faces += 1;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    geometry.computeBoundingSphere();
    geometry.userData.faces = faces;
    return geometry;
  };
  const rebuildWorld = (rows, signature) => {
    if (signature === worldSignature) return;
    worldSignature = signature;
    for (const mesh of terrainMeshes.values()) {
      world.remove(mesh);
      mesh.geometry.dispose();
    }
    terrainMeshes.clear();
    terrainHeights.clear();
    terrainBounds = null;
    const buckets = new Map();
    for (const block of rows) {
      const hx = Math.floor(Number(block.x || 0));
      const hz = Math.floor(Number(block.z || 0));
      const by = Number(block.y || 0);
      const hkey = hx + ':' + hz;
      terrainHeights.set(hkey, Math.max(terrainHeights.get(hkey) ?? -9999, by));
      terrainBounds = terrainBounds ? {
        minX: Math.min(terrainBounds.minX, hx),
        maxX: Math.max(terrainBounds.maxX, hx),
        minY: Math.min(terrainBounds.minY, by),
        maxY: Math.max(terrainBounds.maxY, by),
        minZ: Math.min(terrainBounds.minZ, hz),
        maxZ: Math.max(terrainBounds.maxZ, hz),
      } : { minX: hx, maxX: hx, minY: by, maxY: by, minZ: hz, maxZ: hz };
      const key = materialKeyFor(block);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(block);
    }
    blockCount = rows.length;
    faceCount = 0;
    for (const blocks of buckets.values()) {
      const geometry = geometryForBlocks(blocks);
      faceCount += geometry.userData.faces || 0;
      const mesh = new THREE.Mesh(geometry, materialFor(blocks[0]));
      terrainMeshes.set(materialKeyFor(blocks[0]), mesh);
      world.add(mesh);
    }
  };
  const setState = (next) => {
    state = next || state || {};
    const chunks = Array.isArray(state.world?.chunks) ? state.world.chunks : [];
    const rows = blockRowsFromChunks(chunks);
    const signature = chunks.map((chunk) => [chunk.x, chunk.z, chunk.updatedAt, chunk.geometry?.blocks?.length || 0, chunk.geometry?.columns?.length || 0, chunk.palette?.map?.((item) => item.count).join('.') || ''].join(':')).join('|');
    rebuildWorld(rows, signature);
    const entities = Array.isArray(state.entities) ? state.entities : [];
    const entityKeys = new Set();
    for (const entity of entities) {
      const key = String(entity.id || entity.name || '');
      if (!key) continue;
      entityKeys.add(key);
      let mesh = entityMeshes.get(key);
      if (!mesh) {
        mesh = new THREE.Group();
        const bodyMaterial = new THREE.MeshLambertMaterial({ color: entity.self ? 0x2dd4bf : 0x2563eb });
        const limbMaterial = new THREE.MeshLambertMaterial({ color: entity.self ? 0x99f6e4 : 0x93c5fd });
        const skinMaterial = new THREE.MeshLambertMaterial({ color: entity.self ? 0xfde68a : 0xfbcfe8 });
        applyEntitySkin([bodyMaterial, limbMaterial, skinMaterial]);
        const body = new THREE.Mesh(new THREE.BoxGeometry(.62, .92, .32), bodyMaterial);
        body.castShadow = true;
        body.position.y = 1.05;
        const head = new THREE.Mesh(new THREE.BoxGeometry(.54, .54, .54), skinMaterial);
        head.castShadow = true;
        head.position.y = 1.78;
        const leftArm = new THREE.Mesh(new THREE.BoxGeometry(.18, .82, .2), limbMaterial);
        leftArm.position.set(-.48, 1.08, 0);
        const rightArm = new THREE.Mesh(new THREE.BoxGeometry(.18, .82, .2), limbMaterial);
        rightArm.position.set(.48, 1.08, 0);
        const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(.22, .78, .22), limbMaterial);
        leftLeg.position.set(-.18, .38, 0);
        const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(.22, .78, .22), limbMaterial);
        rightLeg.position.set(.18, .38, 0);
        const nameCanvas = document.createElement('canvas');
        nameCanvas.width = 256;
        nameCanvas.height = 48;
        const nameCtx = nameCanvas.getContext('2d');
        nameCtx.fillStyle = 'rgba(0,0,0,.58)';
        nameCtx.fillRect(0, 0, 256, 48);
        nameCtx.fillStyle = '#eaffff';
        nameCtx.font = '700 24px Inter,Segoe UI,Arial';
        nameCtx.textAlign = 'center';
        nameCtx.textBaseline = 'middle';
        nameCtx.fillText(String(entity.name || key).slice(0, 24), 128, 25);
        const nameTexture = new THREE.CanvasTexture(nameCanvas);
        const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: nameTexture, transparent: true, depthTest: false }));
        label.position.y = 2.35;
        label.scale.set(2.2, .42, 1);
        mesh.add(body, head, leftArm, rightArm, leftLeg, rightLeg, label);
        entityMeshes.set(key, mesh);
        entityGroup.add(mesh);
      }
      mesh.position.set(Number(entity.x || 0), Number(entity.y || 64), Number(entity.z || 0));
      mesh.rotation.y = -Number(entity.yaw || 0) * Math.PI / 180;
    }
    for (const [key, mesh] of entityMeshes) {
      if (!entityKeys.has(key)) {
        entityGroup.remove(mesh);
        entityMeshes.delete(key);
      }
    }
    const stats = state.world?.packetStats || {};
    const adapter = stats.adapter || {};
    meta.textContent = (state.serverName || 'Server') + ' - ' + (state.botName || 'live-update') + ' - ' + (state.status || 'waiting') + ' - blocks ' + blockCount + ' - faces ' + faceCount + ' - entities ' + entityMeshes.size;
    debug.textContent = 'chunks ' + chunks.length + ' decoded ' + (stats.renderPackets || 0) + ' hollow blocks ' + blockCount + ' faces ' + faceCount + ' source textures ' + (window.__NEXUS_TEXTURE_COUNT__ || 0) + ' active textures ' + textureCache.size + ' level_chunk ' + (stats.levelChunk || 0) + ' last ' + (stats.lastPacket || 'waiting') + (stats.adapterError || adapter.error ? ' - ' + (stats.adapterError || adapter.error) : '') + (rendererError ? ' - renderer ' + rendererError : '');
    empty.style.display = blockCount ? 'none' : 'block';
  };
  const focusEntity = () => {
    const entities = Array.isArray(state.entities) ? state.entities : [];
    const entity = entities.find((item) => item.name === state.target) || entities.find((item) => item.self) || entities[0];
    if (!terrainBounds) return entity || { x: 0, y: 64, z: 0 };
    const overview = () => ({
      x: (terrainBounds.minX + terrainBounds.maxX) / 2,
      y: terrainBounds.maxY + 5,
      z: (terrainBounds.minZ + terrainBounds.maxZ) / 2,
      yaw: 35,
      pitch: 25,
      overview: true,
    });
    if (!entity) return overview();
    const ex = Number(entity.x || 0);
    const ez = Number(entity.z || 0);
    const margin = 4;
    if (ex < terrainBounds.minX - margin || ex > terrainBounds.maxX + margin || ez < terrainBounds.minZ - margin || ez > terrainBounds.maxZ + margin) {
      return overview();
    }
    const localTerrainY = nearestTerrainY(ex, ez, 5);
    if (Number.isFinite(localTerrainY) && Number(entity.y || 64) < localTerrainY + 1) return overview();
    return entity;
  };
  const nearestTerrainY = (x, z, radius = 5) => {
    const ix = Math.floor(x);
    const iz = Math.floor(z);
    let best = -Infinity;
    for (let dx = -radius; dx <= radius; dx += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        const y = terrainHeights.get((ix + dx) + ':' + (iz + dz));
        if (Number.isFinite(y)) best = Math.max(best, y);
      }
    }
    return best;
  };
  const currentYaw = () => {
    const focus = focusEntity();
    return Number(focus.yaw || 0) * Math.PI / 180 + lookYawOffset;
  };
  const moveBot = (action) => {
    fetch('../control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, yaw: currentYaw() }),
      cache: 'no-store',
    }).catch(() => {});
  };
  controls.addEventListener('click', (event) => {
    const action = event.target?.dataset?.move;
    if (action) moveBot(action);
  });
  verticalControls.addEventListener('click', (event) => {
    const action = event.target?.dataset?.move;
    if (action) moveBot(action);
  });
  addEventListener('keydown', (event) => {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey) return;
    const key = event.key.toLowerCase();
    const action = key === 'w' ? 'forward' : key === 's' ? 'back' : key === 'a' ? 'left' : key === 'd' ? 'right' : key === ' ' ? 'up' : key === 'shift' ? 'down' : '';
    if (!action) return;
    event.preventDefault();
    moveBot(action);
  });
  const animate = () => {
    const focus = focusEntity();
    const fx = Number(focus.x || 0);
    const fz = Number(focus.z || 0);
    const terrainY = nearestTerrainY(fx, fz, focus.overview ? 16 : 5);
    const fy = Math.max(Number(focus.y || 64) + 1.4, Number.isFinite(terrainY) ? terrainY + (focus.overview ? 8 : 2.2) : -9999);
    const baseYaw = Number(focus.yaw || 0) * Math.PI / 180;
    const yaw = baseYaw + lookYawOffset;
    const pitch = Math.max(-1.18, Math.min(0.92, Number(focus.pitch || 0) * Math.PI / 180 + lookPitchOffset));
    camera.position.set(fx, fy, fz);
    camera.lookAt(
      fx + Math.sin(yaw) * Math.cos(pitch) * 32,
      fy - Math.sin(pitch) * 32,
      fz + Math.cos(yaw) * Math.cos(pitch) * 32,
    );
    renderer.render(scene, camera);
    requestAnimationFrame(animate);
  };
  renderer.domElement.addEventListener('pointerdown', (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    renderer.domElement.setPointerCapture?.(event.pointerId);
  });
  renderer.domElement.addEventListener('pointerup', () => { dragging = false; });
  renderer.domElement.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    lookYawOffset -= (event.clientX - lastX) * 0.006;
    lookPitchOffset = Math.max(-1.1, Math.min(1.1, lookPitchOffset + (event.clientY - lastY) * 0.004));
    lastX = event.clientX;
    lastY = event.clientY;
  });
  renderer.domElement.addEventListener('wheel', (event) => {
    camera.fov = Math.max(48, Math.min(92, camera.fov + event.deltaY * 0.018));
    camera.updateProjectionMatrix();
  }, { passive: true });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  addEventListener('error', (event) => { rendererError = String(event.message || 'browser error').slice(0, 160); });
  addEventListener('unhandledrejection', (event) => { rendererError = String(event.reason?.message || event.reason || 'promise error').slice(0, 160); });
  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    rendererError = 'WebGL context lost';
  });
  setState(state);
  try {
    const events = new EventSource('events');
    events.addEventListener('spectate', (event) => setState(JSON.parse(event.data || '{}')));
    events.onerror = () => {
      fetch('state.json', { cache: 'no-store' }).then((response) => response.json()).then(setState).catch(() => {});
    };
  } catch {
    setInterval(() => fetch('state.json', { cache: 'no-store' }).then((response) => response.json()).then(setState).catch(() => {}), 650);
  }
  animate();
})();
</script>
</body>
</html>`);
  });

  const server = app.listen(config.rendererPort, '127.0.0.1', () => {
    send('renderer', {
      status: 'ready',
      mode: 'bedrock-threejs-viewer',
      port: config.rendererPort,
      message: `Bedrock browser 3D renderer is live on port ${config.rendererPort}.`,
    });
  });
  server.on('error', (error) => {
    send('renderer', {
      status: 'error',
      mode: 'bedrock-threejs-viewer',
      port: config.rendererPort,
      message: `Bedrock browser renderer failed: ${error.message}`,
    });
  });
  const timer = setInterval(() => {
    const data = JSON.stringify(getState());
    for (const client of [...clients]) {
      try {
        client.write(`event: spectate\ndata: ${data}\n\n`);
      } catch {
        clients.delete(client);
      }
    }
  }, 500);
  timer.unref();
  return { server, clients, timer };
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
    enableChunkCaching: false,
    viewDistance: Math.max(3, Math.min(8, Number(config.viewDistance || 8))),
    profilesFolder,
  });
  const players = new Set();
  const entities = new Map();
  const blockUpdates = [];
  const adapter = new BedrockWorldAdapter({ version: config.version || config.protocolVersion || '' });
  const packetStats = {
    total: 0,
    levelChunk: 0,
    updateBlock: 0,
    geometryColumns: 0,
    geometryBlocks: 0,
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
  let bedrockViewer = null;

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
    const bytes = asBuffer(packet);
    packetStats.samples.push({
      name,
      keys: objectKeys(packet),
      bytes: bytes?.length || 0,
      hasChunkKey: Boolean(chunkCoords(packet)),
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
    send('world', {
      mode: 'bedrock-prismarine-adapter',
      chunks: adapter.world(),
      blockUpdates: blockUpdates.splice(0, blockUpdates.length).slice(-128),
      packetStats: { ...packetStats, adapter: adapter.status() },
    });
  };
  const viewerState = () => ({
    serverName: config.serverName || 'Bedrock Server',
    botName: config.username,
    status: connected ? 'connected' : 'connecting',
    target: config.target || config.username,
    players: [...players].map(cleanPlayerName).filter(Boolean),
    entities: [...entities.values()]
      .map((entity) => ({
        id: String(entity.id || entity.name || '').slice(0, 80),
        name: cleanPlayerName(entity.name || entity.id),
        x: finiteNumber(entity.x),
        y: finiteNumber(entity.y, 64),
        z: finiteNumber(entity.z),
        yaw: finiteNumber(entity.yaw),
        pitch: finiteNumber(entity.pitch),
        self: Boolean(entity.self),
        updatedAt: Number(entity.updatedAt || Date.now()),
      }))
      .filter((entity) => entity.name)
      .slice(0, 80),
    world: {
      mode: 'bedrock-prismarine-adapter',
      chunks: adapter.world().slice(-64),
      blockUpdates: blockUpdates.slice(-128),
      packetStats: { ...packetStats, adapter: adapter.status() },
      updatedAt: Date.now(),
    },
  });
  bedrockViewer = startBedrockBrowserViewer(config, viewerState);
  const rememberChunkPacket = async (packet) => {
    const bytes = asBuffer(packet);
    if (bytes?.length) packetStats.bytesTotal += bytes.length;
    const result = await adapter.ingestLevelChunk(packet);
    if (!result.decoded) {
      if (result.error) packetStats.adapterError = result.error;
      return;
    }
    packetStats.renderPackets += 1;
    packetStats.geometryColumns += result.chunk.geometry.columns.length;
    packetStats.geometryBlocks += result.chunk.geometry.blocks?.length || 0;
    packetStats.adapterError = '';
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
    if (packet && (normalized === 'level_chunk' || normalized === 'levelchunk')) {
      rememberChunkPacket(packet).catch((error) => {
        packetStats.adapterError = error.message;
      });
    }
    if (packet && /cache.*(?:blob|miss)|blob.*cache/i.test(normalized)) {
      const stored = adapter.ingestCacheBlobPacket(packet);
      if (stored) packetStats.cacheBlobs = Number(packetStats.cacheBlobs || 0) + stored;
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
    try { client.queue('client_cache_status', { enabled: false }); } catch {}
    setTimeout(() => {
      try { client.queue('request_chunk_radius', { chunk_radius: Math.max(3, Math.min(8, Number(config.viewDistance || 8))) }); } catch {}
    }, 250).unref();
    send('status', { status: 'connected', target: config.username, message: `Bedrock spectate bot joined ${config.host}:${config.port}.` });
    publishPlayers();
  };

  client.once('join', markConnected);
  client.once('start_game', markConnected);
  client.once('spawn', markConnected);
  client.on('add_player', (packet) => {
    const id = packetEntityId(packet) || packet?.username;
    const name = packet?.username || packet?.name || packet?.display_name || id || '';
    if (cleanPlayerName(name) === cleanPlayerName(config.username)) markConnected(packet);
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
        if (cleanPlayerName(record.username) === cleanPlayerName(config.username)) markConnected(record);
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
    closeViewer(bedrockViewer);
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
    closeViewer(bedrockViewer);
    send('status', { status: 'stopped', message: 'Bedrock spectate bot connection closed.' });
    process.exit(0);
  });

  process.on('message', (message) => {
    if (message?.type === 'local-move' && message.entity) {
      rememberEntity(message.entity.id || message.entity.name || config.username, {
        ...message.entity,
        name: message.entity.name || config.username,
        self: true,
      });
      publishEntities();
    }
    if (message?.type === 'target') {
      config.target = cleanPlayerName(message.target);
      send('status', { status: 'connected', target: config.target, message: `Following ${config.target || 'overview'}.` });
    }
    if (message?.type === 'stop') {
      closeViewer(bedrockViewer);
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
