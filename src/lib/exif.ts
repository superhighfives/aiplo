/**
 * A small, pure JPEG EXIF reader: just enough to find where and when a photo was taken.
 *
 * Walks the JPEG markers to the APP1 "Exif" segment, reads the TIFF header (either byte order),
 * IFD0 → the GPS IFD (latitude/longitude as degree/minute/second rationals with N/S/E/W refs)
 * and the Exif IFD (DateTimeOriginal, falling back to IFD0's DateTime). HEIC/PNG are not
 * supported: `isJpeg` lets callers say so.
 */

export interface ExifInfo {
  /** Decimal degrees, south and west negative. Undefined when the photo has no GPS block. */
  lat?: number;
  lon?: number;
  /** "YYYY-MM-DDTHH:MM:SS" (camera local time, no zone), from DateTimeOriginal or DateTime. */
  date?: string;
}

const TAG_EXIF_IFD = 0x8769;
const TAG_GPS_IFD = 0x8825;
const TAG_DATETIME = 0x0132;
const TAG_DATETIME_ORIGINAL = 0x9003;
const GPS_LAT_REF = 1, GPS_LAT = 2, GPS_LON_REF = 3, GPS_LON = 4;

/** Bytes per component for each TIFF field type. */
const TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

const toBytes = (b: ArrayBuffer | Uint8Array) => (b instanceof Uint8Array ? b : new Uint8Array(b));

export const isJpeg = (b: ArrayBuffer | Uint8Array) => {
  const u = toBytes(b);
  return u.length > 3 && u[0] === 0xff && u[1] === 0xd8 && u[2] === 0xff;
};

/** The TIFF block inside the APP1 Exif segment, or null. */
function findTiff(u: Uint8Array): Uint8Array | null {
  if (!isJpeg(u)) return null;
  let i = 2;
  while (i + 4 <= u.length) {
    if (u[i] !== 0xff) return null;
    const marker = u[i + 1];
    if (marker === 0xff) { i++; continue; } // fill byte
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan: no more metadata
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; } // standalone markers
    const len = (u[i + 2] << 8) | u[i + 3];
    if (len < 2 || i + 2 + len > u.length) return null;
    if (marker === 0xe1 && len >= 8) {
      const s = i + 4;
      // "Exif\0\0"
      if (u[s] === 0x45 && u[s + 1] === 0x78 && u[s + 2] === 0x69 && u[s + 3] === 0x66 && u[s + 4] === 0 && u[s + 5] === 0)
        return u.subarray(s + 6, i + 2 + len);
    }
    i += 2 + len;
  }
  return null;
}

interface Entry {
  type: number;
  count: number;
  /** Offset of the value within the TIFF block (inline or pointed-to). */
  at: number;
}

/** Parses EXIF GPS position and capture time from JPEG bytes. Never throws on malformed data. */
export function parseExif(bytes: ArrayBuffer | Uint8Array): ExifInfo {
  try {
    return parse(toBytes(bytes));
  } catch {
    return {};
  }
}

function parse(u: Uint8Array): ExifInfo {
  const t = findTiff(u);
  if (!t || t.length < 8) return {};
  const dv = new DataView(t.buffer, t.byteOffset, t.byteLength);
  const le = t[0] === 0x49 && t[1] === 0x49; // "II" little-endian, "MM" big-endian
  if (!le && !(t[0] === 0x4d && t[1] === 0x4d)) return {};
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  if (u16(2) !== 42) return {};

  const readIfd = (off: number): Map<number, Entry> => {
    const m = new Map<number, Entry>();
    if (off < 8 || off + 2 > t.length) return m;
    const n = u16(off);
    for (let k = 0; k < n; k++) {
      const e = off + 2 + k * 12;
      if (e + 12 > t.length) break;
      const type = u16(e + 2), count = u32(e + 4);
      const size = (TYPE_SIZE[type] ?? 1) * count;
      const at = size <= 4 ? e + 8 : u32(e + 8);
      if (at + size > t.length) continue;
      m.set(u16(e), { type, count, at });
    }
    return m;
  };
  const ascii = (e?: Entry) => {
    if (!e || e.type !== 2) return undefined;
    let s = '';
    for (let k = 0; k < e.count; k++) {
      const c = t[e.at + k];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s.trim();
  };
  const rationals = (e?: Entry): number[] | undefined => {
    if (!e || (e.type !== 5 && e.type !== 10)) return undefined;
    const out: number[] = [];
    for (let k = 0; k < e.count; k++) {
      const o = e.at + k * 8;
      const num = e.type === 5 ? u32(o) : dv.getInt32(o, le);
      const den = e.type === 5 ? u32(o + 4) : dv.getInt32(o + 4, le);
      out.push(den === 0 ? 0 : num / den);
    }
    return out;
  };
  const pointer = (e?: Entry) => (e && (e.type === 4 || e.type === 13) ? u32(e.at) : 0);

  const ifd0 = readIfd(u32(4));
  const info: ExifInfo = {};

  const gps = readIfd(pointer(ifd0.get(TAG_GPS_IFD)));
  const dms = (v?: number[]) => (v && v.length ? v[0] + (v[1] ?? 0) / 60 + (v[2] ?? 0) / 3600 : undefined);
  const lat = dms(rationals(gps.get(GPS_LAT)));
  const lon = dms(rationals(gps.get(GPS_LON)));
  if (lat !== undefined && lon !== undefined && Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0)) {
    const latRef = (ascii(gps.get(GPS_LAT_REF)) ?? 'N').toUpperCase();
    const lonRef = (ascii(gps.get(GPS_LON_REF)) ?? 'E').toUpperCase();
    info.lat = latRef === 'S' ? -lat : lat;
    info.lon = lonRef === 'W' ? -lon : lon;
    if (Math.abs(info.lat) > 90 || Math.abs(info.lon) > 180) {
      delete info.lat;
      delete info.lon;
    }
  }

  const exif = readIfd(pointer(ifd0.get(TAG_EXIF_IFD)));
  const raw = ascii(exif.get(TAG_DATETIME_ORIGINAL)) || ascii(ifd0.get(TAG_DATETIME));
  const m = raw?.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m && m[1] !== '0000') info.date = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
  return info;
}
