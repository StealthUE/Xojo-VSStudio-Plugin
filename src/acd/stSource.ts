/**
 * stSource.ts — What Nameless.Dat holds: Structured Text source lines (below), the stored
 * order of AOI parameters (orderedIdLists) and the safety tag map (safetyTagMapRefs).
 *
 * The ACD keeps the ST source text (comments and indentation included) alongside the
 * compiled form. Three record types in Nameless.Dat link a routine to its lines. Offsets are
 * from the FA FA identifier; every record has u32 @14 = its own id, u32 @18 = owner/key,
 * u32 @22 = type:
 *
 *   type ..07d5  ST routine index    @14 = routine's Comps id
 *                                    @38 u16 count, @40 u32[count] document ids (the original
 *                                    plus pending/test edit copies, in no fixed order)
 *   type ..07d3  document state      @18 = document id, @38 u32 state: 1 = original,
 *                                    2 and 3 = pending / test edit copies
 *   type ..07d2  ST document         @14 = document id, @18 = line group key
 *                                    @30 u16 count, @32 u32[count] line ids, in source order
 *   type ..07d1  ST source line      @14 = line group key, @18 = line id
 *                                    @30 CString: FF FE FF, length (u8, or FF + u16), UTF-16
 *
 * Line text uses the same `@id@` object references as rung text. A later record with the
 * same id supersedes an earlier one.
 */

import { datRecords } from './datDb';

const T_LINE = 0x07d1;
const T_DOCUMENT = 0x07d2;
const T_STATE = 0x07d3;
const T_ROUTINE = 0x07d5;
const STATE_ORIGINAL = 1;

export interface StDocument {
  /** Source lines, references left as @id@. */
  lines: string[];
  /** Line ids the document lists but no line record was found for. */
  missing: number;
}

export interface StRoutineSource {
  /** The routine as it is in the controller (the original document). */
  original: StDocument;
  /** True when the routine also has pending or test edits that are not accepted. */
  hasPendingEdits: boolean;
}

export class StSourceIndex {
  private readonly routines = new Map<number, number[]>();
  private readonly documents = new Map<number, number[]>();
  private readonly states = new Map<number, number>();
  private readonly lines = new Map<number, string>();

  constructor(nameless: Buffer) {
    for (const rec of datRecords(nameless)) {
      const b = rec.buf;
      if (b.length < 32) continue;
      const type = b.readUInt32LE(22) & 0xffff;
      if (type === T_LINE) {
        const text = cstring(b, 30);
        if (text !== undefined) this.lines.set(b.readUInt32LE(18), text);
      } else if (type === T_DOCUMENT) {
        this.documents.set(b.readUInt32LE(14), u32List(b, 30));
      } else if (type === T_STATE && b.length >= 42) {
        this.states.set(b.readUInt32LE(18), b.readUInt32LE(38));
      } else if (type === T_ROUTINE && b.length >= 40) {
        this.routines.set(b.readUInt32LE(14), u32List(b, 38));
      }
    }
  }

  get size(): number {
    return this.routines.size;
  }

  /** Source of the ST routine with this Comps id, or undefined when it has no ST index. */
  routine(routineId: number): StRoutineSource | undefined {
    const docs = this.routines.get(routineId);
    if (!docs || !docs.length) return undefined;
    const originalId = docs.find(id => this.states.get(id) === STATE_ORIGINAL) ?? docs[0]!;
    const original = this.document(originalId);
    if (!original) return undefined;
    const hasPendingEdits = docs.some(id => id !== originalId && (this.documents.get(id)?.length ?? 0) > 0);
    return { original, hasPendingEdits };
  }

  private document(id: number): StDocument | undefined {
    const ids = this.documents.get(id);
    if (!ids) return undefined;
    let missing = 0;
    const lines = ids.map(l => {
      const t = this.lines.get(l);
      if (t === undefined) missing++;
      return t ?? '';
    });
    return { lines, missing };
  }
}

/**
 * Ordered object-id lists of type ..09C5 in Nameless.Dat (@30 u16 count, @32 u32 ids). An
 * AOI's parameters (EnableIn, EnableOut, then definition order, exactly as the L5X lists
 * them) and its local tags are each stored as one such list of tag object ids.
 */
export function orderedIdLists(nameless: Buffer): number[][] {
  const out: number[][] = [];
  for (const rec of datRecords(nameless)) {
    const b = rec.buf;
    if (b.length < 32 || (b.readUInt32LE(22) & 0xffff) !== 0x09c5) continue;
    out.push(u32List(b, 30));
  }
  return out;
}

/**
 * The safety tag map (Logic > Map Safety Tags). Records of type ..089B in Nameless.Dat each
 * hold two CStrings from @30: `@<standard tag id>@` then `@<safety tag id>@`. Each scan the
 * standard tag is copied into the safety tag. Returns the raw texts; resolve with resolveRefs.
 */
export function safetyTagMapRefs(nameless: Buffer): { standard: string; safety: string }[] {
  const out: { standard: string; safety: string }[] = [];
  for (const rec of datRecords(nameless)) {
    const b = rec.buf;
    if (b.length < 34 || (b.readUInt32LE(22) & 0xffff) !== 0x089b) continue;
    const first = cstringAt(b, 30);
    const second = first ? cstringAt(b, first.end) : undefined;
    if (first && second && first.text && second.text) out.push({ standard: first.text, safety: second.text });
  }
  return out;
}

/** u16 count at `at`, then that many u32 values. */
function u32List(b: Buffer, at: number): number[] {
  const n = b.readUInt16LE(at);
  const out: number[] = [];
  for (let i = 0, o = at + 2; i < n && o + 4 <= b.length; i++, o += 4) out.push(b.readUInt32LE(o));
  return out;
}

/** MFC CString: FF FE FF, length in UTF-16 units (u8, or FF + u16, or FF FFFF + u32), then the text. */
function cstring(b: Buffer, at: number): string | undefined {
  return cstringAt(b, at)?.text;
}

function cstringAt(b: Buffer, at: number): { text: string; end: number } | undefined {
  if (at + 4 > b.length || b[at] !== 0xff || b[at + 1] !== 0xfe || b[at + 2] !== 0xff) return undefined;
  let len = b[at + 3]!;
  let o = at + 4;
  if (len === 0xff) {
    if (o + 2 > b.length) return undefined;
    len = b.readUInt16LE(o);
    o += 2;
    if (len === 0xffff) {
      if (o + 4 > b.length) return undefined;
      len = b.readUInt32LE(o);
      o += 4;
    }
  }
  const end = Math.min(b.length, o + len * 2);
  return { text: b.toString('utf16le', o, end), end };
}
