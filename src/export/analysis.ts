/**
 * analysis.ts — Whole-project checks built on the rung parser and AOI-aware operand
 * classification:
 *
 *   bypasses     empty or NOP-only parallel legs next to contacts (a short), AFI() (leg
 *                disabled), XIC(x) with XIO(x) in series (never true) or in parallel (always true)
 *   unconsumed   operand paths written somewhere and read nowhere ("mapped but not consumed")
 *   unproduced   operand paths read but never written and not fed by an input module
 *   safety       one row per safety AOI call: input, where mapped, which rungs consume its
 *                outputs, and whether that output reaches an output module or configured sink
 *
 * Ladder rungs and Structured Text lines are both analysed (see logicUnits.ts); bypass
 * findings are ladder-only. What counts as safety-related comes from SafetyConfig.
 *
 * Tag names are case-insensitive in Logix; comparisons here are too. "Overlap" means one
 * path is the other or a member of it (Tag vs Tag.S_On), with array indices treated as
 * wildcards, so reading a whole structure consumes every member written into it.
 */

import { Controller, Tag } from '../model';
import { AoiIndex, Element, OperandUse, instructionsOf, isLiteral, parseRung, seriesText } from './rungText';
import { isStRoutine, locText, routineUnits } from './logicUnits';

/**
 * Site naming rules for the safety checks. By default there are none: what is safety comes
 * only from what Logix itself records (the safety task and its programs, safety-class AOIs
 * and tags, safety I/O, the safety tag map). A project can opt in to name rules through the
 * studio5000.safety.* settings.
 */
export interface SafetyConfig {
  /** Extra: operand names that count as safety-related even without a safety class. */
  names?: RegExp;
  /** Extra: AOIs treated as safety devices besides safety-class AOIs and AOIs called in safety programs. */
  deviceAoi?: RegExp;
  /**
   * Operands that count as "the safety signal reached something that acts", highest
   * priority first, e.g. a global E-stop bit or a contactor zone. Output and safety-output
   * module tags (`:O`, `:SO`) always count and rank above these.
   */
  sinks: RegExp[];
  /** A safety AOI's result member, e.g. `.S_On`. Without it a device is judged on all its outputs. */
  result?: RegExp;
  /** Tags filled by safety tag mapping, for projects whose file carries no tag map. */
  mappedCopy?: RegExp;
}

export const DEFAULT_SAFETY: SafetyConfig = { sinks: [] };

export interface SafetySettings {
  namePattern?: string;
  deviceAoiPattern?: string;
  sinkPatterns?: string[];
  resultMemberPattern?: string;
  mappedCopyPattern?: string;
}

/** Build a SafetyConfig from user settings (regex source strings); bad patterns are reported and skipped. */
export function safetyConfigFrom(s: SafetySettings, problems: string[] = []): SafetyConfig {
  const re = (src: string | undefined, what: string): RegExp | undefined => {
    if (!src || !src.trim()) return undefined;
    try { return new RegExp(src, 'i'); } catch (e) { problems.push(`Setting ${what}: invalid pattern "${src}" (${(e as Error).message}); ignored.`); return undefined; }
  };
  return {
    names: re(s.namePattern, 'safety.namePattern'),
    deviceAoi: re(s.deviceAoiPattern, 'safety.deviceAoiPattern'),
    sinks: (s.sinkPatterns ?? []).map((p, i) => re(p, `safety.sinkPatterns[${i}]`)).filter((r): r is RegExp => !!r),
    result: re(s.resultMemberPattern, 'safety.resultMemberPattern'),
    mappedCopy: re(s.mappedCopyPattern, 'safety.mappedCopyPattern'),
  };
}

const OUTPUT_MODULE_RE = /:S?O(\b|$)/i;
const INPUT_MODULE_RE = /:S?I(\b|$)/i;

/**
 * Where a safety signal must end up to do anything, ranked (0 = not a sink):
 *   1000   a real output: output or safety-output module tag (`:O`, `:SO`)
 *   100-i  the i-th configured sink pattern (SafetyConfig.sinks); a pattern decides which
 *          members count, e.g. `Contactor.*\.S_On$` rather than any `Contactor` member
 */
export function sinkRank(operand: string, base: string, cfg: SafetyConfig = DEFAULT_SAFETY): number {
  if (OUTPUT_MODULE_RE.test(base)) return 1000;
  const i = cfg.sinks.findIndex(r => r.test(operand));
  return i < 0 ? 0 : 100 - i;
}

export interface RungRef {
  program: string;
  routine: string;
  /** Rung number, or 0-based line index when `st`. */
  rung: number;
  st?: boolean;
}

export function refText(r: RungRef): string {
  return `${r.program}/${r.routine}${locText(r.rung, !!r.st)}`;
}

interface Use extends OperandUse {
  /** Scope-qualified, lower-cased, index-wildcarded path: "prog|tag.member[*]" or "|tag". */
  key: string;
  scopeBase: string;
}

interface RungFacts {
  ref: RungRef;
  /** Rung text; for ST, the source line. */
  text: string;
  reads: Use[];
  writes: Use[];
}

function norm(path: string): string {
  return path.replace(/\s+/g, '').replace(/\[[^\]]*\]/g, '[*]').toLowerCase();
}

function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  return l.startsWith(s) && (l[s.length] === '.' || l[s.length] === '[');
}

/**
 * Add decoder notes saying what safety information the project lacks, so a gap is visible in
 * CODEBASE.md instead of silently weakening SAFETY.md. Only for projects with safety content.
 */
export function reportSafetyCoverage(c: Controller): void {
  const safetyTask = c.tasks.some(t => t.safety);
  const safetyTags = [...c.tags, ...c.programs.flatMap(p => p.tags)].filter(t => t.safety).length;
  if (!safetyTask) {
    if (safetyTags || c.aois.some(a => a.safety)) c.warnings.push('Safety tags or AOIs found but no safety task: safety scope may be incomplete.');
    return;
  }
  if (!c.programs.some(p => p.safety)) c.warnings.push('Safety task found but no safety program: safety checks cover only safety-class tags and AOIs.');
  if (!safetyTags) c.warnings.push('Safety task found but no safety-class tags were decoded: SAFETY.md relies on the safety program scope only.');
  if (!c.safetyTagMap?.length && c.tags.some(t => t.safety)) {
    c.warnings.push('No safety tag map found: safety tags filled by mapping may be reported as "read but never produced".');
  }
}

/** Programs that run in a safety task, or are marked safety themselves. */
export function safetyProgramNames(c: Controller): Set<string> {
  const out = new Set(c.programs.filter(p => p.safety).map(p => p.name));
  for (const t of c.tasks) if (t.safety) for (const p of t.programs) out.add(p);
  return out;
}

/**
 * Upper-case names of safety AOIs: safety-class AOIs, AOIs whose name matches the device
 * pattern, and every AOI called from a safety program (only safety AOIs can run there).
 */
export function safetyAoiNames(c: Controller, cfg: SafetyConfig, aois: AoiIndex): Set<string> {
  const out = new Set<string>();
  for (const a of c.aois) if (a.safety || cfg.deviceAoi?.test(a.name)) out.add(a.name.toUpperCase());
  const safetyProgs = safetyProgramNames(c);
  for (const p of c.programs) {
    if (!safetyProgs.has(p.name)) continue;
    for (const r of p.routines) for (const u of routineUnits(r, aois)) {
      for (const use of u.uses) if (use.via && aois.has(use.instruction)) out.add(use.instruction);
    }
  }
  return out;
}

export class ProjectFacts {
  readonly rungs: RungFacts[] = [];
  readonly safetyPrograms: Set<string>;
  readonly safetyAois: Set<string>;
  private readonly readersByBase = new Map<string, number[]>();
  private readonly writersByBase = new Map<string, number[]>();
  private readonly tags = new Map<string, Tag>();
  private readonly mappedSafety: Set<string>;
  private readonly mappedStandard: Set<string>;

  constructor(readonly c: Controller, readonly aois: AoiIndex, readonly cfg: SafetyConfig = DEFAULT_SAFETY) {
    this.mappedSafety = new Set((c.safetyTagMap ?? []).map(m => m.safety.toLowerCase()));
    this.mappedStandard = new Set((c.safetyTagMap ?? []).map(m => m.standard.toLowerCase()));
    this.safetyPrograms = safetyProgramNames(c);
    this.safetyAois = safetyAoiNames(c, cfg, aois);
    const ctl = new Set([...c.tags, ...(c.moduleTags ?? [])].map(t => t.name.toLowerCase()));
    for (const t of [...c.tags, ...(c.moduleTags ?? [])]) this.tags.set(`|${t.name.toLowerCase()}`, t);
    for (const p of c.programs) for (const t of p.tags) this.tags.set(`${p.name}|${t.name.toLowerCase()}`, t);
    for (const p of c.programs) {
      const local = new Set(p.tags.map(t => t.name.toLowerCase()));
      for (const r of p.routines) {
        const st = isStRoutine(r);
        for (const g of routineUnits(r, aois)) {
          const facts: RungFacts = { ref: { program: p.name, routine: r.name, rung: g.n, st: st || undefined }, text: g.text, reads: [], writes: [] };
          for (const u of g.uses) {
            const b = u.base.toLowerCase();
            const scope = local.has(b) ? p.name : ctl.has(b) ? '' : p.name;
            const use: Use = { ...u, key: `${scope}|${norm(u.operand)}`, scopeBase: `${scope}|${b}` };
            (u.write ? facts.writes : facts.reads).push(use);
          }
          const idx = this.rungs.push(facts) - 1;
          for (const u of facts.reads) push(this.readersByBase, u.scopeBase, idx);
          for (const u of facts.writes) push(this.writersByBase, u.scopeBase, idx);
        }
      }
    }
  }

  /** Rungs (other than `except`) that read something overlapping `u`. */
  readersOf(u: { key: string; scopeBase: string }, except?: number): number[] {
    return (this.readersByBase.get(u.scopeBase) ?? [])
      .filter((i, n, all) => i !== except && all.indexOf(i) === n)
      .filter(i => this.rungs[i]!.reads.some(r => overlaps(r.key, u.key)));
  }

  /** Does any rung write any part of this tag? */
  isWritten(scopeBase: string): boolean {
    return (this.writersByBase.get(scopeBase)?.length ?? 0) > 0;
  }

  /** Tag definition by "scope|lower-case name". */
  tagOf(scopeBase: string): Tag | undefined {
    return this.tags.get(scopeBase);
  }

  /** Every tag base that some rung reads, as "scope|lower-case name". */
  readBases(): string[] {
    return [...this.readersByBase.keys()];
  }

  readersOfBase(scopeBase: string): number[] {
    return [...new Set(this.readersByBase.get(scopeBase) ?? [])];
  }

  writersOf(u: { key: string; scopeBase: string }): number[] {
    return (this.writersByBase.get(u.scopeBase) ?? [])
      .filter((i, n, all) => all.indexOf(i) === n)
      .filter(i => this.rungs[i]!.writes.some(w => overlaps(w.key, u.key)));
  }

  /** Is this tag (as "scope|lower-case name") safety-related: safety class, or in a safety program? */
  isSafetyTag(scopeBase: string): boolean {
    const scope = scopeBase.slice(0, scopeBase.indexOf('|'));
    return this.safetyPrograms.has(scope) || !!this.tags.get(scopeBase)?.safety;
  }

  /** Filled by safety tag mapping (or named like it per settings): produced outside the logic. */
  isMappedSafety(scopeBase: string): boolean {
    const scope = scopeBase.slice(0, scopeBase.indexOf('|'));
    const name = scopeBase.slice(scopeBase.indexOf('|') + 1);
    return (scope === '' && this.mappedSafety.has(name)) || !!this.cfg.mappedCopy?.test(name);
  }

  /** Read by safety tag mapping: consumed outside the logic. */
  isMappedStandard(scopeBase: string): boolean {
    return scopeBase.startsWith('|') && this.mappedStandard.has(scopeBase.slice(1));
  }

  /** Safety-related use: a safety-class or safety-program tag, or a safety-sounding name. */
  isSafetyUse(u: { operand: string; scopeBase: string }): boolean {
    return !!this.cfg.names?.test(u.operand) || this.isSafetyTag(u.scopeBase);
  }

  /** Safety-related operand text in `program` (for bypass findings). */
  isSafetyOperand(operand: string, program: string): boolean {
    if (this.cfg.names?.test(operand)) return true;
    const b = (operand.split(/[.[]/)[0] ?? '').trim().toLowerCase();
    return this.isSafetyTag(`${program}|${b}`) || this.isSafetyTag(`|${b}`);
  }

  rankOf(u: { operand: string; base: string }): number {
    return sinkRank(u.operand, u.base, this.cfg);
  }

  bestSink<T extends { operand: string; base: string }>(list: T[]): T | undefined {
    let best: T | undefined;
    for (const u of list) if (this.rankOf(u) > (best ? this.rankOf(best) : 0)) best = u;
    return best;
  }

  /**
   * Shortest chain of rungs carrying `start` to a sink (output module or a configured sink
   * pattern). Coarse on purpose: within a rung, every read feeds every write.
   */
  pathToSink(start: Use, fromRung: number, maxHops = 12): { chain: string[]; sink: string } | undefined {
    const rankOf = (u: Use) => this.rankOf(u);
    if (rankOf(start)) return { chain: [], sink: start.operand };
    // An AOI's EnableOut drives whatever follows it on its own rung (e.g. the output coils).
    const origin = this.rungs[fromRung]!;
    const sameRung = this.bestSink(origin.writes.filter(w => !w.via));
    if (sameRung) return { chain: [`${refText(origin.ref)} (same rung) → \`${sameRung.operand}\``], sink: sameRung.operand };
    const seen = new Set<string>([start.key]);
    let frontier: { u: Use; chain: string[] }[] = [{ u: start, chain: [] }];
    for (let hop = 0; hop < maxHops && frontier.length; hop++) {
      const next: { u: Use; chain: string[] }[] = [];
      // Best-ranked sink reached at this depth wins, so an output coil beats a diagnostic bit.
      let found: { u: Use; chain: string[] } | undefined;
      for (const { u, chain } of frontier) {
        for (const ri of this.readersOf(u, hop === 0 ? fromRung : undefined)) {
          const r = this.rungs[ri]!;
          for (const w of r.writes) {
            const c2 = [...chain, `${refText(r.ref)} → \`${w.operand}\``];
            if (rankOf(w) && (!found || rankOf(w) > rankOf(found.u))) found = { u: w, chain: c2 };
            if (seen.has(w.key)) continue;
            seen.add(w.key);
            next.push({ u: w, chain: c2 });
          }
        }
      }
      if (found) return { chain: found.chain, sink: found.u.operand };
      frontier = next;
    }
    return undefined;
  }
}

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const a = m.get(k);
  if (a) a.push(v); else m.set(k, [v]);
}

// ---------------------------------------------------------------------------------------
// Bypasses
// ---------------------------------------------------------------------------------------

export type BypassKind = 'empty-leg' | 'nop-leg' | 'afi' | 'never-true' | 'always-true';

export interface Bypass {
  ref: RungRef;
  kind: BypassKind;
  /** What is shorted or disabled, as neutral text. */
  affected: string;
  /** Tag operands inside the shorted/disabled part. */
  operands: string[];
  safety: boolean;
}

const CONDITIONS = new Set(['XIC', 'XIO', 'EQU', 'NEQ', 'LES', 'LEQ', 'GRT', 'GEQ', 'LIM', 'MEQ', 'CMP', 'ONS']);

function conditionOperands(series: Element[]): string[] {
  return instructionsOf(series)
    .filter(i => CONDITIONS.has(i.name))
    .flatMap(i => i.operands.filter(o => !isLiteral(o)));
}

/** Bypass findings in one rung. `isSafety` decides which operands are safety-related. */
export function findBypasses(ref: RungRef, text: string, isSafety: (operand: string) => boolean = () => false): Bypass[] {
  const out: Bypass[] = [];
  const add = (kind: BypassKind, affected: string, operands: string[]) =>
    out.push({ ref, kind, affected, operands, safety: operands.some(isSafety) });

  const walkSeries = (series: Element[]) => {
    const ins = series.filter((e): e is Extract<Element, { kind: 'ins' }> => e.kind === 'ins').map(e => e.ins);
    if (ins.some(i => i.name === 'AFI')) add('afi', seriesText(series), instructionsOf(series).flatMap(i => i.operands.filter(o => !isLiteral(o))));
    const xic = new Set(ins.filter(i => i.name === 'XIC').map(i => (i.operands[0] ?? '').toLowerCase()));
    for (const i of ins) {
      if (i.name === 'XIO' && xic.has((i.operands[0] ?? '').toLowerCase())) {
        add('never-true', `XIC(${i.operands[0]}) … XIO(${i.operands[0]}) in series`, [i.operands[0]!]);
      }
    }
    for (const e of series) {
      if (e.kind !== 'branch') continue;
      const passive = e.legs.map(l => l.length === 0 ? 'empty' : instructionsOf(l).every(i => i.name === 'NOP') ? 'nop' : '');
      const shorted = e.legs.filter((_, j) => !passive[j]);
      const shortedOps = shorted.flatMap(conditionOperands);
      if (passive.some(Boolean) && shortedOps.length) {
        add(passive.includes('empty') ? 'empty-leg' : 'nop-leg', `[${e.legs.map(seriesText).join(' ,')} ]`, shortedOps);
      }
      const single = e.legs.map(l => {
        const only = l.length === 1 ? l[0]! : undefined;
        return only?.kind === 'ins' ? only.ins : undefined;
      });
      for (const a of single) {
        if (a?.name !== 'XIC') continue;
        const op = (a.operands[0] ?? '').toLowerCase();
        if (single.some(b => b?.name === 'XIO' && (b.operands[0] ?? '').toLowerCase() === op)) {
          add('always-true', `[XIC(${a.operands[0]}) ,XIO(${a.operands[0]}) ]`, [a.operands[0]!]);
        }
      }
      for (const leg of e.legs) walkSeries(leg);
    }
  };
  walkSeries(parseRung(text));
  return out;
}

// ---------------------------------------------------------------------------------------
// Unconsumed / unproduced
// ---------------------------------------------------------------------------------------

export interface DanglingPath {
  scope: string;
  operand: string;
  refs: RungRef[];
  instructions: string[];
  safety: boolean;
  /**
   * Unconsumed: 'aoi-output' = written only by an AOI into a caller's tag and not the device
   * result (SafetyConfig.result when set), i.e. usually a status bit nothing is meant to read.
   * Unproduced: 'external' = no rung writes any part of the tag (mapped copy, consumed tag,
   * HMI/SCADA, module echo); 'partial' = logic writes other members of the tag, not this one.
   */
  kind?: 'aoi-output' | 'external' | 'partial';
}

/** Written but never read. Excludes output-module tags (hardware reads them), instance and one-shot storage. */
export function findUnconsumed(f: ProjectFacts): DanglingPath[] {
  const byKey = new Map<string, DanglingPath & { use: Use; viaOnly: boolean }>();
  f.rungs.forEach(r => {
    for (const w of r.writes) {
      // AOI instances and one-shot storage bits are internal state, not signals.
      if (w.via === 'instance' || (/^(ONS|OSR|OSF)$/.test(w.instruction) && w.index === 0)) continue;
      if (OUTPUT_MODULE_RE.test(w.base) || f.isMappedStandard(w.scopeBase)) continue;
      let d = byKey.get(w.key);
      if (!d) {
        d = { scope: w.key.split('|')[0]!, operand: w.operand, refs: [], instructions: [], safety: f.isSafetyUse(w), use: w, viaOnly: true };
        byKey.set(w.key, d);
      }
      if (!w.via) d.viaOnly = false;
      d.refs.push(r.ref);
      if (!d.instructions.includes(w.instruction)) d.instructions.push(w.instruction);
    }
  });
  const out = [...byKey.values()].filter(d => !f.readersOf(d.use).length).map(d => ({
    ...strip(d), kind: d.viaOnly && !f.cfg.result?.test(d.operand) ? 'aoi-output' as const : undefined,
  }));
  return out.sort((a, b) => Number(b.safety) - Number(a.safety) || a.scope.localeCompare(b.scope) || a.operand.localeCompare(b.operand));
}

/** Read but never written anywhere and not from an input module: safety-related only. */
export function findUnproducedSafety(f: ProjectFacts): DanglingPath[] {
  const byKey = new Map<string, DanglingPath & { use: Use }>();
  for (const r of f.rungs) {
    for (const u of r.reads) {
      if (!f.isSafetyUse(u) || INPUT_MODULE_RE.test(u.base) || OUTPUT_MODULE_RE.test(u.base)) continue;
      let d = byKey.get(u.key);
      if (!d) {
        d = { scope: u.key.split('|')[0]!, operand: u.operand, refs: [], instructions: [], safety: true, use: u };
        byKey.set(u.key, d);
      }
      d.refs.push(r.ref);
      if (!d.instructions.includes(u.instruction)) d.instructions.push(u.instruction);
    }
  }
  // Output-image bits (read only to be echoed to the module) and mapped copies are filled
  // from outside the logic; only other members of logic-written tags count as 'partial'.
  const external = (d: { operand: string; use: Use }) =>
    !f.isWritten(d.use.scopeBase) || OUTPUT_MODULE_RE.test(d.use.base) || f.isMappedSafety(d.use.scopeBase);
  const out = [...byKey.values()].filter(d => !f.writersOf(d.use).length).map(d => ({
    ...strip(d), kind: external(d) ? 'external' as const : 'partial' as const,
  }));
  return out.sort((a, b) => a.scope.localeCompare(b.scope) || a.operand.localeCompare(b.operand));
}

function strip(d: DanglingPath): DanglingPath {
  return { scope: d.scope, operand: d.operand, refs: d.refs, instructions: d.instructions, safety: d.safety };
}

// ---------------------------------------------------------------------------------------
// Safety devices
// ---------------------------------------------------------------------------------------

export interface SafetyDevice {
  ref: RungRef;
  aoi: string;
  instance: string;
  /** Input arguments by parameter name. */
  inputs: { param: string; value: string }[];
  outputs: {
    operand: string;
    consumers: RungRef[];
    reaches?: { chain: string[]; sink: string };
    bypassedAt: RungRef[];
  }[];
  /** Tags passed as InOut device objects, as "scope|lower-case name". */
  objects: string[];
}

export interface OrphanDevice {
  tag: string;
  scope: string;
  dataType: string;
  /** Rungs reading it; nothing writes it. */
  readers: RungRef[];
  bypassedAt: RungRef[];
}

/**
 * Tags of a safety device type (a data type passed as the InOut device object to some safety
 * AOI call) that logic reads but no rung, and no AOI call, ever writes: a device drawn in the
 * E-stop chain whose AOI call is missing.
 */
export function findOrphanDevices(f: ProjectFacts, devices: SafetyDevice[], bypasses: Bypass[]): OrphanDevice[] {
  const types = new Set<string>();
  for (const d of devices) for (const o of d.objects) {
    const t = f.tagOf(o);
    if (t?.dataType) types.add(t.dataType.toLowerCase());
  }
  const out: OrphanDevice[] = [];
  for (const sb of f.readBases()) {
    const t = f.tagOf(sb);
    if (!t || !types.has(t.dataType.toLowerCase()) || f.isWritten(sb)) continue;
    // Tags filled by safety tag mapping are produced outside the logic.
    if (f.isMappedSafety(sb)) continue;
    const scope = sb.slice(0, sb.indexOf('|'));
    const lower = t.name.toLowerCase();
    out.push({
      tag: t.name, scope, dataType: t.dataType,
      readers: f.readersOfBase(sb).map(i => f.rungs[i]!.ref),
      bypassedAt: bypasses.filter(b => b.operands.some(o => overlaps(norm(o), lower))).map(b => b.ref),
    });
  }
  return out.sort((a, b) => a.scope.localeCompare(b.scope) || a.tag.localeCompare(b.tag));
}

export function findSafetyDevices(f: ProjectFacts, bypasses: Bypass[]): SafetyDevice[] {
  const bypassedOps = new Map<string, RungRef[]>();
  for (const b of bypasses) for (const o of b.operands) push(bypassedOps, norm(o), b.ref);
  const out: SafetyDevice[] = [];
  f.rungs.forEach((r, ri) => {
    const calls = new Map<string, Use[]>();
    for (const u of [...r.writes, ...r.reads]) {
      if (u.via && f.safetyAois.has(u.instruction) && f.aois.has(u.instruction)) push(calls, u.instruction, u);
    }
    for (const [aoiUpper, uses] of calls) {
      const sig = f.aois.get(aoiUpper)!;
      const inst = uses.find(u => u.via === 'instance');
      const dev: SafetyDevice = {
        ref: r.ref, aoi: sig.name, instance: inst?.operand ?? '?',
        inputs: uses.filter(u => !u.write && u.via !== 'instance' && sig.args.find(a => a.name === u.via)?.usage === 'Input')
          .map(u => ({ param: u.via!, value: u.operand })),
        outputs: [],
        objects: [...new Set(uses.filter(u => sig.args.find(a => a.name === u.via)?.usage === 'InOut').map(u => u.scopeBase))],
      };
      for (const w of uses.filter(u => u.write && u.via !== 'instance')) {
        const consumers = f.readersOf(w, ri).map(i => f.rungs[i]!.ref);
        const bypassedAt = [...bypassedOps.entries()].filter(([k]) => overlaps(k, norm(w.operand))).flatMap(([, v]) => v);
        dev.outputs.push({ operand: w.operand, consumers, reaches: f.pathToSink(w, ri), bypassedAt });
      }
      out.push(dev);
    }
  });
  return out;
}
