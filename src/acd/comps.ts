/**
 * comps.ts — Comps.Dat: the component database. Every named object in the project
 * (controller, tasks, programs, routines, tags, data types, AOIs, modules, collections).
 *
 * FA FA record layout (offsets from the identifier):
 *     2  u32  record length        22  u32  object id
 *     6  u32  payload length       26  u32  parent object id
 *    14  u16  sequence             30  124 bytes UTF-16 name, NUL padded
 *   154  Rx body:
 *        +0  u32 parent   +4 u32 unique   +8 u16 kind   +10 u16 cip type   +12 u16 comment id
 *        +14 60-byte main record (routine type u16 at +0x30 within it)
 *        +74 u32 attribute block length   +78 u32 attribute count
 *        +82 attributes: [u32 id][u32 length][value] ...
 *
 * `kind` distinguishes objects: see CompKind. A later record for the same object id
 * supersedes an earlier one.
 */

import { datRecords, utf16z } from './datDb';

export const CompKind = {
  Collection: 0x00,
  RegionMap: 0x01,
  Task: 0x12,
  ProgramOrAoi: 0x13,
  Routine: 0x35,
  Tag: 0x3e,
} as const;

const BODY = 154;

export interface Comp {
  id: number;
  parentId: number;
  name: string;
  kind: number;
  /** Rx body, from offset 154 of the record. */
  body: Buffer;
}

export class CompsDb {
  readonly byId = new Map<number, Comp>();
  private children?: Map<number, Comp[]>;

  constructor(dat: Buffer) {
    for (const rec of datRecords(dat)) {
      const b = rec.buf;
      if (b.length < BODY + 10) continue;
      const comp: Comp = {
        id: b.readUInt32LE(22),
        parentId: b.readUInt32LE(26),
        name: utf16z(b, 30, BODY),
        kind: b.readUInt16LE(BODY + 8),
        body: b.subarray(BODY),
      };
      this.byId.set(comp.id, comp);
    }
  }

  get(id: number): Comp | undefined {
    return this.byId.get(id);
  }

  childrenOf(id: number): Comp[] {
    if (!this.children) {
      this.children = new Map();
      for (const c of this.byId.values()) {
        const list = this.children.get(c.parentId);
        if (list) list.push(c); else this.children.set(c.parentId, [c]);
      }
    }
    return this.children.get(id) ?? [];
  }

  /** Child collection of `id` with the given name, e.g. RxRoutineCollection. */
  collection(id: number, name: string): Comp | undefined {
    return this.childrenOf(id).find(c => c.name === name);
  }

  /** The single top-level object with this name (e.g. RxProgramCollection under the controller). */
  findByName(name: string, kind?: number): Comp | undefined {
    for (const c of this.byId.values()) {
      if (c.name === name && (kind === undefined || c.kind === kind)) return c;
    }
    return undefined;
  }
}

/** u16 cip type + u16 comment id: the key Comments.Dat files an object's comments under. */
export function commentParentKey(c: Comp): number {
  return c.body.length >= 14 ? c.body.readUInt32LE(10) : 0;
}

/** The 4-byte main-record prefix (class + local id) that scopes sub-object comments. */
export function commentMemberKey(c: Comp): number {
  return c.body.length >= 18 ? c.body.readUInt32LE(14) : 0;
}

/** The program's comment id, which is what tasks list in their schedule. */
export function scheduleId(c: Comp): number {
  return c.body.length >= 14 ? c.body.readUInt16LE(12) : 0;
}

/** Routine type code: 1 RLL, 2 FBD, 3 SFC, 4 ST. */
export function routineTypeCode(c: Comp): number {
  return c.body.length >= 64 ? c.body.readUInt16LE(14 + 0x30) : 0;
}

/**
 * Attribute list of an Rx body. Lengths in this block are sometimes 4 bytes short of the
 * physical record, so parsing trusts each attribute's own length and stops at the end.
 */
export function attributes(c: Comp): Map<number, Buffer> {
  const out = new Map<number, Buffer>();
  const b = c.body;
  if (b.length < 82) return out;
  const count = b.readUInt32LE(78);
  let o = 82;
  for (let i = 0; i < count && o + 8 <= b.length; i++) {
    const id = b.readUInt32LE(o);
    const len = b.readUInt32LE(o + 4);
    const end = Math.min(b.length, o + 8 + len);
    out.set(id, b.subarray(o + 8, end));
    o = o + 8 + len;
  }
  return out;
}

export interface RegionMapEntry {
  ownerId: number;
  order: number;
  regionId: number;
}

/**
 * The top-level "Region Map" object lists every logic region (rung) with its owning
 * routine and position: 16-byte entries [owner][order][seq][region] from body offset 0x4E.
 */
export function regionMap(comps: CompsDb): RegionMapEntry[] {
  let map: Comp | undefined;
  for (const c of comps.byId.values()) {
    if (c.name === 'Region Map' && c.parentId === 0 && c.kind === CompKind.RegionMap) {
      if (!map || c.body.length > map.body.length) map = c;
    }
  }
  if (!map || map.body.length < 0x4e) return [];
  const b = map.body;
  const declared = b.readUInt32LE(0x4a);
  const end = Math.min(b.length, 0x4a + declared);
  const out: RegionMapEntry[] = [];
  for (let o = 0x4e; o + 16 <= end; o += 16) {
    out.push({ ownerId: b.readUInt32LE(o), order: b.readUInt32LE(o + 4), regionId: b.readUInt32LE(o + 12) });
  }
  return out;
}
