/**
 * unused.ts — Move definitions nothing uses out of the main lists, without losing them.
 *
 * An .ACD keeps records that are not really part of the project: AOI entries with no
 * parameters, no logic and no calls (left behind by deletes or imports), and every
 * Rockwell-predefined and module-defined data type the firmware knows, used or not.
 * Listing them inflates AOIS.md, DATATYPES.md and the counts, so they go to
 * `controller.unused` instead, and the export lists them in UNUSED.md.
 *
 *   AOI       unused when it has no parameters besides EnableIn/EnableOut, no rungs or
 *             lines in any routine, is never called, and no tag or member has its type
 *   data type unused when it is predefined or module-defined (never user-defined) and no
 *             tag, module tag, UDT member or AOI parameter refers to it, directly or through
 *             another type that is used
 */

import { Controller, DataType, Aoi } from '../model';
import { parseInstructions } from './rungText';
import { blankNonCode } from './stText';

export function separateUnused(c: Controller): void {
  const lower = (s: string) => s.toLowerCase();

  // --- AOIs ------------------------------------------------------------------------------
  const called = new Set<string>();
  const allRoutines = [...c.programs.flatMap(p => p.routines), ...c.aois.flatMap(a => a.routines)];
  for (const r of allRoutines) {
    for (const g of r.rungs) for (const i of parseInstructions(g.text)) called.add(lower(i.name));
    if (r.lines) {
      for (const m of blankNonCode(r.lines.join('\n')).matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) called.add(lower(m[1]!));
    }
  }
  const typeUsers = (): string[] => [
    ...c.tags, ...(c.moduleTags ?? []), ...c.programs.flatMap(p => p.tags),
    ...c.dataTypes.flatMap(d => d.members),
    ...c.aois.flatMap(a => [...a.parameters, ...a.localTags]),
  ].map(x => lower(x.dataType));
  const usedAsType = new Set(typeUsers());
  const emptyAoi = (a: Aoi) =>
    !a.parameters.some(p => p.name !== 'EnableIn' && p.name !== 'EnableOut') &&
    a.routines.every(r => !r.rungs.length && !r.lines?.length);
  const unusedAois = c.aois.filter(a => emptyAoi(a) && !called.has(lower(a.name)) && !usedAsType.has(lower(a.name)));

  // --- Data types (transitive: a used type makes its member types used) ------------------
  const byName = new Map(c.dataTypes.map(d => [lower(d.name), d]));
  const used = new Set<string>();
  const queue = [...new Set(typeUsers())];
  while (queue.length) {
    const t = queue.pop()!;
    if (used.has(t)) continue;
    used.add(t);
    for (const m of byName.get(t)?.members ?? []) queue.push(lower(m.dataType));
  }
  // User-defined types are part of the project even when nothing uses them, so they stay.
  const unusedTypes = c.dataTypes.filter(d => d.kind !== 'udt' && !used.has(lower(d.name)));

  if (!unusedAois.length && !unusedTypes.length) return;
  const dropAoi = new Set(unusedAois);
  const dropType = new Set<DataType>(unusedTypes);
  c.aois = c.aois.filter(a => !dropAoi.has(a));
  c.dataTypes = c.dataTypes.filter(d => !dropType.has(d));
  c.unused = {
    aois: [...(c.unused?.aois ?? []), ...unusedAois],
    dataTypes: [...(c.unused?.dataTypes ?? []), ...unusedTypes],
  };
}
