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
  if (key.includes('water')) return '#3b82f6';
  if (key.includes('lava')) return '#fb5d22';
  if (key.includes('grass') || key.includes('leaves') || key.includes('vine') || key.includes('moss')) return '#58a84b';
  if (key.includes('dirt') || key.includes('mud')) return '#7a5236';
  if (key.includes('sand')) return '#d7c278';
  if (key.includes('snow') || key.includes('ice')) return '#dceff7';
  if (key.includes('wood') || key.includes('log') || key.includes('planks')) return '#9a6a3a';
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
      const decoded = this.extractSurface(coords, chunk, payload.length);
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

  extractSurface(coords, chunk, size) {
    const columns = [];
    const names = new Map();
    const minY = Number.isFinite(Number(chunk.minCY)) ? Math.trunc(Number(chunk.minCY)) * 16 : -64;
    const maxY = Number.isFinite(Number(chunk.maxCY)) ? Math.trunc(Number(chunk.maxCY)) * 16 + 15 : 319;
    for (let x = 0; x < 16; x += 1) {
      for (let z = 0; z < 16; z += 1) {
        let column = null;
        for (let y = maxY; y >= minY; y -= 1) {
          let block;
          try {
            block = chunk.getBlock({ x, y, z, l: 0 }, true);
          } catch {
            continue;
          }
          const normalized = normalizeBlock(block);
          if (!normalized.color) continue;
          names.set(normalized.name, (names.get(normalized.name) || 0) + 1);
          column = {
            x: coords.x * 16 + x,
            y,
            z: coords.z * 16 + z,
            h: 1,
            d: 1,
            real: true,
            name: normalized.name,
            stateId: normalized.stateId,
            color: normalized.color,
          };
          break;
        }
        if (column) columns.push(column);
      }
    }
    return {
      x: coords.x,
      z: coords.z,
      source: 'bedrock-adapter',
      size,
      updatedAt: Date.now(),
      geometry: {
        bytesRead: size,
        columns,
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
