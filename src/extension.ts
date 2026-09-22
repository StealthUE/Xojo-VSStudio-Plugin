/**
 * extension.ts — VS Studio 5000: open Rockwell Studio 5000 projects (.ACD, .L5X) as a
 * readable, AI-friendly export.
 *
 * Lifecycle:
 *   activate → find every .ACD/.L5X in the workspace → load its export (or export it)
 *            → write CLAUDE.md etc. + Claude deny rules into each workspace folder
 *   project file changes / window regains focus → re-export stale projects
 *   routine file edited in an export → mark it pending; "Build L5X Import" packages it
 *
 * The project files are only ever read.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { PROJECT_GLOB, exportProject, isProjectFile } from './project';
import {
  EXPORT_FORMAT, ExportBusyError, editedFiles, exportDirFor, exportHealth, findRoutine, implausibleEdits, readManifest,
  readModel, routineRelPath,
} from './export/exporter';
import { formatRoutine } from './export/routineFile';
import { buildImports } from './export/edits';
import { LoadedProject, Node, ProjectTree } from './tree';
import { ProjectEditorProvider } from './customEditor';
import { crossRefFor, lookupTag, ownerOf, registerHover } from './hover';
import { SafetySettings, safetyConfigFrom } from './export/analysis';
import { isStRoutine, locText } from './export/logicUnits';
import { AiTool, writeClaudeGuard, writeGuides } from './aiFiles';
import { initLog, log, logPhase, logSessionStart, showLog } from './log';

const projects = new Map<string, LoadedProject>();
const key = (f: string) => path.resolve(f).toLowerCase();

let storageRoot = '';
let extensionRoot = '';
let tree: ProjectTree;
let editor: ProjectEditorProvider;
let status: vscode.StatusBarItem;
const inFlight = new Map<string, Promise<LoadedProject>>();
const timers = new Map<string, NodeJS.Timeout>();

function cfg<T>(name: string, def: T): T {
  return vscode.workspace.getConfiguration('studio5000').get<T>(name, def);
}

function safetySettings(): SafetySettings {
  const s = vscode.workspace.getConfiguration('studio5000.safety');
  return {
    namePattern: s.get<string>('namePattern'),
    deviceAoiPattern: s.get<string>('deviceAoiPattern'),
    sinkPatterns: s.get<string[]>('sinkPatterns'),
    resultMemberPattern: s.get<string>('resultMemberPattern'),
    mappedCopyPattern: s.get<string>('mappedCopyPattern'),
  };
}

function debounce(id: string, ms: number, fn: () => void): void {
  const t = timers.get(id);
  if (t) clearTimeout(t);
  timers.set(id, setTimeout(() => { timers.delete(id); fn(); }, ms));
}

// ---------------------------------------------------------------------------------------
// Project registry
// ---------------------------------------------------------------------------------------

function projectFor(fsPath: string): LoadedProject | undefined {
  const k = key(fsPath);
  const direct = projects.get(k);
  if (direct) return direct;
  for (const p of projects.values()) {
    if (k.startsWith(key(p.exportDir) + path.sep)) return p;
  }
  return undefined;
}

/** Folder holding generated exports inside a workspace (studio5000.exportLocation = workspace). */
export const WORKSPACE_EXPORT_DIR = '.studio5000';

/** Files under an export folder (e.g. edits/*.L5X) are output, never projects to open. */
function isGenerated(file: string): boolean {
  const k = key(file);
  return k.includes(`${path.sep}${WORKSPACE_EXPORT_DIR}${path.sep}`) || k.startsWith(key(storageRoot) + path.sep);
}

/** Root the export folder is created under, per the exportLocation setting. */
function exportRootFor(file: string): string {
  if (cfg<string>('exportLocation', 'globalStorage') !== 'workspace') return storageRoot;
  const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath ?? path.dirname(file);
  return path.join(folder, WORKSPACE_EXPORT_DIR);
}

function register(file: string): LoadedProject {
  let p = projects.get(key(file));
  const exportDir = exportDirFor(exportRootFor(file), file);
  if (p && key(p.exportDir) !== key(exportDir)) {
    // exportLocation changed: point at the new folder; it is exported on the next ensureProject.
    p.exportDir = exportDir;
    p.controller = undefined;
    p.health = exportHealth(file, exportDir);
  }
  if (!p) {
    p = { file, exportDir, health: exportHealth(file, exportDir), edited: new Set() };
    projects.set(key(file), p);
    vscode.commands.executeCommand('setContext', 'studio5000.hasProjects', true);
  }
  return p;
}

function refreshEdited(p: LoadedProject): void {
  const before = p.edited;
  p.edited = new Set(editedFiles(p.exportDir));
  const added = [...p.edited].filter(rel => !before.has(rel));
  const cleared = [...before].filter(rel => !p.edited.has(rel));
  // One line per file for hand edits; a summary when a whole export changes at once.
  if (added.length > 10) log('EDITS', `${added.length} routine files now differ from the export (${added.slice(0, 5).join(', ')}, …)`);
  else for (const rel of added) log('EDITS', `edit detected: ${rel}`);
  if (cleared.length > 10) log('EDITS', `${cleared.length} routine files no longer differ from the export`);
  else for (const rel of cleared) log('EDITS', `no longer edited: ${rel}`);
  updateStatus();
}

function changed(p: LoadedProject): void {
  tree.refresh();
  editor.update(p);
  updateStatus();
}

/** Load the project's export, exporting first when it is missing or out of date. */
function ensureProject(file: string, force = false): Promise<LoadedProject> {
  const p = register(file);
  p.health = exportHealth(file, p.exportDir);
  if (!force && p.health === 'ok') {
    if (!p.controller) {
      p.controller = readModel(p.exportDir);
      log('SKIP', `${path.basename(file)}: export is current, loaded it without decoding (${p.exportDir})`);
      refreshEdited(p);
      changed(p);
    }
    return Promise.resolve(p);
  }
  const k = key(file);
  const running = inFlight.get(k);
  if (running) {
    log('SKIP', `${path.basename(file)}: export already running, joined it`);
    return running;
  }
  const reason = force ? 'requested' : p.health === 'stale' ? 'project file changed or export format updated'
    : p.health === 'missing' ? 'no export yet' : 'export folder incomplete';
  const job = Promise.resolve(vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Studio 5000: exporting ${path.basename(file)}` },
    async () => {
      await new Promise(r => setImmediate(r));
      const done = logPhase('EXPORT', `${path.basename(file)} (${reason})`);
      try {
        const problems: string[] = [];
        const safety = safetyConfigFrom(safetySettings(), problems);
        for (const m of problems) { log('ERROR', m); vscode.window.showWarningMessage(`Studio 5000: ${m}`); }
        const r = exportProject(file, exportRootFor(file), { safety });
        p.controller = r.controller;
        p.error = undefined;
        p.health = 'ok';
        const s = r.summary;
        const c = r.controller;
        const routines = [...c.programs.flatMap(x => x.routines), ...c.aois.flatMap(a => a.routines)];
        const undecoded = routines.filter(x => x.undecoded).length;
        log('EXPORT', `${c.name} (${c.source}): ${c.tasks.length} tasks, ${c.programs.length} programs, ` +
          `${routines.length} routines (${routines.filter(x => x.type === 'ST' && x.lines).length} ST${undecoded ? `, ${undecoded} not decoded` : ''}), ` +
          `${c.aois.length} AOIs, ${c.modules.length} modules`);
        log('EXPORT', `${s.routineFiles} routine files: ${s.written} written, ${s.removed} removed → ${s.dir}`);
        if (s.healed) log('EDITS', `${s.healed} routine file(s) flagged as edited differed only in layout; rewritten from the project`);
        if (s.keptEdited.length) {
          const shown = s.keptEdited.slice(0, 20).join(', ') + (s.keptEdited.length > 20 ? `, … ${s.keptEdited.length - 20} more` : '');
          log('EDITS', `kept ${s.keptEdited.length} edited routine file(s) as they were: ${shown}`);
          if (implausibleEdits(s)) {
            log('EDITS', `${s.keptEdited.length} of ${s.routineFiles} files flagged as edited: more than hand edits; likely two windows or plugin versions wrote this export`);
            void vscode.window.showWarningMessage(
              `${path.basename(file)}: ${s.keptEdited.length} of ${s.routineFiles} routine files differ from the project. If you did not edit them, discard the edits before building an L5X import.`,
              'Discard Edits').then(ch => { if (ch) void vscode.commands.executeCommand('studio5000.discardEdits', p.file); });
          } else {
            vscode.window.showWarningMessage(
              `${path.basename(file)} was re-exported. ${s.keptEdited.length} edited routine file(s) were kept as they were; they may be out of date with the project.`);
          }
        }
        for (const w of c.warnings.slice(0, 50)) log('EXPORT', `  note: ${w}`);
        if (c.warnings.length > 50) log('EXPORT', `  … ${c.warnings.length - 50} more notes in CODEBASE.md`);
        done(`ok, ${r.ms} ms decode + export`);
      } catch (err) {
        if (err instanceof ExportBusyError) {
          // Another window is writing this export folder: let it finish, then load its result.
          log('SKIP', `${path.basename(file)}: ${err.message} Retrying in 10 s.`);
          done('waiting for the other window');
          debounce(`busy:${key(file)}`, 10_000, () => void ensureProject(file));
          return p;
        }
        p.error = err instanceof Error ? err.message : String(err);
        p.health = exportHealth(file, p.exportDir);
        log('ERROR', `export of ${file} failed: ${p.error}`);
        if (err instanceof Error && err.stack) log('ERROR', err.stack.split('\n').slice(1, 6).join(' | '));
        done('failed');
        vscode.window.showErrorMessage(`Studio 5000: could not decode ${path.basename(file)}: ${p.error}`, 'Show Log')
          .then(ch => { if (ch) showLog(); });
      }
      refreshEdited(p);
      changed(p);
      writeAiFiles();
      return p;
    }
  )).catch(() => p);
  inFlight.set(k, job);
  return job.then(v => { inFlight.delete(k); return v; });
}

function forget(file: string): void {
  if (projects.delete(key(file))) {
    log('CLOSE', `${file} no longer exists; removed from the view (its export folder is kept)`);
    tree.refresh();
    vscode.commands.executeCommand('setContext', 'studio5000.hasProjects', projects.size > 0);
    writeAiFiles();
  }
}

// ---------------------------------------------------------------------------------------
// AI context files
// ---------------------------------------------------------------------------------------

function writeAiFiles(): void {
  let template: string;
  try {
    template = fs.readFileSync(path.join(extensionRoot, 'resources', 'studio5000-guide.md'), 'utf8');
  } catch (err) {
    log('ERROR', `guide template missing: ${err}`);
    return;
  }
  const tool = cfg<AiTool>('aiTool', 'Claude Code');
  const byFolder = new Map<string, LoadedProject[]>();
  for (const p of projects.values()) {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(p.file))?.uri.fsPath ?? path.dirname(p.file);
    const list = byFolder.get(folder) ?? [];
    list.push(p);
    byFolder.set(folder, list);
  }
  for (const [folder, list] of byFolder) {
    const skipped: string[] = [];
    try {
      const written = writeGuides(folder, list.map(p => ({ file: p.file, exportDir: p.exportDir, health: p.health })),
        template, tool, skipped, path.join(extensionRoot, 'out', 'cli.js'));
      for (const w of written) log('WRITE', `AI guide (${tool}) written: ${w}`);
      for (const s of skipped) log('SKIP', `${s} exists and was not written by this extension; left unchanged`);
      if (cfg('guardProjectFiles', true) && tool !== 'None' && writeClaudeGuard(folder)) {
        log('WRITE', `added .ACD deny rules to ${path.join(folder, '.claude', 'settings.json')}`);
      }
    } catch (err) {
      log('ERROR', `could not write AI files in ${folder}: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------------------

function updateStatus(): void {
  const n = [...projects.values()].reduce((a, p) => a + p.edited.size, 0);
  if (!n) { status.hide(); return; }
  status.text = `$(package) ${n} PLC edit${n === 1 ? '' : 's'}`;
  status.tooltip = 'Edited Studio 5000 routines not yet packaged. Click to build L5X import files.';
  status.show();
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

/** Resolve the project a command applies to from its argument, the active editor, or a pick. */
async function pickProject(arg?: unknown): Promise<LoadedProject | undefined> {
  if (arg instanceof Node) return arg.project;
  if (arg instanceof vscode.Uri && isProjectFile(arg.fsPath)) return ensureProject(arg.fsPath);
  if (typeof arg === 'string' && isProjectFile(arg)) return ensureProject(arg);
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  const fromEditor = active ? projectFor(active) : undefined;
  if (fromEditor) return fromEditor;
  const all = [...projects.values()];
  if (all.length === 1) return all[0];
  if (!all.length) {
    vscode.window.showInformationMessage('No Studio 5000 project (.ACD / .L5X) found in this workspace.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    all.map(p => ({ label: p.controller?.name ?? path.basename(p.file), description: p.file, p })),
    { placeHolder: 'Which project?' });
  return pick?.p;
}

async function openFile(file: string, line?: number): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(file);
  const ed = await vscode.window.showTextDocument(doc, { preview: false });
  if (line !== undefined) {
    const pos = new vscode.Position(line, 0);
    ed.selection = new vscode.Selection(pos, pos);
    ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
  }
}

async function cmdBuildL5x(arg?: unknown): Promise<void> {
  const p = await pickProject(arg);
  if (!p) return;
  refreshEdited(p);
  if (!p.edited.size) {
    vscode.window.showInformationMessage(`${p.controller?.name ?? path.basename(p.file)}: no edited routines to package.`);
    return;
  }
  const done = logPhase('EDITS', `build L5X imports for ${p.edited.size} edited routine(s) of ${path.basename(p.file)}`);
  try {
    const results = buildImports(p.exportDir);
    const ok = results.filter(r => r.l5x).length;
    const issues = results.reduce((a, r) => a + r.issues.length, 0);
    for (const r of results) {
      if (r.l5x) log('WRITE', `${r.file} → ${r.l5x} (${r.st ? 'lines' : 'rungs'} ${r.rungsBefore} → ${r.rungsAfter}, ${r.issues.length} issue(s))`);
      else log('SKIP', `${r.file} not packaged: ${r.skipped}`);
      for (const i of r.issues.slice(0, 10)) log('EDITS', `  ${r.file}: ${i.message}`);
    }
    done(`${ok} L5X file(s), ${issues} issue(s), in ${path.join(p.exportDir, 'edits')}`);
    tree.refresh();
    await openFile(path.join(p.exportDir, 'edits', 'IMPORT_REPORT.md'));
    const choice = await vscode.window.showInformationMessage(
      `Built ${ok} L5X import file(s)${issues ? ` with ${issues} issue(s) to review` : ''}.`, 'Reveal Files');
    if (choice) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(p.exportDir, 'edits', 'IMPORT_REPORT.md')));
  } catch (err) {
    log('ERROR', `build L5X failed: ${err instanceof Error ? err.message : err}`);
    done('failed');
    vscode.window.showErrorMessage(`Studio 5000: ${err instanceof Error ? err.message : err}`, 'Show Log')
      .then(ch => { if (ch) showLog(); });
  }
}

async function cmdDiscardEdits(arg?: unknown): Promise<void> {
  const p = await pickProject(arg);
  if (!p?.controller) return;
  refreshEdited(p);
  if (!p.edited.size) {
    vscode.window.showInformationMessage('No edited routines.');
    return;
  }
  const items = [...p.edited].map(rel => ({ label: rel, picked: true }));
  const chosen = await vscode.window.showQuickPick(items, {
    canPickMany: true, placeHolder: 'Restore these routine files to the decoded project version (edits are lost)',
  });
  if (!chosen?.length) return;
  const manifest = readManifest(p.exportDir);
  for (const { label: rel } of chosen) {
    const f = manifest?.files[rel];
    if (!f) continue;
    const { routine } = findRoutine(p.controller, f);
    if (!routine) continue;
    fs.writeFileSync(path.join(p.exportDir, rel), formatRoutine({ program: f.program, aoi: f.aoi }, routine), 'utf8');
    log('EDITS', `discarded edits: ${rel} restored to the decoded project version`);
  }
  refreshEdited(p);
  changed(p);
}

async function cmdFindTagUsage(arg?: unknown): Promise<void> {
  let tag: string | undefined;
  let program: string | undefined;
  let p: LoadedProject | undefined;
  const ed = vscode.window.activeTextEditor;
  if (ed && !(arg instanceof Node)) {
    p = projectFor(ed.document.uri.fsPath);
    const range = ed.document.getWordRangeAtPosition(ed.selection.active, /[A-Za-z_][A-Za-z0-9_:]*/);
    if (range) tag = ed.document.getText(range);
    program = ownerOf(ed.document).program;
  }
  p ??= await pickProject(arg);
  if (!p?.controller) return;
  tag = await vscode.window.showInputBox({ prompt: 'Tag name', value: tag });
  if (!tag) return;
  const c = p.controller;
  const found = lookupTag(c, program, tag);
  const scope = found?.scope ?? program ?? '';
  const x = crossRefFor(c);
  const e = x.refs.get(`${scope}/${found?.tag.name ?? tag}`) ?? x.refs.get(`/${tag}`);
  if (!e) {
    vscode.window.showInformationMessage(`"${tag}" is not referenced by any rung or ST line.`);
    return;
  }
  type Item = vscode.QuickPickItem & { where?: string; rung?: number };
  const loc = (where: string, n: number) => `${where} ${locText(n, x.st.has(where))}`;
  const items: Item[] = [{ label: 'Writes', kind: vscode.QuickPickItemKind.Separator }];
  for (const [k, rungs] of e.writes) {
    const [where, ins, op] = k.split('\u0000') as [string, string, string];
    for (const n of rungs) items.push({ label: `$(edit) ${loc(where, n)}`, description: `${ins} ${op}`, where, rung: n });
  }
  items.push({ label: 'Reads', kind: vscode.QuickPickItemKind.Separator });
  for (const [where, rungs] of e.reads) {
    for (const n of rungs) items.push({ label: `$(eye) ${loc(where, n)}`, where, rung: n });
  }
  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `${found?.tag.name ?? tag}${found ? ` : ${found.tag.dataType}` : ''} — ${e.writes.size} write site(s), ${e.reads.size} reading routine(s)`,
    matchOnDescription: true,
  });
  if (!pick?.where) return;
  await openRung(p, pick.where, pick.rung ?? 0);
}

/**
 * Delete export folders this window does not use. Exports of projects in other folders or
 * workspaces are listed but only pre-selected when their project file no longer exists, and
 * folders holding unpackaged edits say so, since deleting them loses those edits.
 */
async function cmdCleanExports(): Promise<void> {
  const root = path.join(storageRoot, 'exports');
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root).map(d => path.join(root, d)).filter(d => fs.statSync(d).isDirectory()); } catch { /* none */ }
  const inUse = new Set([...projects.values()].map(p => key(p.exportDir)));
  type Item = vscode.QuickPickItem & { dir: string };
  const items: Item[] = [];
  for (const dir of dirs) {
    if (inUse.has(key(dir))) continue;
    const m = readManifest(dir);
    const source = m?.source;
    const exists = !!source && fs.existsSync(source);
    const edits = m ? editedFiles(dir, m).length : 0;
    const bits = [
      source ? (exists ? 'project file still exists (another workspace)' : 'project file no longer exists') : 'no manifest',
      m?.format !== EXPORT_FORMAT ? 'old export format' : '',
      edits ? `$(warning) ${edits} unpackaged edit(s) will be lost` : '',
    ].filter(Boolean).join(' · ');
    items.push({ label: path.basename(dir), description: source ?? '', detail: bits, picked: !exists && !edits, dir });
  }
  if (!items.length) {
    vscode.window.showInformationMessage('Studio 5000: no unused export folders.');
    return;
  }
  const chosen = await vscode.window.showQuickPick(items, {
    canPickMany: true, matchOnDescription: true, matchOnDetail: true,
    placeHolder: `Export folders not used by this window (${items.length}). Selected ones are deleted; they are recreated if the project is opened again.`,
  });
  if (!chosen?.length) return;
  const confirm = await vscode.window.showWarningMessage(
    `Delete ${chosen.length} export folder(s)? Project files are not touched.`, { modal: true }, 'Delete');
  if (confirm !== 'Delete') return;
  for (const c of chosen) {
    try {
      fs.rmSync(c.dir, { recursive: true, force: true });
      log('CLEAN', `deleted export folder ${c.dir} (source ${c.description || 'unknown'})`);
    } catch (err) {
      log('ERROR', `could not delete ${c.dir}: ${err}`);
    }
  }
  vscode.window.showInformationMessage(`Studio 5000: deleted ${chosen.length} export folder(s).`);
}

/**
 * Open a routine's exported file at a rung (ladder) or source line (ST, `rung` = 0-based line).
 * `where` is "Program/Routine" or "AOI Name/Routine".
 */
async function openRung(p: LoadedProject, where: string, rung: number): Promise<void> {
  const c = p.controller!;
  const owner = where.slice(0, where.lastIndexOf('/'));
  const name = where.slice(where.lastIndexOf('/') + 1);
  const isAoi = owner.startsWith('AOI ');
  const r = isAoi
    ? c.aois.find(a => a.name === owner.slice(4))?.routines.find(x => x.name === name)
    : c.programs.find(x => x.name === owner)?.routines.find(x => x.name === name);
  if (!r) return;
  const file = path.join(p.exportDir, routineRelPath(isAoi ? { aoi: owner.slice(4) } : { program: owner }, r));
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (isStRoutine(r)) {
    // formatRoutine writes the header block, one blank line, then the source verbatim.
    const body = lines.findIndex(l => !/^\s*\/\/\s*@/.test(l));
    await openFile(file, body < 0 ? undefined : body + 1 + rung);
    return;
  }
  const at = lines.findIndex(l => l.trim() === `// ---- Rung ${rung} ----`);
  await openFile(file, at < 0 ? undefined : at);
}

// ---------------------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------------------

async function discover(): Promise<void> {
  const uris = await vscode.workspace.findFiles(PROJECT_GLOB, `**/{node_modules,.git,${WORKSPACE_EXPORT_DIR}}/**`);
  const seen = new Set<string>();
  for (const u of uris) {
    if (seen.has(key(u.fsPath))) continue;
    if (isGenerated(u.fsPath)) { log('SKIP', `${u.fsPath}: generated by this extension, not a project`); continue; }
    seen.add(key(u.fsPath));
    const p = register(u.fsPath);
    log('OPEN', `found ${u.fsPath} (export ${p.health})`);
  }
  if (!seen.size) log('OPEN', 'no .ACD / .L5X project files in this workspace');
  tree.refresh();
  writeAiFiles();
  for (const p of [...projects.values()]) {
    if (p.health === 'ok' || cfg('autoExport', true)) await ensureProject(p.file);
    else log('SKIP', `${path.basename(p.file)}: export ${p.health}, not exported because studio5000.autoExport is off`);
  }
  suggestCleanup();
}

let cleanupSuggested = false;

/**
 * Once per session: point out export folders that are clearly stale (old format, or their
 * project file is gone) and not used by this window. Nothing is deleted without the command.
 */
function suggestCleanup(): void {
  if (cleanupSuggested) return;
  cleanupSuggested = true;
  const root = path.join(storageRoot, 'exports');
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(root).map(d => path.join(root, d)); } catch { return; }
  const inUse = new Set([...projects.values()].map(p => key(p.exportDir)));
  const stale = dirs.filter(d => {
    if (inUse.has(key(d))) return false;
    const m = readManifest(d);
    return !m || m.format !== EXPORT_FORMAT || !fs.existsSync(m.source);
  });
  if (!stale.length) return;
  log('SKIP', `${stale.length} stale export folder(s) not used by this window: ${stale.map(d => path.basename(d)).join(', ')} — run "Clean Up Exports" to review`);
  void vscode.window.showInformationMessage(
    `Studio 5000: ${stale.length} old export folder(s) from other or deleted projects are taking space.`, 'Review')
    .then(choice => { if (choice) void cmdCleanExports(); });
}

export function activate(ctx: vscode.ExtensionContext): void {
  storageRoot = ctx.globalStorageUri.fsPath;
  extensionRoot = ctx.extensionPath;
  fs.mkdirSync(storageRoot, { recursive: true });
  // Activity log first, so everything below is recorded. One file per window.
  const workspaceLabel = vscode.workspace.workspaceFolders?.[0]?.name;
  ctx.subscriptions.push(initLog(storageRoot, workspaceLabel));
  logSessionStart(String(ctx.extension.packageJSON.version), workspaceLabel);
  log('OPEN', `exports under ${cfg<string>('exportLocation', 'globalStorage') === 'workspace' ? `<workspace>/${WORKSPACE_EXPORT_DIR}` : storageRoot}; ` +
    `AI tool ${cfg<string>('aiTool', 'Claude Code')}; auto export ${cfg('autoExport', true) ? 'on' : 'off'}`);

  tree = new ProjectTree(() => [...projects.values()]);
  editor = new ProjectEditorProvider({
    ensureProject: f => ensureProject(f),
    runCommand: async (cmd, f) => { await vscode.commands.executeCommand(cmd, f); },
  });
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'studio5000.buildL5x';

  const cmd = (id: string, fn: (...a: unknown[]) => unknown) => vscode.commands.registerCommand(id, fn);
  ctx.subscriptions.push(
    status,
    vscode.window.createTreeView('studio5000Explorer', { treeDataProvider: tree, showCollapseAll: true }),
    vscode.window.registerCustomEditorProvider('studio5000.projectEditor', editor, { supportsMultipleEditorsPerDocument: true }),
    vscode.window.registerCustomEditorProvider('studio5000.l5xEditor', editor, { supportsMultipleEditorsPerDocument: true }),
    registerHover(projectFor),

    cmd('studio5000.openProject', async arg => {
      const uri = arg instanceof vscode.Uri ? arg : (await vscode.window.showOpenDialog({
        canSelectMany: false, filters: { 'Studio 5000 project': ['ACD', 'acd', 'L5X', 'l5x'] },
      }))?.[0];
      if (!uri) return;
      const p = await ensureProject(uri.fsPath);
      if (p.controller) await openFile(path.join(p.exportDir, 'CODEBASE.md'));
    }),
    cmd('studio5000.reexport', async arg => {
      const p = await pickProject(arg);
      if (!p) return;
      log('EXPORT', `re-export of ${path.basename(p.file)} requested`);
      await ensureProject(p.file, true);
    }),
    cmd('studio5000.openCodebase', async arg => {
      const p = await pickProject(arg);
      if (p) await openFile(path.join((await ensureProject(p.file)).exportDir, 'CODEBASE.md'));
    }),
    cmd('studio5000.openExportFolder', async arg => {
      const p = await pickProject(arg);
      if (p) vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(p.exportDir, 'CODEBASE.md')));
    }),
    cmd('studio5000.buildL5x', cmdBuildL5x),
    cmd('studio5000.discardEdits', cmdDiscardEdits),
    cmd('studio5000.findTagUsage', cmdFindTagUsage),
    cmd('studio5000.openRoutine', async file => {
      if (typeof file !== 'string') return;
      if (fs.existsSync(file)) await openFile(file);
      else if (file.endsWith('IMPORT_REPORT.md')) vscode.window.showInformationMessage('Run "Build L5X Import from Edits" first.');
    }),
    cmd('studio5000.showLog', () => showLog()),
    cmd('studio5000.cleanExports', () => cmdCleanExports()),
  );

  // Project files appearing, changing or disappearing.
  const pw = vscode.workspace.createFileSystemWatcher(PROJECT_GLOB);
  const onProject = (u: vscode.Uri) => debounce(`p:${key(u.fsPath)}`, 1500, () => {
    if (isGenerated(u.fsPath)) { log('WATCH', `${u.fsPath} changed: generated file, ignored`); return; }
    if (!fs.existsSync(u.fsPath)) { log('WATCH', `${u.fsPath} deleted`); forget(u.fsPath); return; }
    if (!cfg('autoExport', true)) {
      register(u.fsPath);
      log('WATCH', `${u.fsPath} changed: not re-exported (studio5000.autoExport is off)`);
      tree.refresh();
      return;
    }
    log('WATCH', `${u.fsPath} changed: re-exporting`);
    void ensureProject(u.fsPath);
  });
  ctx.subscriptions.push(pw, pw.onDidCreate(onProject), pw.onDidChange(onProject), pw.onDidDelete(onProject));

  // Routine files edited in any export folder (by VS Code or an AI tool on disk).
  const ew = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(path.join(storageRoot, 'exports')), '**/*.{rll,st}'));
  const onRoutine = (u: vscode.Uri) => {
    const p = projectFor(u.fsPath);
    if (p) debounce(`e:${key(p.file)}`, 400, () => { refreshEdited(p); changed(p); });
  };
  // Same for exports kept inside the workspace (studio5000.exportLocation = workspace).
  const ww = vscode.workspace.createFileSystemWatcher(`**/${WORKSPACE_EXPORT_DIR}/exports/**/*.{rll,st}`);
  ctx.subscriptions.push(ew, ew.onDidChange(onRoutine), ew.onDidCreate(onRoutine), ew.onDidDelete(onRoutine));
  ctx.subscriptions.push(ww, ww.onDidChange(onRoutine), ww.onDidCreate(onRoutine), ww.onDidDelete(onRoutine));
  ctx.subscriptions.push(vscode.workspace.onDidSaveTextDocument(d => onRoutine(d.uri)));

  // Coming back to the window: pick up project files saved by Studio 5000 meanwhile.
  ctx.subscriptions.push(vscode.window.onDidChangeWindowState(s => {
    if (!s.focused || !cfg('autoExport', true)) return;
    for (const p of projects.values()) {
      if (exportHealth(p.file, p.exportDir) !== 'ok' && fs.existsSync(p.file)) {
        log('WATCH', `window focused: ${path.basename(p.file)} changed while away, re-exporting`);
        void ensureProject(p.file);
      }
    }
  }));
  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (!e.affectsConfiguration('studio5000')) return;
    if (e.affectsConfiguration('studio5000.aiTool') || e.affectsConfiguration('studio5000.guardProjectFiles')) {
      log('CONFIG', `AI settings changed (aiTool ${cfg<string>('aiTool', 'Claude Code')}, guard ${cfg('guardProjectFiles', true)}): rewriting guide files`);
      writeAiFiles();
    }
    if (e.affectsConfiguration('studio5000.autoExport')) log('CONFIG', `auto export ${cfg('autoExport', true) ? 'on' : 'off'}`);
    if (e.affectsConfiguration('studio5000.exportLocation')) {
      log('CONFIG', `export location now ${cfg<string>('exportLocation', 'globalStorage')}: re-exporting all projects`);
      for (const p of [...projects.values()]) { register(p.file); void ensureProject(p.file); }
      tree.refresh();
    } else if (e.affectsConfiguration('studio5000.safety')) {
      // The safety checks are generated at export time: regenerate with the new rules.
      log('CONFIG', 'safety rules changed: regenerating the checks of all projects');
      for (const p of [...projects.values()]) void ensureProject(p.file, true);
    }
  }));
  ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
    log('WATCH', 'workspace folders changed: looking for projects again');
    void discover();
  }));

  void discover();
}

export function deactivate(): void {
  log('CLOSE', 'VS Studio 5000 deactivated');
  for (const t of timers.values()) clearTimeout(t);
}
