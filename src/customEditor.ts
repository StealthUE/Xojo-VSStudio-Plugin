/**
 * customEditor.ts — Opening an .ACD (or choosing "L5X summary" for an .L5X) shows a
 * read-only summary page with shortcuts into the export. The project file is never
 * modified from here.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { LoadedProject } from './tree';

export interface EditorHost {
  ensureProject(file: string): Promise<LoadedProject>;
  runCommand(cmd: string, file: string): Promise<void>;
}

function esc(s: string | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function html(p: LoadedProject): string {
  const c = p.controller;
  const routines = c ? c.programs.flatMap(x => x.routines) : [];
  const rungs = routines.reduce((a, r) => a + r.rungs.length, 0);
  const st = routines.filter(r => r.type === 'ST');
  const stLines = st.reduce((a, r) => a + (r.lines?.length ?? 0), 0);
  const undecoded = c ? [...routines, ...c.aois.flatMap(a => a.routines)].filter(r => r.undecoded).length : 0;
  const rows = c ? [
    ['Controller', c.name],
    ['Version', [c.revision, c.softwareVersion].filter(Boolean).join(' · ')],
    ['Tasks', String(c.tasks.length)],
    ['Programs', String(c.programs.length)],
    ['Routines', `${routines.length} (${rungs} rungs${st.length ? `, ${st.length} ST with ${stLines} lines` : ''})${undecoded ? ` · ${undecoded} not decoded` : ''}`],
    ['Add-On Instructions', String(c.aois.length)],
    ['I/O modules', String(c.modules?.length ?? 0)],
    ['Controller tags', String(c.tags.length)],
    ['Export', `${p.health}${p.edited.size ? ` · ${p.edited.size} edited routine(s)` : ''}`],
  ] : [['Status', p.error ? `Export failed: ${p.error}` : 'Exporting…']];
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
 body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:16px 24px;max-width:860px}
 h1{font-weight:600;margin-bottom:2px} .sub{opacity:.75;margin-bottom:16px;word-break:break-all}
 table{border-collapse:collapse;margin:12px 0} td{padding:4px 16px 4px 0;vertical-align:top} td:first-child{opacity:.75}
 button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;padding:6px 12px;margin:4px 6px 4px 0;cursor:pointer}
 button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
 .note{opacity:.8;margin-top:16px;line-height:1.5} pre{white-space:pre-wrap}
</style></head><body>
<h1>${esc(c?.name ?? path.basename(p.file))}</h1>
<div class="sub">${esc(p.file)}</div>
${c?.description ? `<pre>${esc(c.description)}</pre>` : ''}
<table>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
<div>
 <button data-cmd="studio5000.openCodebase">Open CODEBASE.md</button>
 <button class="secondary" data-cmd="studio5000.openExportFolder">Open export folder</button>
 <button class="secondary" data-cmd="studio5000.reexport">Re-export</button>
 <button class="secondary" data-cmd="studio5000.showLog">Activity Log</button>
 ${p.edited.size ? '<button data-cmd="studio5000.buildL5x">Build L5X import from edits</button>' : ''}
 ${/\.l5x$/i.test(p.file) ? '<button class="secondary" data-cmd="openAsText">Open as XML</button>' : ''}
</div>
<div class="note">This file is read only. Routines are exported as text to the export folder
(see the <b>Studio 5000</b> view in the Explorer). Edited routines are packaged as .L5X files
for import into Studio 5000; the project file itself is never changed.</div>
<script>
 const vscode = acquireVsCodeApi();
 for (const b of document.querySelectorAll('button')) b.addEventListener('click', () => vscode.postMessage(b.dataset.cmd));
</script></body></html>`;
}

export class ProjectEditorProvider implements vscode.CustomReadonlyEditorProvider {
  private readonly panels = new Map<string, Set<vscode.WebviewPanel>>();

  constructor(private readonly host: EditorHost) {}

  openCustomDocument(uri: vscode.Uri): vscode.CustomDocument {
    return { uri, dispose: () => undefined };
  }

  async resolveCustomEditor(doc: vscode.CustomDocument, panel: vscode.WebviewPanel): Promise<void> {
    const file = doc.uri.fsPath;
    panel.webview.options = { enableScripts: true };
    let set = this.panels.get(file);
    if (!set) { set = new Set(); this.panels.set(file, set); }
    set.add(panel);
    panel.onDidDispose(() => set!.delete(panel));
    panel.webview.onDidReceiveMessage(async (cmd: string) => {
      if (cmd === 'openAsText') {
        await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default');
        return;
      }
      await this.host.runCommand(cmd, file);
    });
    panel.webview.html = html({ file, exportDir: '', health: 'missing', edited: new Set() });
    panel.webview.html = html(await this.host.ensureProject(file));
  }

  /** Re-render every open summary of this project (after export or edits change). */
  update(p: LoadedProject): void {
    for (const panel of this.panels.get(p.file) ?? []) panel.webview.html = html(p);
  }
}
