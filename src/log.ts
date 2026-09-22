/**
 * log.ts — Timestamped activity log for everything the extension does.
 *
 * Every export, edit, file write and watcher event (acted on or ignored) records a line
 * here with the reason.
 *
 * Two sinks: a VS Code output channel, and a rolling file under global storage so the
 * history survives a reload or crash. File writes are best effort and never throw.
 *
 * One file per window: `bytesWritten` is a per-process counter, so a shared log would let
 * one window's rotate() rename the file out from under another mid-append.
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export type LogCategory =
  | 'OPEN'     // extension activated, project found or loaded
  | 'CLOSE'    // project removed from the workspace
  | 'EXPORT'   // export pass start / end / counts, decoder notes
  | 'WATCH'    // file watcher event, and whether it was acted on
  | 'EDITS'    // routine edits detected, packaged or discarded
  | 'WRITE'    // a file outside the export folder written (L5X imports, AI guides, settings)
  | 'AI'       // AI guide files and deny rules
  | 'SKIP'     // work deliberately not done: export current, hand-written guide left alone
  | 'CONFIG'   // settings changed
  | 'CLEAN'    // unused export folders deleted by the Clean Up Exports command
  | 'ERROR';

const MAX_BYTES = 2 * 1024 * 1024;
const KEEP_FILES = 3;

/** How many per-window log files to keep before deleting the oldest. */
const KEEP_WINDOW_LOGS = 5;

let channel: vscode.OutputChannel | undefined;
let logFile: string | undefined;
let bytesWritten = 0;
let windowId = '';

/** Strip anything that cannot go in a filename. */
function safeSegment(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

/**
 * Short, stable id for this window. env.sessionId is per window session, so two windows on
 * one folder get different ids and a reload starts a new file.
 */
function currentWindowId(): string {
  const raw = String(vscode.env?.sessionId ?? '') || String(process.pid);
  return safeSegment(raw).slice(-8) || String(process.pid);
}

/** Delete the oldest per-window logs so the directory cannot grow without bound. */
function pruneWindowLogs(dir: string): void {
  try {
    const logs = fs.readdirSync(dir)
      .filter(n => /^vs-studio5000-.*\.log(\.\d+)?$/.test(n))
      .map(n => {
        const full = path.join(dir, n);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(full).mtimeMs; } catch { /* treat as oldest */ }
        return { full, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const stale of logs.slice(KEEP_WINDOW_LOGS)) {
      try { fs.unlinkSync(stale.full); } catch { /* best effort */ }
    }
    // The single shared log used before per-window files.
    for (const old of ['vs-studio5000.log', 'vs-studio5000.log.1']) {
      try { fs.unlinkSync(path.join(dir, old)); } catch { /* not there */ }
    }
  } catch { /* directory unreadable: nothing to prune */ }
}

/**
 * Wire up both sinks. Safe to call more than once.
 *
 * @param label  Short name for this window (usually its workspace folder), used only to
 *               make the log filename recognisable.
 */
export function initLog(storagePath: string, label?: string): vscode.OutputChannel {
  channel ??= vscode.window.createOutputChannel('Studio 5000 Activity');
  try {
    const dir = path.join(storagePath, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    windowId = currentWindowId();
    const seg = safeSegment(label ?? '');
    logFile = path.join(dir, `vs-studio5000-${seg ? `${seg}-` : ''}${windowId}.log`);
    bytesWritten = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
    pruneWindowLogs(dir);
  } catch {
    logFile = undefined;   // channel only; not worth failing activation over
  }
  return channel;
}

export function getLogChannel(): vscode.OutputChannel | undefined {
  return channel;
}

export function getLogFilePath(): string | undefined {
  return logFile;
}

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function rotate(): void {
  if (!logFile || bytesWritten < MAX_BYTES) return;
  try {
    for (let i = KEEP_FILES - 1; i >= 1; i--) {
      const from = i === 1 ? logFile : `${logFile}.${i}`;
      const to = `${logFile}.${i + 1}`;
      if (fs.existsSync(from)) fs.renameSync(from, to);
    }
    bytesWritten = 0;
  } catch { /* keep appending to the current file */ }
}

/** Record one action. */
export function log(category: LogCategory, message: string): void {
  const line = `[${stamp()}] [${category}] ${message}`;
  channel?.appendLine(line);
  if (!logFile) return;
  try {
    rotate();
    const payload = line + '\n';
    fs.appendFileSync(logFile, payload, 'utf8');
    bytesWritten += Buffer.byteLength(payload, 'utf8');
  } catch { /* best effort: the channel already has it */ }
}

/** Record the start of a phase and return a function that logs its duration. */
export function logPhase(category: LogCategory, message: string): (outcome?: string) => void {
  const started = Date.now();
  log(category, `${message} — started`);
  return (outcome?: string) => {
    const ms = Date.now() - started;
    log(category, `${message} — done in ${ms} ms${outcome ? ` (${outcome})` : ''}`);
  };
}

/**
 * Session banner, so a reloaded log is easy to segment, and so a log pasted into a bug
 * report says which window and which folder it came from.
 */
export function logSessionStart(version: string, workspaceLabel?: string): void {
  const d = new Date();
  log('OPEN', `───── VS Studio 5000 ${version} activated ${d.toLocaleString()} ─────`);
  log('OPEN', `window ${windowId || '?'}${workspaceLabel ? ` · ${workspaceLabel}` : ' · (no folder)'}`);
}

/** Show the output channel, and offer this window's log file (the one to attach to a bug report). */
export function showLog(): void {
  if (!channel) {
    vscode.window.showWarningMessage('Studio 5000: activity log is not available.');
    return;
  }
  channel.show(true);
  const file = logFile;
  if (!file) return;
  vscode.window.showInformationMessage(
    `Studio 5000 activity log for this window: ${path.basename(file)}`,
    'Open Log File'
  ).then(choice => {
    if (choice === 'Open Log File') void vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
  });
}
