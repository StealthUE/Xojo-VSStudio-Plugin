/**
 * container.ts — The outer .ACD file: a text header followed by embedded files.
 *
 * Layout (V28–V31 verified; the same scheme is documented by the acd-tools project):
 *
 *   [Version.Log text][TextualVersionInfo.Dat][0x1A][BinaryVersionInfo.Dat][ProjectTemplate.ACD]
 *   [QuickInfo.XML.gz][TagInfo.XML.gz][Comps.Dat.gz][Comps.Idx.gz] ... [FileInfo.Dat]
 *   [directory: count × 528-byte entries][u32 count][u32 trailer, version-dependent:
 *   0x0E7C in V31, 0x0E57 in V30 — not used for detection]
 *
 * Each directory entry is a 260-char UTF-16 name, then u32 length, then u32 offset.
 * Embedded files are gzip streams when they start with 1F 8B, otherwise stored raw.
 * ProjectTemplate.ACD is a whole second (template) ACD nested inside; it is ignored.
 */

import * as fs from 'fs';
import * as zlib from 'zlib';

export const ACD_DIR_MAGIC = 0x0e7c;
const ENTRY_SIZE = 528;
const NAME_BYTES = 520;

export interface AcdEntry {
  name: string;
  offset: number;
  length: number;
}

export class AcdContainer {
  private readonly cache = new Map<string, Buffer>();

  private constructor(
    readonly filePath: string,
    private readonly raw: Buffer,
    readonly entries: AcdEntry[]
  ) {}

  static open(filePath: string): AcdContainer {
    return AcdContainer.fromBuffer(fs.readFileSync(filePath), filePath);
  }

  static fromBuffer(raw: Buffer, filePath = '<buffer>'): AcdContainer {
    if (raw.length < 16) throw new Error('File is too small to be an ACD project.');
    const count = raw.readUInt32LE(raw.length - 8);
    const magic = raw.readUInt32LE(raw.length - 4);
    const dirStart = raw.length - 8 - count * ENTRY_SIZE;
    const notAcd = (why: string) =>
      new Error(`Not a recognised ACD file: ${why} (directory trailer 0x${magic.toString(16)}, ${count} entries).`);
    // The trailer u32 is not a fixed magic: it varies by version (V31 writes 0x0E7C, V30
    // 0x0E57), so it is not checked. The directory itself is validated instead: every
    // entry named and inside the file, and a Comps.Dat present.
    if (count === 0 || count > 1000 || dirStart < 0) throw notAcd('no file directory at the end');
    const entries: AcdEntry[] = [];
    for (let i = 0; i < count; i++) {
      const e = dirStart + i * ENTRY_SIZE;
      const name = raw.toString('utf16le', e, e + NAME_BYTES).split('\u0000')[0] ?? '';
      const length = raw.readUInt32LE(e + NAME_BYTES);
      const offset = raw.readUInt32LE(e + NAME_BYTES + 4);
      if (!/^[\x20-\x7e]+$/.test(name)) throw notAcd(`directory entry ${i} has no valid name`);
      if (offset + length > dirStart) {
        throw new Error(`ACD directory entry ${name} points outside the file.`);
      }
      entries.push({ name, offset, length });
    }
    if (!entries.some(e => e.name.toLowerCase() === 'comps.dat')) {
      throw notAcd('directory has no Comps.Dat');
    }
    return new AcdContainer(filePath, raw, entries);
  }

  has(name: string): boolean {
    return this.find(name) !== undefined;
  }

  private find(name: string): AcdEntry | undefined {
    const lower = name.toLowerCase();
    return this.entries.find(e => e.name.toLowerCase() === lower);
  }

  /** Contents of an embedded file, decompressed. Throws when it is absent. */
  read(name: string): Buffer {
    const cached = this.cache.get(name);
    if (cached) return cached;
    const entry = this.find(name);
    if (!entry) throw new Error(`ACD file has no embedded ${name}.`);
    let data = this.raw.subarray(entry.offset, entry.offset + entry.length);
    if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
      data = zlib.gunzipSync(data);
    }
    this.cache.set(name, data);
    return data;
  }

  /** Embedded UTF-16 XML (QuickInfo.XML, TagInfo.XML) as a string. */
  readXml(name: string): string {
    const buf = this.read(name);
    const start = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe ? 2 : 0;
    return buf.toString('utf16le', start);
  }

  /** Save history lines from the leading text header, oldest first. */
  saveLog(): string[] {
    const entry = this.find('Version.Log');
    const text = entry
      ? this.raw.toString('latin1', entry.offset, entry.offset + entry.length)
      : this.raw.toString('latin1', 0, Math.min(this.raw.length, 200_000));
    return text
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => /^\d{4}-\d{2}-\d{2} /.test(l));
  }
}
