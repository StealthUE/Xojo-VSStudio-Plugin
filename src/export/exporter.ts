/**
 * exporter.ts — Write a decoded Controller to its export folder: one editable file per
 * routine plus the AI-facing documents.
 *
 *   CODEBASE.md      overview: controller, tasks, programs, routines, AOIs, notes
 *   PROJECT_MAP.md   execution order: task → program → main routine → JSR call tree
 *   CROSSREF.md      for every tag, where it is written and read (routine + rung or ST line)
 *   TAGS.md          every tag by scope with type, dimensions, usage counts, description
 *   DATATYPES.md     user-defined types and their members
 *   AOIS.md          Add-On Instructions and their parameters
 *   MODULES.md       the I/O configuration tree
 *   UNUSED.md        definitions nothing uses (stale AOI records, unused predefined types)
 *   SAFETY.md, BYPASSES.md, UNCONSUMED.md   checks generated from the logic (analysis.ts)
 *   Programs/<Program>/<Routine>.rll|.st,  Programs/<Program>/Tags.csv
 *   AOIs/<AOI>/<Routine>.rll|.st,  Controller/Tags.csv
 *   _manifest.json   fingerprint of the source + hash of every exported routine file
 *   _model.json      the decoded model, reloaded by the extension without re-decoding
 *
 * Routine files that were edited since the last export are never overwritten: a
 * re-export keeps them and reports them, so pending edits survive a project reload.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Controller, DataType, Module, Program, Routine, Tag, Aoi } from '../model';
import { RLL_EXT, ST_EXT, formatRoutine, parseRoutineFile } from './routineFile';
import { AoiIndex, canonicalRung } from './rungText';
import { isStRoutine, locList, locText, routineUnits } from './logicUnits';
import { buildAoiIndex } from './aoiIndex';
import {
  Bypass, DEFAULT_SAFETY, DanglingPath, OrphanDevice, ProjectFacts, SafetyConfig, SafetyDevice, findBypasses,
  findOrphanDevices, findSafetyDevices, findUnconsumed, findUnproducedSafety, refText,
} from './analysis';

export const EXPORT_STAMP = '<!-- vs-studio5000-export v1 -->';
/** Bump when the layout of exported files changes, so existing exports are regenerated. */
export const EXPORT_FORMAT = 7;

/**
 * Folders under `Programs/` or `AOIs/` for a program or AOI no longer in the project: remove
 * their generated `Tags.csv`, then the folder if nothing else is left. Routine files are
 * removed (or kept, when edited) through the manifest, so a folder holding edits survives.
 */
function removeStaleFolders(dir: string, sub: string, names: string[]): number {
  const root = path.join(dir, sub);
  const live = new Set(names.map(n => safeName(n)));
  let removed = 0;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (!e.isDirectory() || live.has(e.name)) continue;
    const folder = path.join(root, e.name);
    try { fs.unlinkSync(path.join(folder, 'Tags.csv')); removed++; } catch { /* none */ }
    try { if (fs.readdirSync(folder).length === 0) fs.rmdirSync(folder); } catch { /* keep */ }
  }
  return removed;
}
export const MANIFEST = '_manifest.json';
export const MODEL = '_model.json';

export interface Fingerprint { size: number; mtimeMs: number }

export interface ManifestFile {
  program?: string;
  aoi?: string;
  routine: string;
  type: string;
  /** sha1 of the file text as exported. */
  hash: string;
  /**
   * sha1 of the routine's content as exported (see contentHash): what edit detection
   * compares, so a change of layout alone is never taken for an edit.
   */
  content?: string;
  editable: boolean;
}

export interface Manifest {
  tool: 'vs-studio5000';
  version: 1;
  /** EXPORT_FORMAT that produced this export. */
  format?: number;
  source: string;
  fingerprint: Fingerprint;
  exportedAt: string;
  controller: string;
  files: Record<string, ManifestFile>;
}

export interface ExportSummary {
  dir: string;
  routineFiles: number;
  written: number;
  /** Routine files with local edits that were left in place. */
  keptEdited: string[];
  removed: number;
  /** Files flagged as edited that only differed in layout; rewritten, not kept. */
  healed: number;
}

/**
 * More kept "edits" than a person plausibly makes between exports: 20 or more files and at
 * least a quarter of the project. Usually two plugin versions wrote the same export folder.
 */
export function implausibleEdits(s: ExportSummary): boolean {
  return s.keptEdited.length >= 20 && s.keptEdited.length >= s.routineFiles / 4;
}

export function sha1(s: string): string {
  return crypto.createHash('sha1').update(s, 'utf8').digest('hex');
}

/** exports/<Base>-<8 hex of the lower-cased absolute path>, so two copies never collide. */
export function exportDirFor(storageRoot: string, sourcePath: string): string {
  const base = path.basename(sourcePath, path.extname(sourcePath)).replace(/[^A-Za-z0-9_. -]+/g, '_').trim();
  const h = sha1(path.resolve(sourcePath).toLowerCase()).slice(0, 8);
  return path.join(storageRoot, 'exports', `${base}-${h}`);
}

export function fingerprintOf(sourcePath: string): Fingerprint {
  const st = fs.statSync(sourcePath);
  return { size: st.size, mtimeMs: Math.round(st.mtimeMs) };
}

export function readManifest(dir: string): Manifest | undefined {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), 'utf8'));
    return m && m.tool === 'vs-studio5000' ? (m as Manifest) : undefined;
  } catch {
    return undefined;
  }
}

export function readModel(dir: string): Controller | undefined {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, MODEL), 'utf8')) as Controller;
    c.modules ??= [];
    return c;
  } catch {
    return undefined;
  }
}

export type ExportHealth = 'ok' | 'stale' | 'missing' | 'broken';

export function exportHealth(sourcePath: string, dir: string): ExportHealth {
  if (!fs.existsSync(path.join(dir, 'CODEBASE.md'))) return 'missing';
  const m = readManifest(dir);
  if (!m || !fs.existsSync(path.join(dir, MODEL))) return 'broken';
  if (m.format !== EXPORT_FORMAT) return 'stale';
  try {
    const fp = fingerprintOf(sourcePath);
    return fp.size === m.fingerprint.size && fp.mtimeMs === m.fingerprint.mtimeMs ? 'ok' : 'stale';
  } catch {
    return 'broken';
  }
}

/**
 * Fingerprint of what a routine file says, not how it is laid out: routine name and type,
 * description, and each rung's logic (canonical spacing) and comment, or the ST lines.
 * Rung markers, branch layout, blank lines and surrounding whitespace in comments are ignored.
 */
export function contentHash(text: string): string {
  const f = parseRoutineFile(text);
  const trimLines = (s: string | undefined) => (s ?? '').split('\n').map(l => l.replace(/\s+$/, '')).join('\n').trim();
  return sha1(JSON.stringify({
    routine: f.header.routine,
    type: f.header.type,
    description: trimLines(f.header.description),
    rungs: f.rungs.map(g => [canonicalRung(g.text), trimLines(g.comment)]),
    lines: (f.lines ?? []).map(l => l.replace(/\s+$/, '')),
  }));
}

/**
 * Routine files the user has changed since they were exported. Compared by content
 * (contentHash) when the manifest has it, so re-layout by another plugin version is not an edit.
 */
export function editedFiles(dir: string, manifest = readManifest(dir)): string[] {
  if (!manifest) return [];
  const out: string[] = [];
  for (const [rel, f] of Object.entries(manifest.files)) {
    if (!f.editable) continue;
    const full = path.join(dir, rel);
    if (!fs.existsSync(full)) continue;
    const text = fs.readFileSync(full, 'utf8');
    if (sha1(text) === f.hash) continue;
    if (f.content && contentHash(text) === f.content) continue;
    out.push(rel);
  }
  return out;
}

/** Thrown when another window is exporting the same project into the same folder. */
export class ExportBusyError extends Error {
  readonly code = 'EXPORT_BUSY';
}

const LOCK = '.export.lock';
const LOCK_STALE_MS = 10 * 60 * 1000;

/**
 * Exclusive lock on an export folder, so two VS Code windows never write it at the same time
 * (one writing routine files while the other writes the manifest leaves them inconsistent).
 * A lock left by a crashed or closed window is taken over.
 */
function acquireLock(dir: string): () => void {
  const file = path.join(dir, LOCK);
  const mine = JSON.stringify({ pid: process.pid, at: Date.now() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, mine, { flag: 'wx' });
      return () => { try { if (fs.readFileSync(file, 'utf8') === mine) fs.unlinkSync(file); } catch { /* gone */ } };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let holder: { pid?: number; at?: number } = {};
      try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable: treat as stale */ }
      const alive = (() => {
        if (!holder.pid || holder.pid === process.pid) return false;
        try { process.kill(holder.pid, 0); return true; } catch { return false; }
      })();
      if (alive && Date.now() - (holder.at ?? 0) < LOCK_STALE_MS) {
        throw new ExportBusyError('Another VS Code window is exporting this project right now.');
      }
      try { fs.unlinkSync(file); } catch { /* raced */ }
    }
  }
  throw new ExportBusyError('Could not lock the export folder.');
}

/** A name made safe for use as a file or folder name. */
export function safeName(s: string): string {
  return s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_');
}

function writeIfChanged(file: string, content: string): boolean {
  try {
    if (fs.readFileSync(file, 'utf8') === content) return false;
  } catch { /* new file */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return true;
}

function md(s: string | undefined): string {
  return (s ?? '').replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();
}

function dimsText(d?: number[]): string {
  return d && d.length ? `[${d.join(',')}]` : '';
}

function csvCell(s: string | undefined): string {
  const v = s ?? '';
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function routineExt(r: Routine): string {
  return r.type === 'RLL' ? RLL_EXT : ST_EXT;
}

export function routineRelPath(owner: { program?: string; aoi?: string }, r: Routine): string {
  const folder = owner.aoi ? path.join('AOIs', safeName(owner.aoi)) : path.join('Programs', safeName(owner.program ?? '_'));
  return path.join(folder, safeName(r.name) + routineExt(r)).replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------------------
// Cross reference
// ---------------------------------------------------------------------------------------

interface RefEntry {
  reads: Map<string, number[]>;             // routine path → rung numbers (ST: line indexes)
  writes: Map<string, number[]>;            // "routine path\u0000instr\u0000operand" → rungs / lines
}

export interface CrossRef {
  /** Key: scope + "/" + base tag, scope = "" for controller, program name, or "aoi:<name>". */
  refs: Map<string, RefEntry>;
  calls: Map<string, Set<string>>;          // "Program/Routine" → routines it JSRs to
  /** Routine paths whose numbers are ST line indexes rather than rung numbers. */
  st: Set<string>;
}

/** How a location in routine `where` is written: `Prog/Routine#12` or `Prog/Routine#L13`. */
export function xrefLoc(x: CrossRef, where: string, n: number): string {
  return `${where}${locText(n, x.st.has(where))}`;
}

/** "rungs 3, 4" or "lines 13, 20" for routine `where`. */
export function xrefList(x: CrossRef, where: string, ns: number[]): string {
  return locList(ns, x.st.has(where));
}

function push(m: Map<string, number[]>, k: string, v: number) {
  const a = m.get(k);
  if (!a) m.set(k, [v]);
  else if (a[a.length - 1] !== v) a.push(v);
}

export function buildCrossRef(c: Controller, aois: AoiIndex = buildAoiIndex(c)): CrossRef {
  const refs = new Map<string, RefEntry>();
  const calls = new Map<string, Set<string>>();
  const st = new Set<string>();
  // Tag names are case-insensitive in Logix; ST in particular often differs in case.
  const controllerTags = new Map([...c.tags, ...(c.moduleTags ?? [])].map(t => [t.name.toLowerCase(), t.name]));

  const scan = (scopeName: string, scopeTags: Map<string, string>, owner: string, routines: Routine[]) => {
    for (const r of routines) {
      const where = `${owner}/${r.name}`;
      if (isStRoutine(r)) st.add(where);
      for (const unit of routineUnits(r, aois)) {
        for (const u of unit.uses) {
          const lower = u.base.toLowerCase();
          const local = scopeTags.get(lower);
          const global = local ? undefined : controllerTags.get(lower);
          const scope = local ? scopeName : global ? '' : scopeName;
          const key = `${scope}/${local ?? global ?? u.base}`;
          let e = refs.get(key);
          if (!e) { e = { reads: new Map(), writes: new Map() }; refs.set(key, e); }
          // AOI calls name the parameter the tag is bound to: AOI_X.Param
          const ins = u.via && u.via !== 'instance' ? `${u.instruction}.${u.via}` : u.instruction;
          if (u.write) push(e.writes, `${where}\u0000${ins}\u0000${u.operand}`, unit.n);
          else push(e.reads, where, unit.n);
        }
        for (const t of unit.calls) {
          let s = calls.get(where);
          if (!s) { s = new Set(); calls.set(where, s); }
          s.add(t);
        }
      }
    }
  };
  const names = (list: { name: string }[]) => new Map(list.map(t => [t.name.toLowerCase(), t.name]));
  for (const p of c.programs) scan(p.name, names(p.tags), p.name, p.routines);
  for (const a of c.aois) {
    scan(`aoi:${a.name}`, names([...a.parameters, ...a.localTags]), `AOI ${a.name}`, a.routines);
  }
  return { refs, calls, st };
}

function refCounts(x: CrossRef, scope: string, tag: string): { r: number; w: number } {
  const e = x.refs.get(`${scope}/${tag}`);
  if (!e) return { r: 0, w: 0 };
  let r = 0; let w = 0;
  for (const v of e.reads.values()) r += v.length;
  for (const v of e.writes.values()) w += v.length;
  return { r, w };
}

// ---------------------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------------------

function rungCount(rs: Routine[]): number {
  return rs.reduce((a, r) => a + r.rungs.length, 0);
}

function renderCodebase(c: Controller, fp: Fingerprint, sourcePath: string, exportedAt: string, s: ExportSummary): string {
  const L: string[] = [];
  const routines = c.programs.flatMap(p => p.routines);
  L.push(`# ${c.name} — Studio 5000 project export`, EXPORT_STAMP, '');
  L.push(`**Source:** \`${sourcePath}\`  `);
  L.push(`**Source fingerprint:** size=${fp.size};mtimeMs=${fp.mtimeMs}  `);
  L.push(`**Exported:** ${exportedAt}  `);
  const ver = [c.revision && `controller firmware ${c.revision}`, c.softwareVersion].filter(Boolean).join(' · ');
  if (ver) L.push(`**Version:** ${ver}  `);
  L.push(`**Decoded from:** ${c.source === 'ACD' ? '.ACD (read-only binary decode)' : '.L5X'}`, '');
  if (c.description) L.push('> ' + c.description.split('\n').join('\n> '), '');

  L.push('## Working with this export', '');
  L.push('- Routines are plain text: `Programs/<Program>/<Routine>.rll` (ladder, one rung per line) and `.st` (Structured Text, the source exactly as written, comments included). AOI logic is under `AOIs/<AOI>/`.');
  L.push('- Rung text is Logix neutral text exactly as Studio 5000 shows it in "Edit Rung": `XIC(Start)OTE(Motor);`, branches `[A ,B ]`.');
  L.push('- A `// > text` line is the comment of the rung below it. Other `//` lines are ignored.');
  L.push('- Locations: `Program/Routine#12` is rung 12; `Program/Routine#L40` is line 40 of an ST routine (1-based, as Studio 5000 numbers it).');
  L.push('- FBD and SFC routines (L5X only) are shown as a read-only text view in ST syntax: each wire as `Pin := Source;`.');
  L.push('- Edits never touch the project file. Run **Studio 5000: Build L5X Import** to package edited ladder and ST routines as `.L5X` files for Studio 5000 (right-click the program > Add > Import Routine).');
  L.push('- Where is a tag written or read? **CROSSREF.md** → `xref/<scope>.md`. What runs when? **PROJECT_MAP.md**. Tag types and descriptions: **TAGS.md**, **DATATYPES.md**, **AOIS.md**. Hardware: **MODULES.md**.');
  L.push('- Checks generated from the logic: **SAFETY.md** (safety devices: mapped, consumed, bypassed, reaching an output), **BYPASSES.md** (shorted or disabled contacts), **UNCONSUMED.md** (written but never read).', '');

  L.push('## Summary', '');
  L.push('| Item | Count |', '|---|---|');
  L.push(`| Tasks | ${c.tasks.length} |`);
  L.push(`| Programs | ${c.programs.length} |`);
  const byType = (t: string) => routines.filter(r => r.type === t).length;
  const stLines = routines.reduce((a, r) => a + (r.type === 'ST' ? r.lines?.length ?? 0 : 0), 0);
  const kinds = [`${byType('RLL')} ladder, ${rungCount(routines)} rungs`, byType('ST') && `${byType('ST')} ST, ${stLines} lines`,
    byType('FBD') && `${byType('FBD')} FBD`, byType('SFC') && `${byType('SFC')} SFC`].filter(Boolean).join('; ');
  L.push(`| Routines | ${routines.length} (${kinds}) |`);
  L.push(`| Add-On Instructions | ${c.aois.length}${c.aois.some(a => a.safety) ? ` (${c.aois.filter(a => a.safety).length} safety)` : ''} |`);
  L.push(`| I/O modules | ${c.modules.length} |`);
  L.push(`| User-defined types | ${c.dataTypes.filter(d => d.kind === 'udt').length} |`);
  L.push(`| Controller tags | ${c.tags.length} |`);
  L.push(`| Program tags | ${c.programs.reduce((a, p) => a + p.tags.length, 0)} |`, '');

  L.push('## Tasks', '');
  L.push('| Task | Type | Rate (ms) | Priority | Watchdog (ms) | Programs |', '|---|---|---|---|---|---|');
  for (const t of c.tasks) {
    L.push(`| ${t.name}${t.safety ? ' (safety)' : ''} | ${t.type} | ${t.rateMs ?? ''} | ${t.priority ?? ''} | ${t.watchdogMs ?? ''} | ${t.programs.length} |`);
  }
  const scheduled = new Set(c.tasks.flatMap(t => t.programs));
  const unscheduled = c.programs.filter(p => !scheduled.has(p.name)).map(p => p.name);
  if (unscheduled.length) L.push('', `**Unscheduled programs (never execute):** ${unscheduled.join(', ')}`);
  L.push('');

  L.push('## Programs', '');
  L.push('| Program | Main routine | Routines | Rungs | Tags | Description |', '|---|---|---|---|---|---|');
  for (const p of c.programs) {
    L.push(`| [${p.name}](#${anchor(p.name)}) | ${p.mainRoutine ?? ''} | ${p.routines.length} | ${rungCount(p.routines)} | ${p.tags.length} | ${md(p.description)} |`);
  }
  L.push('');
  for (const p of c.programs) {
    L.push(`### ${p.name}`, '');
    if (p.description) L.push(md(p.description), '');
    const bits = [`Main: \`${p.mainRoutine ?? '—'}\``];
    if (p.faultRoutine) bits.push(`Fault: \`${p.faultRoutine}\``);
    if (p.disabled) bits.push('**Disabled**');
    if (p.safety) bits.push('**Safety program**');
    bits.push(`Tags: \`Programs/${safeName(p.name)}/Tags.csv\``);
    L.push(bits.join(' · '), '');
    for (const r of p.routines) {
      const size = r.type === 'RLL' ? `${r.rungs.length} rungs` : r.undecoded ? 'not decoded'
        : r.rendered ? 'text view' : `${r.lines?.length ?? 0} lines`;
      L.push(`- [\`${r.name}\`](${encodeURI(routineRelPath({ program: p.name }, r))}) ${r.type}, ${size}${r.description ? ` — ${md(r.description)}` : ''}`);
    }
    L.push('');
  }

  if (c.aois.length) {
    L.push('## Add-On Instructions', '', 'Parameters and logic: **AOIS.md** and `AOIs/<Name>/`.', '');
    L.push('| AOI | Parameters | Routines | Description |', '|---|---|---|---|');
    for (const a of c.aois) {
      L.push(`| ${a.name} | ${a.parameters.length} | ${a.routines.map(r => r.name).join(', ')} | ${md(a.description)} |`);
    }
    L.push('');
  }

  const safetyTask = c.tasks.find(t => t.safety);
  if (safetyTask || c.aois.some(a => a.safety) || c.tags.some(t => t.safety)) {
    const tagsAll = [...c.tags, ...c.programs.flatMap(p => p.tags)];
    L.push('## Safety information', '',
      'Decoded from the project file (never inferred from names). SAFETY.md is built on this.', '',
      '| Item | Found |', '|---|---|');
    L.push(`| Safety task | ${safetyTask ? `${safetyTask.name}${safetyTask.rateMs !== undefined ? `, ${safetyTask.rateMs} ms` : ''}` : 'none'} |`);
    L.push(`| Safety programs | ${c.programs.filter(p => p.safety).map(p => p.name).join(', ') || 'none'} |`);
    L.push(`| Safety-class tags | ${tagsAll.filter(t => t.safety).length} |`);
    L.push(`| Safety-class AOIs | ${c.aois.filter(a => a.safety).map(a => a.name).join(', ') || 'none'} |`);
    L.push(`| Safety I/O modules | ${c.modules.filter(m => m.safety).map(m => m.name).join(', ') || 'none'} |`);
    L.push(`| Safety tag map entries | ${c.safetyTagMap?.length ?? 0} |`, '');
    if (c.safetyTagMap?.length) {
      L.push('Safety tag map (each scan the standard tag is copied into the safety tag):', '');
      for (const m of c.safetyTagMap) L.push(`- \`${m.standard}\` → \`${m.safety}\``);
      L.push('');
    }
  }

  if (c.unused && (c.unused.aois.length || c.unused.dataTypes.length)) {
    L.push('## Unused definitions', '',
      `${c.unused.aois.length} AOI record(s) with no parameters, logic or calls and ${c.unused.dataTypes.length} predefined or ` +
      'module data type(s) nothing refers to are left out of the lists and counts above. They are listed in **UNUSED.md**.', '');
  }

  if (s.keptEdited.length) {
    L.push('## Routine files with pending edits', '');
    if (implausibleEdits(s)) {
      L.push(`**${s.keptEdited.length} of ${s.routineFiles} routine files differ from the project.** That is more than anyone`,
        'edits by hand: most likely two VS Code windows (or two plugin versions) wrote this export folder at',
        'the same time. If you did not edit them, run **Studio 5000: Discard Edits** to restore them before',
        'building any L5X import.', '');
    } else {
      L.push(`${s.keptEdited.length} routine file(s) were edited here and kept as they were (they are not in this export's`,
        'content until packaged with **Build L5X Import from Edits** or restored with **Discard Edits**):', '');
    }
    for (const rel of s.keptEdited.slice(0, 50)) L.push(`- \`${rel}\``);
    if (s.keptEdited.length > 50) L.push(`- … ${s.keptEdited.length - 50} more`);
    L.push('');
  }

  if (c.warnings.length) {
    L.push('## Decoder notes', '');
    for (const w of c.warnings.slice(0, 200)) L.push(`- ${w}`);
    if (c.warnings.length > 200) L.push(`- … ${c.warnings.length - 200} more`);
    L.push('');
  }
  const undecoded = [
    ...c.programs.flatMap(p => p.routines.filter(r => r.undecoded).map(r => ({ where: `${p.name}/${r.name}`, r }))),
    ...c.aois.flatMap(a => a.routines.filter(r => r.undecoded).map(r => ({ where: `AOI ${a.name}/${r.name}`, r }))),
  ];
  if (undecoded.length) {
    L.push('## Routines not decoded', '');
    L.push('Their logic is not in this export. Everything else about them (name, type, description, calls to them) is.', '');
    for (const u of undecoded) L.push(`- \`${u.where}\` (${u.r.type}): ${u.r.undecoded}`);
    L.push('');
  }
  if (c.saveLog?.length) {
    L.push('## Save history (latest 10)', '');
    for (const s of c.saveLog.slice(-10)) L.push(`- ${s}`);
    L.push('');
  }
  return L.join('\n');
}

function anchor(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_ -]/g, '').replace(/ /g, '-');
}

function renderProjectMap(c: Controller, x: CrossRef): string {
  const L: string[] = [`# ${c.name} — execution map`, EXPORT_STAMP, ''];
  L.push('Each task runs its programs in the order listed. Each program runs its **main routine**,',
    'which reaches other routines only through `JSR`. Routines reached by no JSR never run',
    '(unless they are the fault routine or an AOI routine).', '');
  const progByName = new Map(c.programs.map(p => [p.name, p]));
  const renderTree = (p: Program, routine: string, depth: number, seen: Set<string>) => {
    const pad = '  '.repeat(depth);
    const r = p.routines.find(x => x.name === routine);
    const file = r ? ` → \`${routineRelPath({ program: p.name }, r)}\`` : ' (missing)';
    if (seen.has(routine)) { L.push(`${pad}- ${routine} (recursive, see above)`); return; }
    L.push(`${pad}- **${routine}**${file}`);
    seen.add(routine);
    for (const t of [...(x.calls.get(`${p.name}/${routine}`) ?? [])]) renderTree(p, t, depth + 1, seen);
    seen.delete(routine);
  };
  for (const t of c.tasks) {
    const rate = t.type === 'PERIODIC' && t.rateMs !== undefined ? `, every ${t.rateMs} ms` : '';
    L.push(`## Task ${t.name} (${t.type}${rate}, priority ${t.priority ?? '?'})`, '');
    for (const pn of t.programs) {
      const p = progByName.get(pn);
      L.push(`### ${pn}`);
      if (!p) { L.push('- (program not found)', ''); continue; }
      if (p.mainRoutine) renderTree(p, p.mainRoutine, 0, new Set());
      else L.push('- (no main routine)');
      const reached = new Set<string>();
      const walk = (n: string) => {
        if (reached.has(n)) return;
        reached.add(n);
        for (const t2 of x.calls.get(`${p.name}/${n}`) ?? []) walk(t2);
      };
      if (p.mainRoutine) walk(p.mainRoutine);
      if (p.faultRoutine) walk(p.faultRoutine);
      const orphan = p.routines.filter(r => !reached.has(r.name)).map(r => r.name);
      if (orphan.length) L.push(`- _Not called from main:_ ${orphan.join(', ')}`);
      L.push('');
    }
  }
  return L.join('\n');
}

/** Cross-reference file for a scope: "" controller, program name, or "aoi:<name>". */
export function xrefRelPath(scope: string): string {
  const f = scope === '' ? 'Controller' : scope.startsWith('aoi:') ? `AOI_${scope.slice(4)}` : `Program_${scope}`;
  return `xref/${safeName(f)}.md`;
}

function scopeTitle(scope: string): string {
  return scope === '' ? 'Controller tags' : scope.startsWith('aoi:') ? `AOI ${scope.slice(4)}` : `Program ${scope}`;
}

/** CROSSREF.md (index) plus one xref/<scope>.md per scope. */
function renderCrossRef(c: Controller, x: CrossRef): Map<string, string> {
  const files = new Map<string, string>();
  const typeOf = new Map<string, Tag>();
  for (const t of [...c.tags, ...(c.moduleTags ?? [])]) typeOf.set(`/${t.name}`, t);
  for (const p of c.programs) for (const t of p.tags) typeOf.set(`${p.name}/${t.name}`, t);
  const byScope = new Map<string, string[]>();
  for (const k of x.refs.keys()) {
    const [scope] = split(k);
    const list = byScope.get(scope) ?? [];
    list.push(k);
    byScope.set(scope, list);
  }
  const scopes = [...byScope.keys()].sort((a, b) =>
    a === b ? 0 : a === '' ? -1 : b === '' ? 1 : a.startsWith('aoi:') !== b.startsWith('aoi:') ? (a.startsWith('aoi:') ? 1 : -1) : a.localeCompare(b));

  const index: string[] = [`# ${c.name} — tag cross reference`, EXPORT_STAMP, ''];
  index.push('One file per scope under `xref/`. In each, every tag has a `### Tag` heading followed by',
    '**W** lines (rungs or ST lines that write it: instruction, AOI parameter if any, exact operand) and **R**',
    'lines (rungs or ST lines that read it). In ST, `:=` marks an assignment; `ST` a read. AOI calls are',
    'resolved through the AOI definition: an InOut argument is listed at the members the AOI logic actually',
    'reads and writes, e.g. `W … MyAoi.DeviceObj `Zone1.Ok``.',
    '', 'Faster for one tag: `Find Tag Usage` in VS Code, or the `xref` command in CLAUDE.md.', '');
  index.push('| Scope | Tags referenced | File |', '|---|---|---|');

  for (const scope of scopes) {
    const rel = xrefRelPath(scope);
    const keys = byScope.get(scope)!.sort((a, b) => split(a)[1].localeCompare(split(b)[1]));
    index.push(`| ${scopeTitle(scope)} | ${keys.length} | [${rel}](${encodeURI(rel)}) |`);
    const L: string[] = [`# ${c.name} — ${scopeTitle(scope)}: cross reference`, EXPORT_STAMP, ''];
    for (const k of keys) {
      const [, tag] = split(k);
      const e = x.refs.get(k)!;
      const t = typeOf.get(k);
      const known = t || scope.startsWith('aoi:') ? '' : ' _(not a known tag: module I/O, alias or undefined)_';
      L.push(`### ${tag}${t ? ` : ${t.dataType}${dimsText(t.dimensions)}` : ''}${known}`);
      if (t?.description) L.push(`_${md(t.description)}_`);
      for (const [wk, rungs] of e.writes) {
        const [where, ins, op] = wk.split('\u0000') as [string, string, string];
        L.push(`- W \`${where}\` ${xrefList(x, where, rungs)} — ${ins} \`${op}\``);
      }
      for (const [where, rungs] of e.reads) L.push(`- R \`${where}\` ${xrefList(x, where, rungs)}`);
      L.push('');
    }
    files.set(rel, L.join('\n'));
  }
  files.set('CROSSREF.md', index.join('\n') + '\n');
  return files;
}

// ---------------------------------------------------------------------------------------
// Safety, bypass and dangling-signal reports
// ---------------------------------------------------------------------------------------

function refLink(r: { program: string; routine: string; rung: number }): string {
  return `\`${refText(r)}\``;
}

function refsText(refs: { program: string; routine: string; rung: number }[], max = 6): string {
  const uniq = [...new Map(refs.map(r => [refText(r), r])).values()];
  const shown = uniq.slice(0, max).map(refLink).join(', ');
  return uniq.length > max ? `${shown} … +${uniq.length - max}` : shown;
}

const BYPASS_LABEL: Record<Bypass['kind'], string> = {
  'empty-leg': 'Empty parallel leg: the contacts beside it are shorted',
  'nop-leg': 'NOP-only parallel leg: the contacts beside it are shorted',
  'afi': 'AFI(): everything in series with it is disabled',
  'never-true': 'XIC and XIO of the same bit in series: never true',
  'always-true': 'XIC and XIO of the same bit in parallel: always true',
};

function renderBypassList(L: string[], list: Bypass[]): void {
  if (!list.length) { L.push('None found.', ''); return; }
  L.push('| Where | Finding | Shorted / disabled |', '|---|---|---|');
  for (const b of list) L.push(`| ${refLink(b.ref)} | ${BYPASS_LABEL[b.kind]} | \`${md(b.affected).slice(0, 300)}\` |`);
  L.push('');
}

function renderDangling(L: string[], list: DanglingPath[], verb: string): void {
  if (!list.length) { L.push('None found.', ''); return; }
  L.push(`| Operand | Scope | ${verb} at | By |`, '|---|---|---|---|');
  for (const d of list) {
    L.push(`| \`${d.operand}\` | ${d.scope || 'controller'} | ${refsText(d.refs)} | ${d.instructions.join(', ')} |`);
  }
  L.push('');
}

function renderSafety(c: Controller, f: ProjectFacts, devices: SafetyDevice[], orphans: OrphanDevice[], bypasses: Bypass[],
  allUnconsumed: DanglingPath[], allUnproduced: DanglingPath[]): string {
  // Core safety signals: safety-class tags, and anything in or read by a safety program.
  const safetyPrograms = f.safetyPrograms;
  const baseOf = (operand: string) => (operand.split(/[.[]/)[0] ?? '').trim().toLowerCase();
  const core = (d: DanglingPath) => safetyPrograms.has(d.scope) || f.isSafetyTag(`${d.scope}|${baseOf(d.operand)}`) ||
    d.refs.some(r => safetyPrograms.has(r.program));
  const coreUnconsumed = allUnconsumed.filter(core);
  const unconsumed = coreUnconsumed.filter(d => d.kind !== 'aoi-output');
  const diagnostics = coreUnconsumed.filter(d => d.kind === 'aoi-output');
  const orphanNames = new Set(orphans.map(o => o.tag.toLowerCase()));
  // Only orphans on the safety side belong in the flag list; standard-side ones are listed below.
  const safetyOrphans = orphans.filter(o => f.isSafetyTag(`${o.scope}|${o.tag.toLowerCase()}`) || o.readers.some(r => safetyPrograms.has(r.program)));
  const otherOrphans = orphans.filter(o => !safetyOrphans.includes(o));
  const unproduced = allUnproduced.filter(core)
    .filter(d => !orphanNames.has((d.operand.split(/[.[]/)[0] ?? '').toLowerCase()));
  const partial = unproduced.filter(d => d.kind === 'partial');
  const external = unproduced.filter(d => d.kind !== 'partial');
  const L: string[] = [`# ${c.name} — safety signal check`, EXPORT_STAMP, ''];
  const sinks = f.cfg.sinks.length ? `, else one of the configured sinks (${f.cfg.sinks.map(r => `\`${r.source}\``).join(', ')}, in that priority)` : '';
  const pat = (r: RegExp | undefined) => (r ? `\`${r.source}\`` : '');
  const safetyTags = [...c.tags, ...c.programs.flatMap(p => p.tags)].filter(t => t.safety).length;
  L.push('Generated from the logic. It does not replace a safety validation, but it lists what to look at first.',
    '**Start with "Flagged devices"**: the tables further down are supporting detail.', '',
    '- **Safety scope**, from what the project itself records: the safety task\'s programs',
    `  (${[...safetyPrograms].join(', ') || 'none found'}), ${safetyTags} safety-class tags, ${c.aois.filter(a => a.safety).length} safety-class AOIs,`,
    `  ${c.modules.filter(m => m.safety).length} safety I/O modules and ${c.safetyTagMap?.length ?? 0} safety tag map entries.` +
      (f.cfg.names ? ` Also operands matching ${pat(f.cfg.names)} (studio5000.safety.namePattern).` : ' No name rules (studio5000.safety.namePattern is empty).'),
    '- **Devices**: every call of a safety AOI (safety-class, or called from a safety program' +
      (f.cfg.deviceAoi ? `, or matching ${pat(f.cfg.deviceAoi)}` : '') + ').',
    (f.cfg.result
      ? `  Each device is judged on its result: the output member matching ${pat(f.cfg.result)}.`
      : '  Each device is judged on all its outputs (no result member is configured, so none is singled out):' +
        '\n  it is flagged when **no** output is read; for the outputs that are read, the table shows who reads them,' +
        '\n  whether any reaches something that acts, and whether any is read through a bypassed contact.'),
    `  "Reaches" means the signal gets to an output or safety-output module tag (\`:O\`/\`:SO\`)${sinks}.`,
    '  The chain is rung-level (line-level in ST): every read is taken to feed every write.',
    '- **Devices with no AOI call**: tags of a device type (a type passed to a safety AOI as its device object)',
    '  that logic reads but nothing ever produces.',
    '- Devices whose output is not read, reaches nothing, or is read through a **bypassed** contact are marked ⚠.', '');

  type Out = SafetyDevice['outputs'][number];
  /** `.S_On` for a member output; the whole operand when an output is bound to a plain tag. */
  const member = (o: Out) => {
    const i = o.operand.lastIndexOf('.');
    return i < 0 ? o.operand : o.operand.slice(i);
  };
  /**
   * The outputs a device is judged on: the configured result member when one matches;
   * otherwise every output some other logic reads (or, if none is read, all of them).
   */
  const judged = (d: SafetyDevice): Out[] => {
    const outputs = merged(d);
    const named = f.cfg.result ? outputs.filter(o => f.cfg.result!.test(o.operand)) : [];
    if (named.length) return named;
    const read = outputs.filter(o => o.consumers.length);
    return read.length ? read : outputs;
  };
  /** One entry per member: an AOI can write the same member through more than one path. */
  const mergedCache = new Map<SafetyDevice, Out[]>();
  function merged(d: SafetyDevice): Out[] {
    let out = mergedCache.get(d);
    if (out) return out;
    const byOp = new Map<string, Out>();
    for (const o of d.outputs) {
      const k = o.operand.toLowerCase();
      const prev = byOp.get(k);
      if (!prev) { byOp.set(k, { ...o, consumers: [...o.consumers], bypassedAt: [...o.bypassedAt] }); continue; }
      prev.consumers.push(...o.consumers);
      prev.bypassedAt.push(...o.bypassedAt);
      prev.reaches ??= o.reaches;
    }
    out = [...byOp.values()];
    mergedCache.set(d, out);
    return out;
  }
  const problems = (d: SafetyDevice): string[] => {
    const outs = judged(d);
    if (!outs.length) return ['⚠ writes no output'];
    const read = outs.filter(o => o.consumers.length);
    if (!read.length) return [outs.length === 1 && f.cfg.result ? '⚠ not consumed' : '⚠ no output is read'];
    const w: string[] = [];
    if (!read.some(o => o.reaches)) w.push('⚠ reaches no output');
    // With several outputs, name each in full: two can share a member name (Dev.EMS.S_On, Dev.S_On).
    const name = (o: Out) => (read.length > 1 ? o.operand : member(o));
    for (const o of read) if (o.bypassedAt.length) w.push(`⚠ ${name(o)} bypassed at ${refsText(o.bypassedAt, 3)}`);
    return w;
  };
  /** How a device is named in the lists: its judged output(s), or the instance. */
  const label = (d: SafetyDevice) => {
    const outs = judged(d);
    if (outs.length === 1) return outs[0]!.operand;
    if (!outs.length) return d.instance;
    const bases = new Set(outs.map(o => o.operand.slice(0, Math.max(0, o.operand.lastIndexOf('.')))));
    const [base] = [...bases];
    return bases.size === 1 && base ? `${base}{${outs.map(member).join(',')}}` : outs.map(o => o.operand).join(', ');
  };
  const flagged = devices.filter(d => problems(d).length);
  L.push('## Summary', '');
  L.push(`- Safety AOI calls: ${devices.length}, flagged: ${flagged.length}`);
  L.push(`- Device tags read in logic with no AOI call producing them: ${safetyOrphans.length} safety-side (flagged), ${otherOrphans.length} standard-side`);
  L.push(`- Safety-related bypasses: ${bypasses.filter(b => b.safety).length}`);
  L.push(`- Safety signals written but never read: ${unconsumed.length} (plus ${diagnostics.length} other AOI outputs nobody reads, listed last)`);
  L.push(`- Safety signals read but never produced: ${partial.length} inside logic-produced tags, ${external.length} in tags logic never writes (mapped / consumed / HMI)`, '');

  const byProgram = new Map<string, SafetyDevice[]>();
  for (const d of devices) {
    const list = byProgram.get(d.ref.program) ?? [];
    list.push(d);
    byProgram.set(d.ref.program, list);
  }
  const orphanLine = (o: OrphanDevice) => {
    const byp = o.bypassedAt.length ? `; ⚠ bypassed at ${refsText(o.bypassedAt, 3)}` : '';
    return `- \`${o.tag}\` (${o.dataType}${o.scope ? `, program ${o.scope}` : ''}): ⚠ no device call — read at ${refsText(o.readers, 4)} but never produced${byp}`;
  };
  L.push('## Flagged devices', '');
  if (!flagged.length && !safetyOrphans.length) L.push('None.');
  for (const d of flagged) L.push(`- \`${label(d)}\` (${d.aoi}, mapped at ${refLink(d.ref)}): ${problems(d).join('; ')}`);
  for (const o of safetyOrphans) L.push(orphanLine(o));
  L.push('');
  if (otherOrphans.length) {
    L.push('## Standard-side device tags with no producer', '',
      'Device-type tags read only outside the safety task that nothing writes: leftovers or renamed devices,',
      'not part of the E-stop chain.', '');
    for (const o of otherOrphans) L.push(orphanLine(o));
    L.push('');
  }
  L.push('## Devices', '',
    'One row per safety AOI call. **Output** is what the device is judged on (see above);',
    '**Outputs not read** lists the other members the AOI writes that no logic reads.', '');
  for (const [prog, list] of [...byProgram.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    L.push(`### ${prog}`, '');
    L.push('| Output | AOI | Input | Mapped at | Read by | Reaches | Outputs not read | |', '|---|---|---|---|---|---|---|---|');
    for (const d of list) {
      const outs = judged(d);
      const input = d.inputs.map(i => `\`${i.value}\``).join(' ') || '—';
      const reached = outs.find(o => o.reaches)?.reaches;
      const reach = !reached ? '—'
        : !reached.chain.length ? 'is itself a sink'
          : `\`${reached.sink}\` (${reached.chain.length} rung${reached.chain.length === 1 ? '' : 's'})`;
      const readers = outs.flatMap(o => o.consumers);
      const unused = merged(d).filter(x => !outs.includes(x) && !x.consumers.length).map(member).join(', ') || '—';
      L.push(`| \`${label(d)}\` | ${d.aoi} | ${input} | ${refLink(d.ref)} | ${readers.length ? refsText(readers, 4) : '—'} | ${reach} | ${unused} | ${problems(d).join('; ')} |`);
    }
    L.push('');
  }
  const chains = devices.flatMap(judged).filter(o => o.reaches?.chain.length);
  if (chains.length) {
    L.push('## How each device output reaches its sink', '');
    for (const o of chains) L.push(`- \`${o!.operand}\`: ${o!.reaches!.chain.join(' ⇒ ')}`);
    L.push('');
  }
  L.push('## Safety-related bypasses', '');
  renderBypassList(L, bypasses.filter(b => b.safety));
  L.push('## Safety signals written but never read', '',
    'Mapped or computed in safety logic and then used nowhere: an input that was wired but never',
    'connected to the E-stop chain, or a leftover. Other outputs written by AOIs into device tags are listed separately below.', '');
  renderDangling(L, unconsumed, 'Written');
  L.push('## Safety signals read but never produced', '',
    '### Inside tags that logic does produce', '',
    'Other members of these tags are written by rungs or AOI calls, but not this one: the most likely',
    'to be a real gap.', '');
  renderDangling(L, partial, 'Read');
  L.push('### In tags no rung writes at all', '',
    'Usually filled from outside the logic: **safety tag mapping** (Logic > Map Safety Tags, which the',
    'decoder does not read, so standard→safety copies land here unless `studio5000.safety.mappedCopyPattern`',
    'names them), produced/consumed tags, HMI/SCADA, or output-image bits that are only echoed to the module.',
    'Check only if the tag is not one of those.', '');
  renderDangling(L, external, 'Read');
  L.push('## Other AOI outputs nobody reads', '',
    'Members a safety AOI writes into its device tag that no logic reads (status and fault bits, channel states).',
    'Normally fine: listed for completeness.', '');
  renderDangling(L, diagnostics, 'Written');
  return L.join('\n');
}

function renderBypasses(c: Controller, bypasses: Bypass[]): string {
  const L: string[] = [`# ${c.name} — bypassed and disabled logic`, EXPORT_STAMP, ''];
  L.push('Structural findings in rung logic. Each one makes contacts irrelevant to the rung result:',
    '', ...Object.values(BYPASS_LABEL).map(s => `- ${s}`), '',
    'Safety-related findings (a safety-class or safety-program tag, or an operand matching the',
    '`studio5000.safety.namePattern` setting) are listed first. Ladder only: ST has no contacts to short.', '');
  L.push('## Safety-related', '');
  renderBypassList(L, bypasses.filter(b => b.safety));
  L.push('## Other', '');
  renderBypassList(L, bypasses.filter(b => !b.safety));
  return L.join('\n');
}

function renderUnconsumed(c: Controller, unconsumed: DanglingPath[]): string {
  const L: string[] = [`# ${c.name} — written but never read`, EXPORT_STAMP, ''];
  L.push('Operands that some rung or ST line writes and nothing reads (reading a whole structure counts as reading',
    'every member; array indices are treated as wildcards). Excluded: output-module tags (read by the',
    'hardware), AOI instances and one-shot storage bits. HMI, SCADA or MSG may still read what is listed here.', '');
  const signals = unconsumed.filter(d => d.kind !== 'aoi-output');
  const diagnostics = unconsumed.filter(d => d.kind === 'aoi-output');
  L.push(`## Safety-related (${signals.filter(d => d.safety).length})`, '');
  renderDangling(L, signals.filter(d => d.safety), 'Written');
  L.push(`## Other (${signals.filter(d => !d.safety).length})`, '');
  renderDangling(L, signals.filter(d => !d.safety), 'Written');
  L.push(`## AOI outputs nobody reads (${diagnostics.length})`, '',
    'Members an AOI writes into the caller\'s tag through an InOut parameter (other than the device result)',
    'that no logic reads. Mostly diagnostics (fault bits, channel states, status words); normally fine.', '');
  renderDangling(L, diagnostics, 'Written');
  return L.join('\n');
}

function split(k: string): [string, string] {
  const i = k.lastIndexOf('/');
  return [k.slice(0, i), k.slice(i + 1)];
}

function renderTags(c: Controller, x: CrossRef): string {
  const L: string[] = [`# ${c.name} — tags`, EXPORT_STAMP, ''];
  L.push('R / W = number of rungs or ST lines reading / writing the tag (see CROSSREF.md). A tag with 0 / 0 is',
    'unused in logic (HMI, SCADA, MSG or produced/consumed connections may still use it).', '',
    'Flags: **S** safety tag · **P** produced · **C** consumed · **K** constant.', '');
  const table = (scope: string, tags: Tag[]) => {
    L.push('| Tag | Type | Flags | R | W | Description |', '|---|---|---|---|---|---|');
    for (const t of [...tags].sort((a, b) => a.name.localeCompare(b.name))) {
      const n = refCounts(x, scope, t.name);
      L.push(`| ${t.name} | ${t.dataType}${dimsText(t.dimensions)}${t.aliasFor ? ` (alias ${t.aliasFor})` : ''} | ${tagFlags(t)} | ${n.r} | ${n.w} | ${md(t.description)} |`);
    }
    L.push('');
  };
  L.push(`## Controller scope (${c.tags.length})`, '');
  table('', c.tags);
  for (const p of c.programs) {
    if (!p.tags.length) continue;
    L.push(`## Program ${p.name} (${p.tags.length})`, '');
    table(p.name, p.tags);
  }
  if (c.moduleTags?.length) {
    L.push(`## Module connection tags (${c.moduleTags.length})`, '',
      'Created by the I/O configuration (see MODULES.md), not user tags: `:I` input, `:O` output, `:C` configuration,',
      '`:SI` / `:SO` safety input / output.', '');
    table('', c.moduleTags);
  }
  return L.join('\n');
}

function tagFlags(t: Tag): string {
  return [t.safety && 'S', t.produced && 'P', t.consumed && 'C', t.constant && 'K',
    t.externalAccess && t.externalAccess !== 'Read/Write' && `(${t.externalAccess})`].filter(Boolean).join(' ');
}

/** UNUSED.md: definitions left out of the other documents because nothing uses them. */
function renderUnused(c: Controller): string {
  const L: string[] = [`# ${c.name} — unused definitions`, EXPORT_STAMP, ''];
  const u = c.unused ?? { aois: [], dataTypes: [] };
  L.push('Definitions the project file contains that nothing in the project uses. They are kept out of',
    'AOIS.md, DATATYPES.md and the counts, and listed here in case they are needed.', '');
  L.push(`## AOI records with no parameters, logic or calls (${u.aois.length})`, '',
    'Usually left behind in the file by a delete or an import. Studio 5000 does not show them.', '');
  if (!u.aois.length) L.push('None.');
  for (const a of u.aois) L.push(`- ${a.name}${a.revision ? ` v${a.revision}` : ''}${a.description ? ` — ${md(a.description)}` : ''}`);
  L.push('');
  const kinds: [DataType['kind'], string][] = [['builtin', 'Predefined data types'], ['module', 'Module-defined data types']];
  for (const [kind, title] of kinds) {
    const list = u.dataTypes.filter(d => d.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
    L.push(`## ${title} no tag, member or parameter uses (${list.length})`, '');
    if (!list.length) L.push('None.');
    for (const d of list) L.push(`- ${d.name}${d.members.length ? ` (${d.members.filter(m => !m.hidden).map(m => `${m.name}: ${m.dataType}`).join(', ')})` : ''}`);
    L.push('');
  }
  return L.join('\n');
}

/** MODULES.md: the I/O tree, parents before children. */
function renderModules(c: Controller): string {
  const L: string[] = [`# ${c.name} — I/O configuration`, EXPORT_STAMP, ''];
  if (!c.modules.length) {
    L.push('No I/O configuration in this project file.');
    return L.join('\n');
  }
  L.push(`${c.modules.length} modules. Module tags appear in logic as \`<Module>:I.…\` / \`:O.…\` (\`:SI\` / \`:SO\` for safety I/O).`,
    'Address is the slot on a backplane or the IP address on Ethernet.', '');
  const children = new Map<string, Module[]>();
  const names = new Set(c.modules.map(m => m.name));
  const roots: Module[] = [];
  for (const m of c.modules) {
    if (m.parent && names.has(m.parent) && m.parent !== m.name) {
      const list = children.get(m.parent) ?? [];
      list.push(m);
      children.set(m.parent, list);
    } else roots.push(m);
  }
  const seen = new Set<string>();
  const walk = (m: Module, depth: number) => {
    if (seen.has(m.name)) return;
    seen.add(m.name);
    const bits = [m.catalogNumber, m.revision && `rev ${m.revision}`, m.address && `@ ${m.address}`,
      m.safety && '**safety**', m.inhibited && '**inhibited**'].filter(Boolean).join(' · ');
    L.push(`${'  '.repeat(depth)}- **${m.name}**${bits ? ` — ${bits}` : ''}${m.description ? ` — ${md(m.description)}` : ''}`);
    const kids = (children.get(m.name) ?? []).sort((a, b) =>
      (a.address ?? '').localeCompare(b.address ?? '', undefined, { numeric: true }) || a.name.localeCompare(b.name));
    for (const k of kids) walk(k, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  for (const m of c.modules) walk(m, 0);
  return L.join('\n') + '\n';
}

function renderDataTypes(c: Controller): string {
  const L: string[] = [`# ${c.name} — user-defined data types`, EXPORT_STAMP, ''];
  const udts = c.dataTypes.filter(d => d.kind === 'udt').sort((a, b) => a.name.localeCompare(b.name));
  const modules = c.dataTypes.filter(d => d.kind === 'module');
  const ATOMIC = /^(BOOL|BIT|SINT|INT|DINT|LINT|USINT|UINT|UDINT|ULINT|REAL|LREAL)$/;
  const predefined = c.dataTypes.filter(d => d.kind === 'builtin' && !ATOMIC.test(d.name) && d.members.length)
    .sort((a, b) => a.name.localeCompare(b.name));
  L.push(`${udts.length} user-defined types. ${predefined.length} predefined and ${modules.length} module-defined types used by this`,
    'project are listed at the end. Types nothing uses are in UNUSED.md.', '');
  for (const d of udts) {
    L.push(`## ${d.name}`);
    if (d.description) L.push(md(d.description));
    L.push('', '| Member | Type | Description |', '|---|---|---|');
    for (const m of d.members.filter(m => !m.hidden)) {
      L.push(`| ${m.name} | ${m.dataType}${dimsText(m.dimensions)}${m.bit !== undefined ? ` (bit ${m.bit}${m.target ? ` of ${m.target}` : ''})` : ''} | ${md(m.description)} |`);
    }
    L.push('');
  }
  if (predefined.length) {
    L.push('## Predefined types used', '');
    for (const d of predefined) L.push(`- ${d.name} (${d.members.filter(m => !m.hidden).map(m => `${m.name}: ${m.dataType}`).join(', ')})`);
    L.push('');
  }
  if (modules.length) {
    L.push('## Module-defined types used', '');
    for (const d of modules) L.push(`- ${d.name} (${d.members.filter(m => !m.hidden).map(m => m.name).join(', ')})`);
  }
  return L.join('\n');
}

function renderAois(c: Controller): string {
  const L: string[] = [`# ${c.name} — Add-On Instructions`, EXPORT_STAMP, ''];
  for (const a of [...c.aois].sort((x, y) => x.name.localeCompare(y.name))) {
    L.push(`## ${a.name}${a.safety ? ' (safety)' : ''}${a.revision ? ` v${a.revision}` : ''}`);
    if (a.description) L.push(md(a.description));
    const logic = a.routines.map(r =>
      `[\`${r.name}\`](${encodeURI(routineRelPath({ aoi: a.name }, r))}) ${r.type}${r.undecoded ? ' (not decoded)' : ''}`);
    L.push('', `Logic: ${logic.join(', ') || '—'}`, '');
    const required = a.parameters.filter(p => p.required && p.name !== 'EnableIn' && p.name !== 'EnableOut');
    if (required.length) {
      L.push(`Call: \`${a.name}(Instance, ${required.map(p => p.name).join(', ')})\``, '');
    }
    if (a.parameters.length) {
      L.push('| Parameter | Type | Usage | Req | Description |', '|---|---|---|---|---|');
      for (const m of a.parameters) {
        L.push(`| ${m.name} | ${m.dataType}${dimsText(m.dimensions)} | ${m.usage ?? ''} | ${m.required ? 'yes' : ''} | ${md(m.description)} |`);
      }
    }
    if (a.localTags.length) {
      L.push('', '| Local tag | Type | Description |', '|---|---|---|');
      for (const m of a.localTags) L.push(`| ${m.name} | ${m.dataType}${dimsText(m.dimensions)} | ${md(m.description)} |`);
    }
    L.push('');
  }
  return L.join('\n');
}

function tagsCsv(tags: Tag[], scope: string, x: CrossRef): string {
  const rows = ['Name,DataType,Dimensions,AliasFor,Flags,Reads,Writes,Description'];
  for (const t of tags) {
    const n = refCounts(x, scope, t.name);
    rows.push([t.name, t.dataType, (t.dimensions ?? []).join('x'), t.aliasFor ?? '', tagFlags(t), String(n.r), String(n.w), t.description ?? '']
      .map(csvCell).join(','));
  }
  return rows.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------

export interface ExportOptions {
  safety?: SafetyConfig;
}

export function runExport(c: Controller, dir: string, fp: Fingerprint, opts: ExportOptions = {}): ExportSummary {
  fs.mkdirSync(dir, { recursive: true });
  const release = acquireLock(dir);
  try {
    return exportLocked(c, dir, fp, opts);
  } finally {
    release();
  }
}

function exportLocked(c: Controller, dir: string, fp: Fingerprint, opts: ExportOptions): ExportSummary {
  const previous = readManifest(dir);
  const edited = new Set(editedFiles(dir, previous));
  const summary: ExportSummary = { dir, routineFiles: 0, written: 0, keptEdited: [], removed: 0, healed: 0 };
  const files: Record<string, ManifestFile> = {};
  const exportedAt = new Date().toISOString();

  const emit = (owner: { program?: string; aoi?: string }, r: Routine) => {
    const rel = routineRelPath(owner, r);
    const content = formatRoutine(owner, r);
    const entry: ManifestFile = {
      ...owner, routine: r.name, type: r.type, hash: sha1(content), content: contentHash(content),
      editable: !r.undecoded && !r.rendered && (r.type === 'RLL' || r.type === 'ST'),
    };
    files[rel] = entry;
    summary.routineFiles++;
    if (edited.has(rel)) {
      const full = path.join(dir, rel);
      // Flagged, but says exactly what the project now says: a layout difference, not an edit.
      if (contentHash(fs.readFileSync(full, 'utf8')) === entry.content) {
        summary.healed++;
      } else {
        // A real edit: keep it, and keep the baseline it was edited from, so the file stays
        // flagged only while it differs from what was exported (never because of this export).
        const was = previous?.files[rel];
        if (was) files[rel] = { ...entry, hash: was.hash, content: was.content ?? entry.content };
        summary.keptEdited.push(rel);
        return;
      }
    }
    if (writeIfChanged(path.join(dir, rel), content)) summary.written++;
  };
  for (const p of c.programs) for (const r of p.routines) emit({ program: p.name }, r);
  for (const a of c.aois) for (const r of a.routines) emit({ aoi: a.name }, r);

  // Remove routine files that no longer exist in the project, unless they hold edits.
  for (const rel of Object.keys(previous?.files ?? {})) {
    if (files[rel] || edited.has(rel)) continue;
    try { fs.unlinkSync(path.join(dir, rel)); summary.removed++; } catch { /* already gone */ }
  }

  const aois = buildAoiIndex(c);
  const x = buildCrossRef(c, aois);
  const facts = new ProjectFacts(c, aois, opts.safety ?? DEFAULT_SAFETY);
  const bypasses = facts.rungs.filter(r => !r.ref.st)
    .flatMap(r => findBypasses(r.ref, r.text, o => facts.isSafetyOperand(o, r.ref.program)));
  const unconsumed = findUnconsumed(facts);
  const devices = findSafetyDevices(facts, bypasses);
  const unproduced = findUnproducedSafety(facts);

  writeIfChanged(path.join(dir, 'CODEBASE.md'), renderCodebase(c, fp, c.sourcePath, exportedAt, summary));
  writeIfChanged(path.join(dir, 'PROJECT_MAP.md'), renderProjectMap(c, x));
  const xrefDir = path.join(dir, 'xref');
  fs.rmSync(xrefDir, { recursive: true, force: true });
  for (const [rel, content] of renderCrossRef(c, x)) writeIfChanged(path.join(dir, rel), content);
  const orphans = findOrphanDevices(facts, devices, bypasses);
  writeIfChanged(path.join(dir, 'SAFETY.md'), renderSafety(c, facts, devices, orphans, bypasses, unconsumed, unproduced));
  writeIfChanged(path.join(dir, 'BYPASSES.md'), renderBypasses(c, bypasses));
  writeIfChanged(path.join(dir, 'UNCONSUMED.md'), renderUnconsumed(c, unconsumed));
  writeIfChanged(path.join(dir, 'TAGS.md'), renderTags(c, x));
  writeIfChanged(path.join(dir, 'DATATYPES.md'), renderDataTypes(c));
  writeIfChanged(path.join(dir, 'AOIS.md'), renderAois(c));
  writeIfChanged(path.join(dir, 'MODULES.md'), renderModules(c));
  writeIfChanged(path.join(dir, 'UNUSED.md'), renderUnused(c));
  writeIfChanged(path.join(dir, 'Controller', 'Tags.csv'), tagsCsv(c.tags, '', x));
  for (const p of c.programs) {
    writeIfChanged(path.join(dir, 'Programs', safeName(p.name), 'Tags.csv'), tagsCsv(p.tags, p.name, x));
  }
  summary.removed += removeStaleFolders(dir, 'Programs', c.programs.map(p => p.name));
  summary.removed += removeStaleFolders(dir, 'AOIs', c.aois.map(a => a.name));

  fs.writeFileSync(path.join(dir, MODEL), JSON.stringify(c), 'utf8');
  const manifest: Manifest = {
    tool: 'vs-studio5000', version: 1, format: EXPORT_FORMAT, source: c.sourcePath, fingerprint: fp,
    exportedAt, controller: c.name, files,
  };
  fs.writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 1), 'utf8');
  return summary;
}

/** Look up the Program (or AOI) and Routine a manifest entry refers to. */
export function findRoutine(c: Controller, f: ManifestFile): { program?: Program; aoi?: Aoi; routine?: Routine } {
  if (f.aoi) {
    const aoi = c.aois.find(a => a.name === f.aoi);
    return { aoi, routine: aoi?.routines.find(r => r.name === f.routine) };
  }
  const program = c.programs.find(p => p.name === f.program);
  return { program, routine: program?.routines.find(r => r.name === f.routine) };
}
