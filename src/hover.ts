/**
 * hover.ts — Hover on a tag in an exported .rll/.st file: data type, description, member
 * description, and where it is written/read. Also resolves AOI names.
 */

import * as vscode from 'vscode';
import { Controller, Tag } from './model';
import { CrossRef, buildCrossRef, xrefList } from './export/exporter';
import { baseTag } from './export/rungText';
import { LoadedProject } from './tree';

const WORD = /\\?[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z0-9_]+)*(?:\.[A-Za-z0-9_]+|\[[^\]\s]*\])*/;

const ST_KEYWORDS = new Set([
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF', 'CASE', 'OF', 'END_CASE', 'FOR', 'TO', 'BY', 'DO', 'END_FOR',
  'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT', 'EXIT', 'RETURN', 'AND', 'OR', 'XOR', 'NOT', 'MOD',
  'TRUE', 'FALSE',
]);

const xrefCache = new WeakMap<Controller, CrossRef>();

export function crossRefFor(c: Controller): CrossRef {
  let x = xrefCache.get(c);
  if (!x) { x = buildCrossRef(c); xrefCache.set(c, x); }
  return x;
}

/** `// @program X` / `// @aoi X` from the file header. */
export function ownerOf(doc: vscode.TextDocument): { program?: string; aoi?: string } {
  const out: { program?: string; aoi?: string } = {};
  for (let i = 0; i < Math.min(doc.lineCount, 12); i++) {
    const m = /^\s*\/\/\s*@(program|aoi)\s+(.+?)\s*$/.exec(doc.lineAt(i).text);
    if (m) out[m[1] as 'program' | 'aoi'] = m[2];
  }
  return out;
}

/** Tag names are case-insensitive in Logix (ST code often differs in case from the definition). */
export function lookupTag(c: Controller, program: string | undefined, name: string): { tag: Tag; scope: string } | undefined {
  const lower = name.toLowerCase();
  const prog = c.programs.find(p => p.name === program);
  const local = prog?.tags.find(t => t.name.toLowerCase() === lower);
  if (local) return { tag: local, scope: prog!.name };
  const ctl = [...c.tags, ...(c.moduleTags ?? [])].find(t => t.name.toLowerCase() === lower);
  return ctl ? { tag: ctl, scope: '' } : undefined;
}

function memberNote(c: Controller, tag: Tag, fullPath: string): string | undefined {
  const rest = fullPath.slice(tag.name.length).replace(/\[[^\]]*\]/g, '');
  const parts = rest.split('.').filter(Boolean);
  let type = tag.dataType;
  const trail: string[] = [];
  for (const part of parts) {
    const dt = c.dataTypes.find(d => d.name === type) ?? undefined;
    const aoi = dt ? undefined : c.aois.find(a => a.name === type);
    const m = (dt?.members ?? aoi?.parameters ?? []).find(x => x.name.toLowerCase() === part.toLowerCase());
    if (!m) break;
    trail.push(`\`.${m.name}\` : ${m.dataType}${m.description ? ` — ${m.description}` : ''}`);
    type = m.dataType;
  }
  return trail.length ? trail.join('  \n') : undefined;
}

export function registerHover(projectFor: (fsPath: string) => LoadedProject | undefined): vscode.Disposable {
  return vscode.languages.registerHoverProvider(['rll', 'logix-st'], {
    provideHover(doc, pos) {
      const p = projectFor(doc.uri.fsPath);
      const c = p?.controller;
      if (!c) return undefined;
      const range = doc.getWordRangeAtPosition(pos, WORD);
      if (!range) return undefined;
      const word = doc.getText(range);
      const line = doc.lineAt(pos.line).text;
      if (/^\s*\/\//.test(line)) return undefined;
      if (doc.languageId === 'logix-st' && ST_KEYWORDS.has(word.toUpperCase())) return undefined;

      const aoi = c.aois.find(a => a.name.toUpperCase() === word.toUpperCase());
      if (aoi && line[range.end.character] === '(') {
        const params = aoi.parameters.map(m => `\`${m.name}\` : ${m.dataType}`).join(', ');
        return new vscode.Hover(new vscode.MarkdownString(`**AOI ${aoi.name}**\n\n${aoi.description ?? ''}\n\n${params}`), range);
      }

      const owner = ownerOf(doc);
      const base = baseTag(word);
      if (!base) return undefined;
      const found = lookupTag(c, owner.program, base);
      if (!found) {
        const aoiDef = owner.aoi ? c.aois.find(a => a.name === owner.aoi) : undefined;
        const param = aoiDef && [...aoiDef.parameters, ...aoiDef.localTags].find(m => m.name.toLowerCase() === base.toLowerCase());
        return param
          ? new vscode.Hover(new vscode.MarkdownString(`**${param.name}** : ${param.dataType} (AOI parameter)\n\n${param.description ?? ''}`), range)
          : undefined;
      }
      const { tag, scope } = found;
      const md = new vscode.MarkdownString();
      if (tag.safety) md.appendMarkdown('**Safety tag**\n\n');
      md.appendMarkdown(`**${tag.name}** : \`${tag.dataType}${tag.dimensions ? `[${tag.dimensions.join(',')}]` : ''}\`` +
        ` — ${scope ? `program ${scope}` : 'controller'} scope\n\n`);
      if (tag.aliasFor) md.appendMarkdown(`Alias for \`${tag.aliasFor}\`\n\n`);
      if (tag.description) md.appendMarkdown(`${tag.description}\n\n`);
      const note = word !== tag.name ? memberNote(c, tag, word) : undefined;
      if (note) md.appendMarkdown(`${note}\n\n`);
      const x = crossRefFor(c);
      const e = x.refs.get(`${scope}/${tag.name}`);
      if (e) {
        const writes = [...e.writes.entries()].slice(0, 6).map(([k, r]) => {
          const [where, ins, op] = k.split('\u0000') as [string, string, string];
          return `- W \`${where}\` ${xrefList(x, where, r)} — ${ins} \`${op}\``;
        });
        const reads = [...e.reads.entries()].slice(0, 6).map(([w, r]) => `- R \`${w}\` ${xrefList(x, w, r)}`);
        md.appendMarkdown([...writes, ...reads].join('\n'));
        if (e.writes.size > 6 || e.reads.size > 6) md.appendMarkdown('\n\n_More in CROSSREF.md (Find Tag Usage)._');
      } else {
        md.appendMarkdown('_Not used in any rung or ST line._');
      }
      return new vscode.Hover(md, range);
    },
  });
}
