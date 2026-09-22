/**
 * aiFiles.ts — Write the AI guide (CLAUDE.md, .clinerules, .cursorrules,
 * .github/copilot-instructions.md) into each workspace folder that holds projects, and the
 * Claude Code deny rules that keep the AI away from the binary .ACD.
 *
 * A guide file is only ever overwritten when it starts with our stamp, so a hand-written
 * CLAUDE.md is left alone (a warning is logged instead).
 */

import * as fs from 'fs';
import * as path from 'path';
import { ExportHealth } from './export/exporter';

export const GUIDE_STAMP = '<!-- vs-studio5000-guide';

export type AiTool = 'All' | 'Claude Code' | 'Cline' | 'Cursor' | 'GitHub Copilot' | 'None';

export interface ProjectEntry {
  file: string;
  exportDir: string;
  health: ExportHealth;
}

const TARGETS: Record<Exclude<AiTool, 'All' | 'None'>, string> = {
  'Claude Code': 'CLAUDE.md',
  'Cline': '.clinerules',
  'Cursor': '.cursorrules',
  'GitHub Copilot': path.join('.github', 'copilot-instructions.md'),
};

function projectTable(folder: string, projects: ProjectEntry[]): string {
  const rows = ['| Project file | Export folder (start with CODEBASE.md) | Export |', '|---|---|---|'];
  for (const p of projects) {
    const rel = path.relative(folder, p.file) || path.basename(p.file);
    rows.push(`| \`${rel.replace(/\\/g, '/')}\` | \`${p.exportDir}\` | ${p.health} |`);
  }
  return rows.join('\n');
}

/** Returns the files written; `skipped` collects hand-written files that were left alone. */
export function writeGuides(
  folder: string, projects: ProjectEntry[], template: string, tool: AiTool, skipped: string[], cliPath = 'cli.js'
): string[] {
  if (tool === 'None' || !projects.length) return [];
  const content = template
    .replace('{{PROJECT_TABLE}}', projectTable(folder, projects))
    .replace(/\{\{CLI\}\}/g, cliPath.replace(/\\/g, '/'));
  const rels = tool === 'All' ? Object.values(TARGETS) : [TARGETS[tool]];
  const written: string[] = [];
  for (const rel of rels) {
    const full = path.join(folder, rel);
    let existing: string | undefined;
    try { existing = fs.readFileSync(full, 'utf8'); } catch { /* none yet */ }
    if (existing !== undefined && !existing.trimStart().startsWith(GUIDE_STAMP)) {
      skipped.push(full);
      continue;
    }
    if (existing === content) continue;
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    written.push(full);
  }
  return written;
}

const DENY = ['Read(**/*.ACD)', 'Read(**/*.acd)', 'Edit(**/*.ACD)', 'Edit(**/*.acd)', 'Edit(**/*.L5X)', 'Edit(**/*.l5x)'];

/** Merge deny rules into <folder>/.claude/settings.json. Returns true when the file changed. */
export function writeClaudeGuard(folder: string): boolean {
  const file = path.join(folder, '.claude', 'settings.json');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let settings: any = {};
  if (fs.existsSync(file)) {
    try { settings = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  }
  const deny: string[] = settings?.permissions?.deny ?? [];
  const missing = DENY.filter(d => !deny.includes(d));
  if (!missing.length) return false;
  settings.permissions = settings.permissions ?? {};
  settings.permissions.deny = [...deny, ...missing];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  return true;
}
