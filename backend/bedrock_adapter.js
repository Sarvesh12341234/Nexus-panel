function loadOptional(name) {
  try {
    return require(name);
  } catch (error) {
    return null;
  }
}

function asBuffer(value, depth = 0, seen = new Set()) {
  if (!value || depth > 5 || seen.has(value)) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = asBuffer(item, depth + 1, seen);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  seen.add(value);
  for (const key of ['payload', 'data', 'blob', 'sub_chunk_data', 'cache_blobs', 'raw_payload', 'buffer']) {
    const found = asBuffer(value[key], depth + 1, seen);
    if (found) return found;
  }
  for (const item of Object.values(value)) {
    const found = asBuffer(item, depth + 1, seen);
    if (found) return found;
  }
  return null;
}

function numberFrom(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return NaN;
}

function chunkCoords(packet) {
  const x = numberFrom(packet?.x, packet?.chunk_x, packet?.chunkX, packet?.chunk_position?.x, packet?.chunkPosition?.x);
  const z = numberFrom(packet?.z, packet?.chunk_z, packet?.chunkZ, packet?.chunk_position?.z, packet?.chunkPosition?.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  return { x: Math.trunc(x), z: Math.trunc(z), key: `${Math.trunc(x)},${Math.trunc(z)}` };
}

function packetSectionCount(packet) {
  return Math.max(0, Math.trunc(numberFrom(
    packet?.sub_chunk_count,
    packet?.subChunkCount,
    packet?.section_count,
    packet?.sectionCount,
    packet?.sections?.length,
    24,
  )));
}

function adapterVersionCandidates(version) {
  const clean = String(version || '').trim();
  const base = clean.replace(/^v/i, '').replace(/[^\d.]/g, '');
  const parts = base.split('.').filter(Boolean);
  const candidates = [];
  if (base) {
    candidates.push(`bedrock_${base}`);
    candidates.push(base);
  }
  if (parts.length >= 2) candidates.push(`bedrock_${parts[0]}.${parts[1]}.0`);
  candidates.push('bedrock_1.21.0', 'bedrock_1.20.80', 'bedrock_1.20.0', '1.20.0');
  return [...new Set(candidates)];
}

function blockColor(name, stateId = 0) {
  const key = String(name || '').toLowerCase();
  if (!key || key.includes('air')) return null;
  if (key.includes('grass_block')) return '#5ca044';
  if (key === 'grass' || key.endsWith('_grass')) return '#65b34f';
  if (key.includes('water')) return '#3b82f6';
  if (key.includes('lava')) return '#fb5d22';
  if (key.includes('leaves')) return '#4f9c42';
  if (key.includes('vine') || key.includes('moss')) return '#58a84b';
  if (key.includes('dirt') || key.includes('mud')) return '#7a5236';
  if (key.includes('podzol')) return '#73513a';
  if (key.includes('sand')) return '#d7c278';
  if (key.includes('gravel')) return '#8f8f87';
  if (key.includes('snow') || key.includes('ice')) return '#dceff7';
  if (key.includes('wood') || key.includes('log') || key.includes('planks')) return '#9a6a3a';
  if (key.includes('netherrack')) return '#7b2c2f';
  if (key.includes('stone') || key.includes('ore') || key.includes('deepslate') || key.includes('cobble')) return '#7f858b';
  if (key.includes('glass')) return '#a7d8e8';
  const hue = Math.abs(Number(stateId || 0) * 37) % 360;
  return `hsl(${hue} 42% 52%)`;
}

function normalizeBlock(block) {
  const name = block?.name || block?.displayName || block?.type || '';
  const stateId = Number(block?.stateId ?? block?.state_id ?? block?.type ?? 0) || 0;
  return {
    name: String(name || `state_${stateId}`).replace(/^minecraft:/, '').slice(0, 80),
    stateId,
    color: blockColor(name, stateId),
  };
}

function normalizePaletteBlock(block) {
  const name = block?.name || block?.displayName || '';
  const stateId = Number(block?.stateId ?? block?.state_id ?? 0) || 0;
  return {
    name: String(name || `state_${stateId}`).replace(/^minecraft:/, '').slice(0, 80),
    stateId,
    color: blockColor(name, stateId),
  };
}

function getBlockSafe(chunk, x, y, z) {
  try {
    return normalizeBlock(chunk.getBlock({ x, y, z, l: 0 }, true));
  } catch {
    return null;
  }
}

function chunkYBounds(chunk) {
  const minY = Number.isFinite(Number(chunk.minY))
    ? Math.trunc(Number(chunk.minY))
    : Number.isFinite(Number(chunk.minCY))
      ? Math.trunc(Number(chunk.minCY)) * 16
      : -64;
  const maxY = Number.isFinite(Number(chunk.maxY))
    ? Math.trunc(Number(chunk.maxY)) - 1
    : Number.isFinite(Number(chunk.maxCY))
      ? Math.trunc(Number(chunk.maxCY)) * 16 - 1
      : 319;
  return { minY, maxY };
}

function sectionYAt(chunk, section, index) {
  if (Number.isFinite(Number(section?.y))) return Math.trunc(Number(section.y));
  if (Number.isFinite(Number(chunk?.co))) return Math.trunc(index - Number(chunk.co));
  if (Number.isFinite(Number(chunk?.minCY))) return Math.trunc(Number(chunk.minCY) + index);
  return index;
}

function sectionInfo(chunk) {
  const infos = [];
  const airState = Number(chunk.registry?.blocksByName?.air?.defaultState ?? 0);
  for (const [index, section] of (chunk.sections || []).entries()) {
    const storage = section?.blocks?.[0];
    const palette = section?.palette?.[0];
    if (!storage || !Array.isArray(palette) || !palette.length) continue;
    const hasSolid = palette.some((block) => block && Number(block.stateId ?? 0) !== airState && blockColor(block.name, block.stateId));
    if (!hasSolid) continue;
    infos.push({
      y: sectionYAt(chunk, section, index),
      storage,
      palette,
    });
  }
  return infos.sort((a, b) => b.y - a.y);
}

const FACE_BITS = {
  px: 1,
  nx: 2,
  py: 4,
  ny: 8,
  pz: 16,
  nz: 32,
};

class BedrockWorldAdapter {
  constructor({ version = '' } = {}) {
    this.version = version;
    this.registry = null;
    this.Chunk = null;
    this.blobStore = new Map();
    this.chunks = new Map();
    this.lastError = '';
    this.ready = false;
    this.init();
  }

  init() {
    const registryLoader = loadOptional('prismarine-registry');
    const chunkLoader = loadOptional('prismarine-chunk');
    if (!registryLoader || !chunkLoader) {
      this.lastError = 'Install Bedrock chunk adapter modules: cd /opt/nexuspanel && npm install prismarine-chunk prismarine-registry';
      return;
    }
    for (const candidate of adapterVersionCandidates(this.version)) {
      try {
        this.registry = registryLoader(candidate);
        this.Chunk = chunkLoader(this.registry);
        this.ready = true;
        this.version = candidate;
        return;
      } catch (error) {
        this.lastError = error.message;
      }
    }
  }

  async ingestLevelChunk(packet) {
    if (!this.ready || !this.Chunk) return { ok: false, error: this.lastError, decoded: false };
    const coords = chunkCoords(packet);
    const payload = asBuffer(packet);
    if (!coords || !payload?.length) return { ok: false, error: 'level_chunk packet did not include chunk coordinates and payload bytes.', decoded: false };
    const chunk = new this.Chunk({ x: coords.x, z: coords.z });
    try {
      const blobs = Array.isArray(packet.blobs) ? packet.blobs : Array.isArray(packet.blob_hashes) ? packet.blob_hashes : [];
      if (blobs.length && typeof chunk.networkDecode === 'function') {
        const missing = await chunk.networkDecode(blobs, this.blobStore, payload);
        if (Array.isArray(missing) && missing.length) {
          return { ok: false, error: `Chunk uses ${missing.length} missing cache blob(s).`, decoded: false };
        }
      } else if (typeof chunk.networkDecodeNoCache === 'function') {
        await chunk.networkDecodeNoCache(payload, packetSectionCount(packet));
      } else {
        return { ok: false, error: 'Installed prismarine-chunk does not expose Bedrock network decode.', decoded: false };
      }
      const decoded = this.extractGeometry(coords, chunk, payload.length);
      this.chunks.set(coords.key, decoded);
      if (this.chunks.size > 48) this.chunks.delete(this.chunks.keys().next().value);
      return { ok: true, decoded: true, chunk: decoded };
    } catch (error) {
      this.lastError = error.message;
      return { ok: false, error: error.message, decoded: false };
    }
  }

  ingestCacheBlobPacket(packet) {
    const rows = Array.isArray(packet?.blobs) ? packet.blobs
      : Array.isArray(packet?.cache_blobs) ? packet.cache_blobs
        : Array.isArray(packet?.entries) ? packet.entries
          : [];
    let stored = 0;
    for (const row of rows) {
      const hash = row?.hash ?? row?.blob_id ?? row?.id ?? row?.key;
      const payload = asBuffer(row?.payload ?? row?.data ?? row?.blob ?? row);
      if (hash === undefined || !payload?.length) continue;
      this.blobStore.set(hash, payload);
      stored += 1;
    }
    return stored;
  }

  extractGeometry(coords, chunk, size) {
    const columns = [];
    const blocks = [];
    const blockKeys = new Set();
    const names = new Map();
    const { minY, maxY } = chunkYBounds(chunk);
    const sections = sectionInfo(chunk);
    const heights = Array.from({ length: 16 }, () => Array(16).fill(minY - 1));
    const sectionByY = new Map(sections.map((section) => [section.y, section]));

    const readFast = (x, y, z) => {
      const info = sectionByY.get(y >> 4);
      if (!info) return null;
      return normalizePaletteBlock(info.palette[info.storage.get(x, y & 0xf, z)]);
    };
    const isSolidAt = (x, y, z) => {
      if (x < 0 || x > 15 || z < 0 || z > 15 || y < minY || y > maxY) return false;
      return Boolean(readFast(x, y, z)?.color);
    };

    const addBlock = (x, y, z, normalized) => {
      if (!normalized?.color) return;
      const worldX = coords.x * 16 + x;
      const worldZ = coords.z * 16 + z;
      const key = `${worldX}:${y}:${worldZ}:${normalized.stateId}`;
      if (blockKeys.has(key)) return;
      blockKeys.add(key);
      names.set(normalized.name, (names.get(normalized.name) || 0) + 1);
      blocks.push({
        key,
        x: worldX,
        y,
        z: worldZ,
        real: true,
        name: normalized.name,
        stateId: normalized.stateId,
        color: normalized.color,
        faces: 0,
      });
    };

    for (const section of sections) {
      const sectionTop = Math.min(maxY, section.y * 16 + 15);
      const sectionBottom = Math.max(minY, section.y * 16);
      for (let y = sectionTop; y >= sectionBottom; y -= 1) {
        for (let x = 0; x < 16; x += 1) {
          for (let z = 0; z < 16; z += 1) {
            const normalized = normalizePaletteBlock(section.palette[section.storage.get(x, y & 0xf, z)]);
            if (!normalized.color) continue;
            let faces = 0;
            if (!isSolidAt(x + 1, y, z)) faces |= FACE_BITS.px;
            if (!isSolidAt(x - 1, y, z)) faces |= FACE_BITS.nx;
            if (!isSolidAt(x, y + 1, z)) faces |= FACE_BITS.py;
            if (!isSolidAt(x, y - 1, z)) faces |= FACE_BITS.ny;
            if (!isSolidAt(x, y, z + 1)) faces |= FACE_BITS.pz;
            if (!isSolidAt(x, y, z - 1)) faces |= FACE_BITS.nz;
            if (!faces) continue;
            addBlock(x, y, z, normalized);
            blocks[blocks.length - 1].faces = faces;
            if (y > heights[x][z]) {
              heights[x][z] = y;
              columns.push({
                x: coords.x * 16 + x,
                y,
                z: coords.z * 16 + z,
                h: 1,
                d: 1,
                real: true,
                name: normalized.name,
                stateId: normalized.stateId,
                color: normalized.color,
              });
            }
          }
        }
      }
    }

    blocks.sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.z - b.z));
    return {
      x: coords.x,
      z: coords.z,
      source: 'bedrock-adapter',
      size,
      updatedAt: Date.now(),
      geometry: {
        bytesRead: size,
        columns,
        blocks: blocks.filter((block) => block.faces).slice(-8192),
      },
      palette: [...names.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([name, count]) => ({ name, count })),
    };
  }

  status() {
    return {
      ready: this.ready,
      version: this.version,
      chunks: this.chunks.size,
      error: this.lastError,
    };
  }

  world() {
    return [...this.chunks.values()];
  }
}

module.exports = { BedrockWorldAdapter, asBuffer, chunkCoords };
