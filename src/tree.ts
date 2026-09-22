/**
 * tree.ts — Explorer view that mirrors Studio 5000's Controller Organizer:
 * project → Tasks / Programs / Add-On Instructions / Data Types / Controller Tags / Docs.
 * Clicking a routine opens its exported .rll/.st file; edited routines are marked.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { Controller, Routine } from './model';
import { ExportHealth, routineRelPath, safeName } from './export/exporter';

export interface LoadedProject {
  file: string;
  exportDir: string;
  controller?: Controller;
  health: ExportHealth;
  /** Export-relative paths of routine files with local edits. */
  edited: Set<string>;
  error?: string;
}

type Kind = 'project' | 'folder' | 'task' | 'program' | 'aoi' | 'routine' | 'doc' | 'tag';

export class Node extends vscode.TreeItem {
  constructor(
    label: string,
    readonly kind: Kind,
    readonly project: LoadedProject,
    collapsible: vscode.TreeItemCollapsibleState,
    readonly children: () => Node[] = () => []
  ) {
    super(label, collapsible);
    this.contextValue = kind;
  }
}

const None = vscode.TreeItemCollapsibleState.None;
const Collapsed = vscode.TreeItemCollapsibleState.Collapsed;

function openFile(p: LoadedProject, rel: string): vscode.Command {
  return { command: 'studio5000.openRoutine', title: 'Open', arguments: [path.join(p.exportDir, rel)] };
}

function docNode(p: LoadedProject, label: string, rel: string, icon: string, tip?: string): Node {
  const n = new Node(label, 'doc', p, None);
  n.iconPath = new vscode.ThemeIcon(icon);
  n.command = openFile(p, rel);
  n.tooltip = tip ?? rel;
  return n;
}

function routineNode(p: LoadedProject, owner: { program?: string; aoi?: string }, r: Routine, isMain: boolean): Node {
  const rel = routineRelPath(owner, r);
  const n = new Node(r.name, 'routine', p, None);
  const edited = p.edited.has(rel);
  const size = r.type === 'RLL' ? `${r.rungs.length} rungs` : r.undecoded ? 'not decoded'
    : r.rendered ? 'text view' : `${r.lines?.length ?? 0} lines`;
  n.description = `${r.type} · ${size}${isMain ? ' · main' : ''}${edited ? ' · edited' : ''}`;
  n.tooltip = new vscode.MarkdownString(`**${r.name}** (${r.type})\n\n${r.description ?? ''}${r.undecoded ? `\n\n_${r.undecoded}_` : ''}`);
  n.iconPath = new vscode.ThemeIcon(
    edited ? 'edit' : r.undecoded ? 'circle-slash' : r.type === 'RLL' ? 'list-ordered' : 'symbol-namespace',
    edited ? new vscode.ThemeColor('gitDecoration.modifiedResourceForeground') : undefined
  );
  n.command = openFile(p, rel);
  n.resourceUri = vscode.Uri.file(path.join(p.exportDir, rel));
  return n;
}

function projectChildren(p: LoadedProject): Node[] {
  const c = p.controller;
  if (!c) {
    const n = new Node(p.error ? `Export failed: ${p.error}` : 'Not exported yet', 'doc', p, None);
    n.iconPath = new vscode.ThemeIcon(p.error ? 'error' : 'loading~spin');
    return [n];
  }
  const out: Node[] = [];

  const tasks = new Node('Tasks', 'folder', p, Collapsed, () => c.tasks.map(t => {
    const rate = t.type === 'PERIODIC' && t.rateMs !== undefined ? ` ${t.rateMs} ms` : '';
    const tn = new Node(t.name, 'task', p, t.programs.length ? Collapsed : None, () => t.programs.map(pn => {
      const prog = c.programs.find(x => x.name === pn);
      const n = new Node(pn, 'program', p, None);
      n.iconPath = new vscode.ThemeIcon('symbol-module');
      const main = prog?.routines.find(r => r.name === prog.mainRoutine);
      if (prog && main) n.command = openFile(p, routineRelPath({ program: prog.name }, main));
      n.description = prog?.description?.split('\n')[0];
      return n;
    }));
    tn.description = `${t.type}${rate} · P${t.priority ?? '?'}${t.safety ? ' · safety' : ''}`;
    tn.iconPath = new vscode.ThemeIcon('clock');
    return tn;
  }));
  tasks.iconPath = new vscode.ThemeIcon('watch');
  out.push(tasks);

  const programs = new Node('Programs', 'folder', p, Collapsed, () => c.programs.map(prog => {
    const pn = new Node(prog.name, 'program', p, Collapsed, () => [
      ...prog.routines.map(r => routineNode(p, { program: prog.name }, r, r.name === prog.mainRoutine)),
      docNode(p, `Tags (${prog.tags.length})`, `Programs/${safeName(prog.name)}/Tags.csv`, 'symbol-variable'),
    ]);
    pn.iconPath = new vscode.ThemeIcon(prog.safety ? 'shield' : 'symbol-module');
    pn.description = [prog.safety && 'safety', prog.disabled && 'disabled', prog.description?.split('\n')[0]].filter(Boolean).join(' · ');
    pn.tooltip = prog.description;
    return pn;
  }));
  programs.iconPath = new vscode.ThemeIcon('folder-library');
  programs.description = String(c.programs.length);
  out.push(programs);

  if (c.aois.length) {
    const aois = new Node('Add-On Instructions', 'folder', p, Collapsed, () => c.aois.map(a => {
      const an = new Node(a.name, 'aoi', p, a.routines.length ? Collapsed : None,
        () => a.routines.map(r => routineNode(p, { aoi: a.name }, r, false)));
      an.iconPath = new vscode.ThemeIcon(a.safety ? 'shield' : 'symbol-method');
      an.description = [a.safety && 'safety', a.description?.split('\n')[0]].filter(Boolean).join(' · ');
      return an;
    }));
    aois.iconPath = new vscode.ThemeIcon('extensions');
    aois.description = String(c.aois.length);
    out.push(aois);
  }

  out.push(docNode(p, `Data Types (${c.dataTypes.filter(d => d.kind === 'udt').length})`, 'DATATYPES.md', 'symbol-struct'));
  out.push(docNode(p, `Controller Tags (${c.tags.length})`, 'Controller/Tags.csv', 'symbol-variable'));
  out.push(docNode(p, `I/O Configuration (${c.modules?.length ?? 0})`, 'MODULES.md', 'server-environment', 'Module tree'));
  out.push(docNode(p, 'CODEBASE.md', 'CODEBASE.md', 'book', 'Project overview'));
  out.push(docNode(p, 'PROJECT_MAP.md', 'PROJECT_MAP.md', 'type-hierarchy', 'Execution order and JSR call tree'));
  out.push(docNode(p, 'CROSSREF.md', 'CROSSREF.md', 'references', 'Where each tag is written and read'));
  out.push(docNode(p, 'SAFETY.md', 'SAFETY.md', 'shield', 'Safety devices: mapped, consumed, bypassed, reaching an output'));
  out.push(docNode(p, 'BYPASSES.md', 'BYPASSES.md', 'warning', 'Shorted or disabled contacts'));
  out.push(docNode(p, 'UNCONSUMED.md', 'UNCONSUMED.md', 'debug-disconnect', 'Written but never read'));
  const unused = (c.unused?.aois.length ?? 0) + (c.unused?.dataTypes.length ?? 0);
  if (unused) out.push(docNode(p, `UNUSED.md (${unused})`, 'UNUSED.md', 'archive', 'Definitions nothing in the project uses'));
  if (p.edited.size) {
    out.push(docNode(p, `Pending edits (${p.edited.size})`, 'edits/IMPORT_REPORT.md', 'git-pull-request-draft',
      'Run "Build L5X Import from Edits" to package these'));
  }
  return out;
}

export class ProjectTree implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly projects: () => LoadedProject[]) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(n: Node): vscode.TreeItem {
    return n;
  }

  getChildren(n?: Node): Node[] {
    if (n) return n.children();
    return this.projects().map(p => {
      const label = p.controller?.name || path.basename(p.file);
      const node = new Node(label, 'project', p, vscode.TreeItemCollapsibleState.Expanded, () => projectChildren(p));
      node.description = `${path.basename(p.file)}${p.health !== 'ok' ? ` · ${p.health}` : ''}`;
      node.tooltip = `${p.file}\nExport: ${p.exportDir}`;
      node.iconPath = new vscode.ThemeIcon('circuit-board');
      return node;
    });
  }
}
