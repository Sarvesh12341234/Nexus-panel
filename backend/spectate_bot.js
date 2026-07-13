const path = require('node:path');
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

function objectKeys(value) {
  return value && typeof value === 'object' && !Buffer.isBuffer(value)
    ? Object.keys(value).slice(0, 12)
    : [];
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
  app.disable('x-powered-by');

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
  const terrainMeshes = new Map();
  const entityMeshes = new Map();
  const materialCache = new Map();
  const textureCache = new Map();
  const terrainHeights = new Map();
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
    const buckets = new Map();
    for (const block of rows) {
      const hx = Math.floor(Number(block.x || 0));
      const hz = Math.floor(Number(block.z || 0));
      const hkey = hx + ':' + hz;
      terrainHeights.set(hkey, Math.max(terrainHeights.get(hkey) ?? -9999, Number(block.y || 0)));
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
        const body = new THREE.Mesh(new THREE.BoxGeometry(.65, 1.55, .38), new THREE.MeshLambertMaterial({ color: entity.self ? 0x41e69b : 0x60a5fa }));
        body.castShadow = true;
        body.position.y = .78;
        const head = new THREE.Mesh(new THREE.BoxGeometry(.62, .62, .62), new THREE.MeshLambertMaterial({ color: entity.self ? 0xa7f3d0 : 0xbfdbfe }));
        head.castShadow = true;
        head.position.y = 1.82;
        mesh.add(body, head);
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
    debug.textContent = 'chunks ' + chunks.length + ' decoded ' + (stats.renderPackets || 0) + ' hollow blocks ' + blockCount + ' faces ' + faceCount + ' level_chunk ' + (stats.levelChunk || 0) + ' last ' + (stats.lastPacket || 'waiting') + (stats.adapterError || adapter.error ? ' - ' + (stats.adapterError || adapter.error) : '');
    empty.style.display = blockCount ? 'none' : 'block';
  };
  const focusEntity = () => {
    const entities = Array.isArray(state.entities) ? state.entities : [];
    return entities.find((item) => item.name === state.target) || entities.find((item) => item.self) || entities[0] || { x: 0, y: 64, z: 0 };
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
    const terrainY = terrainHeights.get(Math.floor(fx) + ':' + Math.floor(Number(focus.z || 0)));
    const fy = Math.max(Number(focus.y || 64) + 1.4, Number.isFinite(terrainY) ? terrainY + 2.2 : -9999);
    const fz = Number(focus.z || 0);
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
