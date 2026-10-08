import { coreError } from "./errors";

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

// ---------- CRC32 ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------- Stream helpers ----------
// Compression goes through the platform CompressionStream/DecompressionStream
// (browsers and Node >= 18), so there is no bundled deflate implementation.
type StreamCtor = new (format: CompressionFormat) => GenericTransformStream;

async function pipeThrough(bytes: Uint8Array, TransformCls: StreamCtor, mode: CompressionFormat): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new TransformCls(mode));
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); total += value.length;
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) { out.set(ch, off); off += ch.length; }
  return out;
}
const inflateRaw = (b: Uint8Array) => pipeThrough(b, DecompressionStream, "deflate-raw");
const deflateRaw = (b: Uint8Array) => pipeThrough(b, CompressionStream, "deflate-raw");

// ---------- Read ZIP ----------
export async function unzipAll(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Search for the end-of-central-directory record from the back
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65536); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw coreError("ERR_NO_EOCD");
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const files = new Map<string, { method: number; comp: Uint8Array }>();
  const td = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) throw coreError("ERR_ZIP_CDIR");
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const cmtLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = td.decode(bytes.subarray(off + 46, off + 46 + nameLen));
    // The local header has its own name/extra lengths, which can differ from the
    // central directory's.
    const lNameLen = dv.getUint16(lho + 26, true);
    const lExtraLen = dv.getUint16(lho + 28, true);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const comp = bytes.subarray(dataStart, dataStart + csize);
    files.set(name, { method, comp });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  const out = new Map<string, Uint8Array>();
  for (const [name, f] of files) {
    if (name.endsWith("/")) continue;
    out.set(name, f.method === 0 ? f.comp : await inflateRaw(f.comp));
  }
  return out;
}

// ---------- Write ZIP ----------
export async function zipAll(entries: ZipEntry[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const te = new TextEncoder();
  for (const e of entries) {
    const nameB = te.encode(e.name);
    const crc = crc32(e.data);
    const comp = await deflateRaw(e.data);
    const useComp = comp.length < e.data.length;
    const payload = useComp ? comp : e.data;
    const method = useComp ? 8 : 0;
    const lh = new Uint8Array(30 + nameB.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);        // version needed
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, payload.length, true);
    lv.setUint32(22, e.data.length, true);
    lv.setUint16(26, nameB.length, true);
    lh.set(nameB, 30);
    parts.push(lh, payload);
    const ch = new Uint8Array(46 + nameB.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, payload.length, true);
    cv.setUint32(24, e.data.length, true);
    cv.setUint16(28, nameB.length, true);
    cv.setUint32(42, offset, true);
    ch.set(nameB, 46);
    central.push(ch);
    offset += lh.length + payload.length;
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) { parts.push(c); cdSize += c.length; }
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdStart, true);
  parts.push(eocd);
  let total = 0; for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
