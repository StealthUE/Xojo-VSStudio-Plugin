/**
 * aoiOrder.ts — Recover the definition order of AOI parameters from an ACD when the stored
 * order list (Nameless.Dat, see stSource.ts orderedIdLists) is not found.
 *
 * The call operands of an AOI follow its parameter list order. Without the stored list,
 * creation index and record position both drift when a parameter is added or moved later.
 * Two facts pin it down:
 *
 *   1. Input/Output parameters are laid out in the AOI's data type in definition order,
 *      and TagInfo.XML lists that data type's members in layout order.
 *   2. InOut parameters are references and do not appear in the layout, so only their
 *      position among the data parameters is unknown. Every call site constrains it:
 *        - an InOut or Output argument cannot be a literal
 *        - an Input/Output argument must be atomic (BOOL/SINT/INT/DINT/REAL/...),
 *          so a whole structure or unindexed array can only go to an InOut
 *        - an InOut argument must have exactly the InOut parameter's data type.
 *
 * For each AOI, candidate orders (data order fixed, InOuts interleaved in every way) are
 * scored against all call sites; the best is kept, ties going to creation order.
 */

import { Controller, Member, Tag } from '../model';
import { isLiteral, parseInstructions } from '../export/rungText';

const ATOMIC = new Set(['BOOL', 'BIT', 'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'REAL', 'LREAL']);
const MAX_CANDIDATES = 20000;

type Kind = 'atomic' | 'struct' | undefined;

/** Data type of an operand (element type for arrays), as far as the tag database says. */
function operandType(c: Controller, programTags: Map<string, Tag> | undefined, controllerTags: Map<string, Tag>, op: string):
  { type: string; array: boolean } | undefined {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)(.*)$/.exec(op.trim());
  if (!m || op.includes(':')) return undefined;
  const tag = programTags?.get(m[1]!.toLowerCase()) ?? controllerTags.get(m[1]!.toLowerCase());
  if (!tag) return undefined;
  let type = tag.dataType;
  let rest = m[2]!;
  let isArray = !!tag.dimensions?.length;
  while (rest) {
    const idx = /^\[[^\]]*\]/.exec(rest);
    if (idx) { rest = rest.slice(idx[0].length); isArray = false; continue; }
    const mem = /^\.([A-Za-z0-9_]+)/.exec(rest);
    if (!mem) return undefined;
    rest = rest.slice(mem[0].length);
    if (/^\d+$/.test(mem[1]!)) return { type: 'BOOL', array: false };   // bit of an integer
    const members: Member[] = c.dataTypes.find(d => d.name === type)?.members
      ?? c.aois.find(a => a.name === type)?.parameters ?? [];
    const mm = members.find(x => x.name.toLowerCase() === mem[1]!.toLowerCase());
    if (!mm) return undefined;
    type = mm.dataType === 'BIT' ? 'BOOL' : mm.dataType;   // a UDT bit member is a BOOL operand
    isArray = !!mm.dimensions?.length;
  }
  return type ? { type, array: isArray } : undefined;
}

/** Is this operand an atomic value or a structure/array, as far as the tag database says? */
function operandKind(c: Controller, programTags: Map<string, Tag> | undefined, controllerTags: Map<string, Tag>, op: string): Kind {
  const t = operandType(c, programTags, controllerTags, op);
  if (!t) return undefined;
  if (t.array) return 'struct';
  return ATOMIC.has(t.type.toUpperCase()) ? 'atomic' : 'struct';
}

/** All interleavings of `extra` (in any order when small) into `base`, preserving base order. */
function* interleavings<T>(base: T[], extra: T[]): Generator<T[]> {
  const perms = extra.length <= 4 ? permutations(extra) : [extra];
  for (const e of perms) yield* merge(base, e);
}

function permutations<T>(a: T[]): T[][] {
  if (a.length <= 1) return [a];
  return a.flatMap((x, i) => permutations([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p]));
}

function* merge<T>(a: T[], b: T[]): Generator<T[]> {
  if (!a.length) { yield b; return; }
  if (!b.length) { yield a; return; }
  for (const rest of merge(a.slice(1), b)) yield [a[0]!, ...rest];
  for (const rest of merge(a, b.slice(1))) yield [b[0]!, ...rest];
}

function binomialCount(n: number, k: number): number {
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/**
 * Reorder each AOI's parameters in place. `creationIndex` gives each parameter's creation
 * order (fallback), `layoutOrder` the TagInfo member names in layout order. AOIs in `exact`
 * already have their stored definition order and are left alone.
 */
export function refineAoiParameterOrder(
  c: Controller,
  creationIndex: Map<string, Map<string, number>>,
  layoutOrder: Map<string, string[]>,
  exact: Set<string> = new Set()
): void {
  const controllerTags = new Map(c.tags.map(t => [t.name.toLowerCase(), t]));
  const calls = new Map<string, { operands: string[]; programTags?: Map<string, Tag> }[]>();
  for (const p of c.programs) {
    const programTags = new Map(p.tags.map(t => [t.name.toLowerCase(), t]));
    for (const r of p.routines) for (const g of r.rungs) for (const ins of parseInstructions(g.text)) {
      const list = calls.get(ins.name);
      if (list) list.push({ operands: ins.operands, programTags });
      else calls.set(ins.name, [{ operands: ins.operands, programTags }]);
    }
  }

  for (const a of c.aois) {
    if (exact.has(a.name)) continue;
    const created = creationIndex.get(a.name) ?? new Map<string, number>();
    const layout = layoutOrder.get(a.name) ?? [];
    const pos = (m: Member) => {
      const i = layout.findIndex(n => n.toLowerCase() === m.name.toLowerCase());
      return i < 0 ? 1e6 + (created.get(m.name) ?? 0) : i;
    };
    const byCreation = (x: Member, y: Member) => (created.get(x.name) ?? 0) - (created.get(y.name) ?? 0);
    const data = a.parameters.filter(p => p.usage !== 'InOut').sort((x, y) => pos(x) - pos(y));
    const inout = a.parameters.filter(p => p.usage === 'InOut').sort(byCreation);
    if (!inout.length) { a.parameters = data; continue; }
    // Fallback: InOuts where creation order puts them, data parameters in layout order.
    const fallback = [...a.parameters].sort(byCreation);
    const dataSlots = fallback.map((p, i) => (p.usage === 'InOut' ? -1 : i)).filter(i => i >= 0);
    dataSlots.forEach((slot, k) => { fallback[slot] = data[k]!; });

    const sites = calls.get(a.name.toUpperCase()) ?? [];
    const reqData = data.filter(p => p.required);
    const combos = binomialCount(reqData.length + inout.length, inout.length) * (inout.length <= 4 ? [1, 1, 2, 6, 24][inout.length]! : 1);
    let best: Member[] | undefined;
    if (sites.length && combos <= MAX_CANDIDATES) {
      const fallbackReq = fallback.filter(p => p.required).map(p => p.name);
      let bestScore = -Infinity;
      let bestDist = Infinity;
      for (const cand of interleavings(reqData, inout)) {
        let score = 0;
        for (const s of sites) {
          cand.forEach((p, j) => {
            const arg = s.operands[j + 1];
            if (arg === undefined) return;
            if (p.usage === 'InOut' || p.usage === 'Output') { if (isLiteral(arg)) score -= 100; }
            if (p.usage !== 'InOut' && !isLiteral(arg)) {
              if (operandKind(c, s.programTags, controllerTags, arg) === 'struct') score -= 100;
            }
            // An InOut argument must be exactly the parameter's data type.
            if (p.usage === 'InOut' && p.dataType && !isLiteral(arg)) {
              const t = operandType(c, s.programTags, controllerTags, arg);
              if (t && t.type.toLowerCase() !== p.dataType.toLowerCase()) score -= 50;
            }
          });
        }
        const dist = cand.reduce((d, p, j) => d + (fallbackReq[j] === p.name ? 0 : 1), 0);
        if (score > bestScore || (score === bestScore && dist < bestDist)) {
          bestScore = score; bestDist = dist; best = cand;
        }
      }
    }
    // Required parameters in the chosen order, then the optional ones in layout order.
    const required = best ?? fallback.filter(p => p.required);
    const optional = data.filter(p => !p.required);
    a.parameters = [...required, ...optional];
  }
}
