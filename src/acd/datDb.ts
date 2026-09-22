/**
 * datDb.ts — Generic reader for the record databases embedded in an ACD
 * (Comps.Dat, SbRegion.Dat, Comments.Dat, Nameless.Dat ...).
 *
 * Header: u32 @8 = total length, u32 @12 = pointer-region offset (starts FE FE),
 * u32 @20 = record count. The pointer region names the record region, and records start
 * `record_header_length` bytes into it.
 *
 * Each record: u16 identifier, u32 length (including these 6 bytes), payload. FA FA is a
 * live data record; FE FE / FD FD / BF FB are allocator bookkeeping. Gaps (freed space)
 * are skipped by resynchronising on the next FA FA.
 */

export const ID_FAFA = 0xfafa;
const KNOWN_IDS = new Set([0xfafa, 0xfefe, 0xfdfd, 0xfbbf]);

export interface DatRecord {
  identifier: number;
  /** Absolute offset of the identifier within the .Dat buffer. */
  offset: number;
  /** The whole record, identifier included, so field offsets match hex dumps. */
  buf: Buffer;
}

/** Where the first record sits, from the header pointers; falls back to the first FA FA. */
function firstRecordOffset(dat: Buffer): number {
  try {
    const pointerRegion = dat.readUInt32LE(12);
    if (dat.readUInt16LE(pointerRegion) === 0xfefe) {
      const recordsRegion = dat.readUInt32LE(pointerRegion + 18);
      if (dat.readUInt16LE(recordsRegion) === 0xfefe) {
        const headerLen = dat.readUInt32LE(recordsRegion + 2);
        const start = recordsRegion + headerLen;
        if (start > 0 && start < dat.length) return start;
      }
    }
  } catch { /* malformed header — fall through to the scan */ }
  const scan = dat.indexOf(Buffer.from([0xfa, 0xfa]));
  return scan < 0 ? dat.length : scan;
}

/** Every record in a .Dat buffer, in file order. Only FA FA records by default. */
export function* datRecords(dat: Buffer, allIdentifiers = false): Generator<DatRecord> {
  let pos = firstRecordOffset(dat);
  const fafa = Buffer.from([0xfa, 0xfa]);
  while (pos + 6 <= dat.length) {
    const identifier = dat.readUInt16LE(pos);
    const length = dat.readUInt32LE(pos + 2);
    if (!KNOWN_IDS.has(identifier) || length < 6 || pos + length > dat.length) {
      const next = dat.indexOf(fafa, pos + 1);
      if (next < 0) return;
      pos = next;
      continue;
    }
    if (allIdentifiers || identifier === ID_FAFA) {
      yield { identifier, offset: pos, buf: dat.subarray(pos, pos + length) };
    }
    pos += length;
  }
}

/** Declared record count from the header (u32 @20). */
export function declaredRecordCount(dat: Buffer): number {
  return dat.length >= 24 ? dat.readUInt32LE(20) : 0;
}

/** NUL-terminated UTF-16LE string within [start, end). */
export function utf16z(buf: Buffer, start: number, end: number): string {
  const stop = Math.min(end, buf.length);
  for (let i = start; i + 1 < stop; i += 2) {
    if (buf[i] === 0 && buf[i + 1] === 0) return buf.toString('utf16le', start, i);
  }
  return buf.toString('utf16le', start, stop - ((stop - start) % 2));
}

/** NUL-terminated 8-bit string starting at `start`. */
export function asciiz(buf: Buffer, start: number): string {
  const end = buf.indexOf(0, start);
  return buf.toString('utf8', start, end < 0 ? buf.length : end);
}
