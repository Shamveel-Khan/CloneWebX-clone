// Minimal dependency-free ZIP writer (STORE method, no compression).
// Assets are already-compressed images, so STORE keeps the archive valid
// and the code tiny. Works in service workers, pages and Node (Blob is global).

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    (Math.floor(date.getSeconds() / 2) & 0x1f);
  const day =
    (((date.getFullYear() - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0xf) << 5) |
    (date.getDate() & 0x1f);
  return { time, day };
}

export function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

/**
 * Build a ZIP archive.
 * @param {Array<{name: string, data: Uint8Array|string}>} entries
 * @param {Date} [modDate]
 * @returns {Blob}
 */
export function buildZip(entries, modDate = new Date()) {
  const { time, day } = dosDateTime(modDate);
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = utf8Bytes(entry.name);
    const data = typeof entry.data === 'string' ? utf8Bytes(entry.data) : entry.data;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: UTF-8 filenames
    lv.setUint16(8, 0, true); // method: STORE
    lv.setUint16(10, time, true);
    lv.setUint16(12, day, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true); // compressed size
    lv.setUint32(22, data.length, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    local.set(nameBytes, 30);

    chunks.push(local, data);
    central.push({ nameBytes, crc, size: data.length, offset });
    offset += local.length + data.length;
  }

  const cdStart = offset;
  for (const e of central) {
    const h = new Uint8Array(46 + e.nameBytes.length);
    const v = new DataView(h.buffer);
    v.setUint32(0, 0x02014b50, true); // central directory signature
    v.setUint16(4, 20, true); // version made by
    v.setUint16(6, 20, true); // version needed
    v.setUint16(8, 0x0800, true); // flags
    v.setUint16(10, 0, true); // method
    v.setUint16(12, time, true);
    v.setUint16(14, day, true);
    v.setUint32(16, e.crc, true);
    v.setUint32(20, e.size, true);
    v.setUint32(24, e.size, true);
    v.setUint16(28, e.nameBytes.length, true);
    // extra len (30), comment len (32), disk start (34), internal attrs (36) = 0
    v.setUint32(38, 0, true); // external attrs
    v.setUint32(42, e.offset, true); // local header offset
    h.set(e.nameBytes, 46);

    chunks.push(h);
    offset += h.length;
  }
  const cdSize = offset - cdStart;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // EOCD signature
  ev.setUint16(8, central.length, true); // entries this disk
  ev.setUint16(10, central.length, true); // total entries
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  ev.setUint16(20, 0, true); // comment length
  chunks.push(eocd);

  return new Blob(chunks, { type: 'application/zip' });
}
