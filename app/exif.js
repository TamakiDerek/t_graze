// Minimal EXIF writer: puts GPS position, capture time and a description into a JPEG.
// The input JPEG comes from a canvas, so it carries no EXIF of its own; any APP0/APP1
// segments are dropped and one fresh APP1 "Exif" segment goes straight after SOI.

const BYTE = 1;
const ASCII = 2;
const SHORT = 3;
const LONG = 4;
const RATIONAL = 5;
const TYPE_SIZE = { [BYTE]: 1, [ASCII]: 1, [SHORT]: 2, [LONG]: 4, [RATIONAL]: 8 };

const pad = (n, w = 2) => String(n).padStart(w, "0");

// "YYYY:MM:DD HH:MM:SS" in the phone's local time, as EXIF expects.
export function exifDateTime(d) {
  return `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function toDms(value) {
  // Work in 1/10000 s units so rounding can't produce 60 seconds.
  const total = Math.round(Math.abs(value) * 3600 * 10000);
  const deg = Math.floor(total / 36000000);
  const min = Math.floor((total % 36000000) / 600000);
  const sec = total % 600000;
  return [[deg, 1], [min, 1], [sec, 10000]];
}

function ascii(text) {
  // EXIF ASCII is 7-bit; replace anything else so the count stays right.
  return [...text].map((c) => (c.charCodeAt(0) < 128 ? c.charCodeAt(0) : 63)).concat(0);
}

function entry(tag, type, values) {
  return { tag, type, values };
}

function ifdSize(entries) {
  let data = 0;
  for (const e of entries) {
    const len = valueLength(e);
    if (len > 4) data += len + (len % 2);
  }
  return 2 + entries.length * 12 + 4 + data;
}

function valueLength(e) {
  return TYPE_SIZE[e.type] * e.values.length;
}

function writeValues(view, offset, e) {
  for (const v of e.values) {
    switch (e.type) {
      case BYTE:
      case ASCII:
        view.setUint8(offset, v);
        offset += 1;
        break;
      case SHORT:
        view.setUint16(offset, v);
        offset += 2;
        break;
      case LONG:
        view.setUint32(offset, v);
        offset += 4;
        break;
      case RATIONAL:
        view.setUint32(offset, v[0]);
        view.setUint32(offset + 4, v[1]);
        offset += 8;
        break;
    }
  }
}

// Writes one IFD at `start` (offset from the TIFF header); returns the offset after it.
function writeIfd(view, start, entries) {
  entries.sort((a, b) => a.tag - b.tag);
  view.setUint16(start, entries.length);
  let dataOffset = start + 2 + entries.length * 12 + 4;
  entries.forEach((e, i) => {
    const at = start + 2 + i * 12;
    view.setUint16(at, e.tag);
    view.setUint16(at + 2, e.type);
    view.setUint32(at + 4, e.values.length);
    const len = valueLength(e);
    if (len <= 4) {
      writeValues(view, at + 8, e);
    } else {
      view.setUint32(at + 8, dataOffset);
      writeValues(view, dataOffset, e);
      dataOffset += len + (len % 2);
    }
  });
  view.setUint32(start + 2 + entries.length * 12, 0); // no next IFD
  return dataOffset;
}

/**
 * Builds the TIFF body of an EXIF block.
 * @param {{lat:number, lng:number, altitude?:number|null, accuracy?:number|null, time:Date, description?:string}} info
 */
export function buildExif(info) {
  const utc = info.time;
  const gps = [
    entry(0x0000, BYTE, [2, 3, 0, 0]),
    entry(0x0001, ASCII, ascii(info.lat >= 0 ? "N" : "S")),
    entry(0x0002, RATIONAL, toDms(info.lat)),
    entry(0x0003, ASCII, ascii(info.lng >= 0 ? "E" : "W")),
    entry(0x0004, RATIONAL, toDms(info.lng)),
    entry(0x0007, RATIONAL, [[utc.getUTCHours(), 1], [utc.getUTCMinutes(), 1], [utc.getUTCSeconds(), 1]]),
    entry(0x001d, ASCII, ascii(`${utc.getUTCFullYear()}:${pad(utc.getUTCMonth() + 1)}:${pad(utc.getUTCDate())}`)),
  ];
  if (Number.isFinite(info.altitude)) {
    gps.push(entry(0x0005, BYTE, [info.altitude < 0 ? 1 : 0]));
    gps.push(entry(0x0006, RATIONAL, [[Math.round(Math.abs(info.altitude) * 100), 100]]));
  }
  if (Number.isFinite(info.accuracy)) {
    gps.push(entry(0x001f, RATIONAL, [[Math.round(info.accuracy * 100), 100]]));
  }

  const stamp = ascii(exifDateTime(info.time));
  const exif = [entry(0x9003, ASCII, stamp), entry(0x9004, ASCII, stamp)];
  const ifd0 = [
    entry(0x0112, SHORT, [1]), // orientation: the canvas has already rotated the pixels
    entry(0x0131, ASCII, ascii("t_graze")),
    entry(0x0132, ASCII, stamp),
    entry(0x8769, LONG, [0]), // Exif IFD offset, filled below
    entry(0x8825, LONG, [0]), // GPS IFD offset, filled below
  ];
  if (info.description) ifd0.push(entry(0x010e, ASCII, ascii(info.description)));

  const ifd0At = 8;
  const exifAt = ifd0At + ifdSize(ifd0);
  const gpsAt = exifAt + ifdSize(exif);
  ifd0.find((e) => e.tag === 0x8769).values = [exifAt];
  ifd0.find((e) => e.tag === 0x8825).values = [gpsAt];

  const total = gpsAt + ifdSize(gps);
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf); // big-endian ("MM") throughout
  view.setUint16(0, 0x4d4d);
  view.setUint16(2, 42);
  view.setUint32(4, ifd0At);
  writeIfd(view, ifd0At, ifd0);
  writeIfd(view, exifAt, exif);
  writeIfd(view, gpsAt, gps);
  return new Uint8Array(buf);
}

/** Returns a new JPEG (Uint8Array) with the EXIF block inserted. */
export function insertExif(jpeg, info) {
  const src = jpeg instanceof Uint8Array ? jpeg : new Uint8Array(jpeg);
  if (src[0] !== 0xff || src[1] !== 0xd8) throw new Error("not a JPEG");
  const tiff = buildExif(info);
  const segLen = 2 + 6 + tiff.length;
  if (segLen > 0xffff) throw new Error("EXIF block too large");

  // Skip existing APP0/APP1 segments; keep everything from the first other marker on.
  let pos = 2;
  while (pos + 4 <= src.length && src[pos] === 0xff && (src[pos + 1] === 0xe0 || src[pos + 1] === 0xe1)) {
    pos += 2 + ((src[pos + 2] << 8) | src[pos + 3]);
  }
  const rest = src.subarray(pos);

  const out = new Uint8Array(2 + 2 + segLen + rest.length);
  out.set([0xff, 0xd8, 0xff, 0xe1, segLen >> 8, segLen & 0xff], 0);
  out.set([0x45, 0x78, 0x69, 0x66, 0, 0], 6); // "Exif\0\0"
  out.set(tiff, 12);
  out.set(rest, 12 + tiff.length);
  return out;
}
