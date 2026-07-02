const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = Math.max(1980, date.getFullYear()) - 1980;
  return { date: (year << 9) | (month << 5) | day, time };
}

function transientFileError(error) {
  return ['ENOENT', 'ESTALE', 'EISDIR'].includes(error?.code);
}

async function collectEntries(root, relativePath) {
  const absolute = path.join(root, relativePath);
  let stats;
  try {
    stats = await fs.promises.lstat(absolute);
  } catch (error) {
    if (transientFileError(error)) return [];
    throw error;
  }
  if (stats.isSymbolicLink()) return [];
  if (stats.isDirectory()) {
    let children;
    try {
      children = await fs.promises.readdir(absolute);
    } catch (error) {
      if (transientFileError(error)) return [];
      throw error;
    }
    const nested = [];
    for (const child of children) {
      nested.push(...await collectEntries(root, path.posix.join(relativePath.replaceAll('\\', '/'), child)));
    }
    return nested;
  }
  return stats.isFile() ? [{ absolute, relative: relativePath.replaceAll('\\', '/'), stats }] : [];
}

function deflate(buffer) {
  return new Promise((resolve, reject) => {
    zlib.deflateRaw(buffer, { level: 6 }, (error, compressed) => {
      if (error) reject(error);
      else resolve(compressed);
    });
  });
}

async function writeBuffer(file, buffer) {
  let position = 0;
  while (position < buffer.length) {
    const { bytesWritten } = await file.write(buffer, position, buffer.length - position);
    if (!bytesWritten) throw new Error('Archive write stopped before the ZIP was complete.');
    position += bytesWritten;
  }
}

async function createZip(root, relativePaths, outputPath) {
  const requested = relativePaths.length ? relativePaths : [''];
  const entries = [];
  for (const item of requested) entries.push(...await collectEntries(root, item));

  const temporary = `${outputPath}.${process.pid}.${Date.now()}.partial`;
  const central = [];
  let output;
  let offset = 0;
  let written = 0;
  let skipped = 0;

  try {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    output = await fs.promises.open(temporary, 'w', 0o600);
    for (const entry of entries) {
      let raw;
      try {
        raw = await fs.promises.readFile(entry.absolute);
      } catch (error) {
        if (transientFileError(error)) {
          skipped += 1;
          continue;
        }
        throw error;
      }
      const compressed = await deflate(raw);
      const name = Buffer.from(entry.relative || path.basename(entry.absolute));
      const crc = crc32(raw);
      const stamp = dosDateTime(entry.stats.mtime);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt16LE(0x800, 6);
      local.writeUInt16LE(8, 8);
      local.writeUInt16LE(stamp.time, 10);
      local.writeUInt16LE(stamp.date, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(compressed.length, 18);
      local.writeUInt32LE(raw.length, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(0, 28);
      await writeBuffer(output, local);
      await writeBuffer(output, name);
      await writeBuffer(output, compressed);

      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x800, 8);
      header.writeUInt16LE(8, 10);
      header.writeUInt16LE(stamp.time, 12);
      header.writeUInt16LE(stamp.date, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(compressed.length, 20);
      header.writeUInt32LE(raw.length, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt16LE(0, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(offset, 42);
      central.push(header, name);
      offset += local.length + name.length + compressed.length;
      written += 1;
    }

    const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
    for (const chunk of central) await writeBuffer(output, chunk);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(written, 8);
    end.writeUInt16LE(written, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(offset, 16);
    end.writeUInt16LE(0, 20);
    await writeBuffer(output, end);
    await output.sync();
    await output.close();
    output = null;
    await fs.promises.rename(temporary, outputPath);
    return { entries: written, skipped };
  } catch (error) {
    await output?.close().catch(() => {});
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { createZip };
