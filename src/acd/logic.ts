/**
 * logic.ts — Rung text (SbRegion.Dat), rung ↔ comment keys (RegnLink.Dat) and comment
 * text (Comments.Dat).
 *
 * SbRegion.Dat FA FA record:
 *     12  u32  region id           16  ASCII kind, e.g. "Rung NT", "REGION AST"
 *     57  u32  text byte length    61  UTF-16 neutral text, e.g. XIC(@1a2b3c4d@)OTE(@...@.@...@);
 * `@xxxxxxxx@` is a Comps object id (tag, member, routine, AOI...). Only "Rung NT" holds text;
 * the AST kinds are the compiled form and are not needed.
 *
 * RegnLink.Dat is a hash table of 22-byte slots: 02 ?? 00 01, u32 key, u32 owner routine,
 * u32 region, u32 neighbour region. The low 16 bits of `key` are what the rung's comment
 * is filed under (see Comments below). Rung ORDER comes from the Comps Region Map instead.
 *
 * Comments.Dat FA FA record:
 *     12  u16  record type (1 = 8-bit text)     16  u32  parent key (owner's cip type + comment id)
 *     20  u32  member key (routine class+id)    24  u32  rung key; high 16 bits = RegnLink key
 *     50  NUL-terminated text
 */

import { datRecords, asciiz } from './datDb';

export interface RegionText {
  regionId: number;
  text: string;
}

/** Rung neutral text by region id, ids left unresolved. */
export function rungTexts(sbRegion: Buffer): Map<number, string> {
  const out = new Map<number, string>();
  for (const rec of datRecords(sbRegion)) {
    const b = rec.buf;
    if (b.length < 61 || b.toString('latin1', 16, 23) !== 'Rung NT' || b[23] !== 0) continue;
    const len = b.readUInt32LE(57);
    const text = b.toString('utf16le', 61, Math.min(b.length, 61 + len)).replace(/\u0000+$/, '');
    out.set(b.readUInt32LE(12), text);
  }
  return out;
}

/** Region id → 16-bit comment key, from RegnLink.Dat. */
export function regionCommentKeys(regnLink: Buffer): Map<number, number> {
  const out = new Map<number, number>();
  for (let p = 2; p + 20 <= regnLink.length; p++) {
    if (regnLink[p] !== 0x02 || regnLink[p + 2] !== 0x00 || regnLink[p + 3] !== 0x01) continue;
    if (regnLink[p + 1]! > 1 || regnLink[p - 1] !== 0 || regnLink[p - 2] !== 0) continue;
    const key = regnLink.readUInt32LE(p + 4);
    const region = regnLink.readUInt32LE(p + 12);
    out.set(region, key & 0xffff);
    p += 21;
  }
  return out;
}

export interface CommentRecord {
  parentKey: number;
  memberKey: number;
  /** 0 for the object's own description. */
  rungKey: number;
  text: string;
}

export function commentRecords(comments: Buffer): CommentRecord[] {
  const out: CommentRecord[] = [];
  for (const rec of datRecords(comments)) {
    const b = rec.buf;
    if (b.length < 51 || b.readUInt16LE(12) !== 1) continue;
    const text = asciiz(b, 50).replace(/\r\n/g, '\n').replace(/\s+$/, '');
    if (!text) continue;
    out.push({
      parentKey: b.readUInt32LE(16),
      memberKey: b.readUInt32LE(20),
      rungKey: b.readUInt32LE(24),
      text,
    });
  }
  return out;
}

/** Index of rung comments and descriptions for quick lookup. */
export class CommentIndex {
  private readonly rung = new Map<string, string>();
  private readonly own = new Map<string, string>();

  constructor(records: CommentRecord[]) {
    // Later records supersede earlier ones for the same key.
    for (const r of records) {
      const scope = `${r.parentKey}:${r.memberKey}`;
      if (r.rungKey === 0) this.own.set(scope, r.text);
      else this.rung.set(`${scope}:${r.rungKey >>> 16}`, r.text);
    }
  }

  rungComment(parentKey: number, memberKey: number, commentKey: number): string | undefined {
    return this.rung.get(`${parentKey}:${memberKey}:${commentKey}`);
  }

  description(parentKey: number, memberKey: number): string | undefined {
    return this.own.get(`${parentKey}:${memberKey}`);
  }
}

/** `@id@` = tag, member, routine, AOI... */
const REF = /@([0-9a-fA-F]{8})@/g;
/**
 * `&id:` = module. Module-defined tags are stored under names like `&0f2c60cb:I`, so after
 * `@id@` substitution `&0f2c60cb:I.Data` becomes `<ModuleName>:I.Data`.
 */
const MODULE_REF = /&([0-9a-fA-F]{8}):/g;

/** Replace every @id@ (then every &id: it produced) with its name. Unknown ids stay and are counted. */
export function resolveRefs(
  text: string,
  nameOf: (id: number) => string | undefined,
  unresolved: { count: number }
): string {
  const sub = (re: RegExp, suffix: string) => (whole: string, hex: string) => {
    const name = nameOf(parseInt(hex, 16));
    if (name === undefined) { unresolved.count++; return whole; }
    return name + suffix;
  };
  return text.replace(REF, sub(REF, '')).replace(MODULE_REF, sub(MODULE_REF, ':'));
}
