const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Transform, Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const crcTable = new Uint32Array(256).map((_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function updateCrc32(crc, buffer) {
  let value = crc;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return value >>> 0;
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

async function writeBuffer(file, buffer) {
  let position = 0;
  while (position < buffer.length) {
    const { bytesWritten } = await file.write(buffer, position, buffer.length - position);
    if (!bytesWritten) throw new Error('Archive write stopped before the ZIP was complete.');
    position += bytesWritten;
  }
}

async function createZip(root, relativePaths, outputPath, options = {}) {
  const requested = relativePaths.length ? relativePaths : [''];
  const entries = [];
  for (const item of requested) entries.push(...await collectEntries(root, item));

  const temporary = `${outputPath}.${process.pid}.${Date.now()}.partial`;
  const central = [];
  let output;
  let offset = 0n;
  let written = 0;
  let skipped = 0;
  const totalEntries = entries.length;
  const reportProgress = (progress) => {
    try { options.onProgress?.({ ...progress, totalEntries }); } catch {}
  };
  reportProgress({ completedEntries: 0, percent: totalEntries ? 0 : 100, phase: 'scanning' });

  try {
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    output = await fs.promises.open(temporary, 'w', 0o600);
    for (const entry of entries) {
      let sourceFile;
      try {
        sourceFile = await fs.promises.open(entry.absolute, 'r');
      } catch (error) {
        if (transientFileError(error)) {
          skipped += 1;
          continue;
        }
        throw error;
      }
      const name = Buffer.from(entry.relative || path.basename(entry.absolute));
      const stamp = dosDateTime(entry.stats.mtime);

      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(45, 4);
      local.writeUInt16LE(0x808, 6);
      local.writeUInt16LE(8, 8);
      local.writeUInt16LE(stamp.time, 10);
      local.writeUInt16LE(stamp.date, 12);
      local.writeUInt32LE(0, 14);
      local.writeUInt32LE(0xffffffff, 18);
      local.writeUInt32LE(0xffffffff, 22);
      local.writeUInt16LE(name.length, 26);
      local.writeUInt16LE(20, 28);
      const localExtra = Buffer.alloc(20);
      localExtra.writeUInt16LE(0x0001, 0);
      localExtra.writeUInt16LE(16, 2);
      await writeBuffer(output, local);
      await writeBuffer(output, name);
      await writeBuffer(output, localExtra);

      let crc = 0xffffffff;
      let rawSize = 0n;
      let compressedSize = 0n;
      const checksum = new Transform({
        transform(chunk, encoding, callback) {
          crc = updateCrc32(crc, chunk);
          rawSize += BigInt(chunk.length);
          callback(null, chunk);
        },
      });
      const compressedOutput = new Writable({
        write(chunk, encoding, callback) {
          compressedSize += BigInt(chunk.length);
          writeBuffer(output, chunk).then(() => callback(), callback);
        },
      });
      try {
        await pipeline(
          sourceFile.createReadStream({ autoClose: false }),
          checksum,
          zlib.createDeflateRaw({ level: 6 }),
          compressedOutput,
        );
      } finally {
        await sourceFile.close();
      }
      crc = (crc ^ 0xffffffff) >>> 0;

      const descriptor = Buffer.alloc(24);
      descriptor.writeUInt32LE(0x08074b50, 0);
      descriptor.writeUInt32LE(crc, 4);
      descriptor.writeBigUInt64LE(compressedSize, 8);
      descriptor.writeBigUInt64LE(rawSize, 16);
      await writeBuffer(output, descriptor);

      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE(45, 4);
      header.writeUInt16LE(45, 6);
      header.writeUInt16LE(0x808, 8);
      header.writeUInt16LE(8, 10);
      header.writeUInt16LE(stamp.time, 12);
      header.writeUInt16LE(stamp.date, 14);
      header.writeUInt32LE(crc, 16);
      header.writeUInt32LE(0xffffffff, 20);
      header.writeUInt32LE(0xffffffff, 24);
      header.writeUInt16LE(name.length, 28);
      header.writeUInt16LE(28, 30);
      header.writeUInt16LE(0, 32);
      header.writeUInt16LE(0, 34);
      header.writeUInt16LE(0, 36);
      header.writeUInt32LE(0, 38);
      header.writeUInt32LE(0xffffffff, 42);
      const centralExtra = Buffer.alloc(28);
      centralExtra.writeUInt16LE(0x0001, 0);
      centralExtra.writeUInt16LE(24, 2);
      centralExtra.writeBigUInt64LE(rawSize, 4);
      centralExtra.writeBigUInt64LE(compressedSize, 12);
      centralExtra.writeBigUInt64LE(offset, 20);
      central.push(header, name, centralExtra);
      offset += BigInt(local.length + name.length + localExtra.length + descriptor.length) + compressedSize;
      written += 1;
      reportProgress({ completedEntries: written + skipped, percent: totalEntries ? Math.min(99, Math.floor(((written + skipped) / totalEntries) * 100)) : 100, phase: 'compressing' });
    }

    const centralOffset = offset;
    const centralSize = BigInt(central.reduce((sum, chunk) => sum + chunk.length, 0));
    for (const chunk of central) await writeBuffer(output, chunk);

    const zip64End = Buffer.alloc(56);
    zip64End.writeUInt32LE(0x06064b50, 0);
    zip64End.writeBigUInt64LE(44n, 4);
    zip64End.writeUInt16LE(45, 12);
    zip64End.writeUInt16LE(45, 14);
    zip64End.writeUInt32LE(0, 16);
    zip64End.writeUInt32LE(0, 20);
    zip64End.writeBigUInt64LE(BigInt(written), 24);
    zip64End.writeBigUInt64LE(BigInt(written), 32);
    zip64End.writeBigUInt64LE(centralSize, 40);
    zip64End.writeBigUInt64LE(centralOffset, 48);
    await writeBuffer(output, zip64End);

    const zip64Locator = Buffer.alloc(20);
    zip64Locator.writeUInt32LE(0x07064b50, 0);
    zip64Locator.writeUInt32LE(0, 4);
    zip64Locator.writeBigUInt64LE(offset + centralSize, 8);
    zip64Locator.writeUInt32LE(1, 16);
    await writeBuffer(output, zip64Locator);

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(0xffff, 8);
    end.writeUInt16LE(0xffff, 10);
    end.writeUInt32LE(0xffffffff, 12);
    end.writeUInt32LE(0xffffffff, 16);
    end.writeUInt16LE(0, 20);
    await writeBuffer(output, end);
    await output.sync();
    await output.close();
    output = null;
    await fs.promises.rename(temporary, outputPath);
    reportProgress({ completedEntries: totalEntries, percent: 100, phase: 'complete' });
    return { entries: written, skipped };
  } catch (error) {
    await output?.close().catch(() => {});
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = { createZip };
