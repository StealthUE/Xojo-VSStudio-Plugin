/**
 * edits.ts — Turn edited routine files in an export folder into L5X import files.
 *
 * An edit is any routine file whose content hash differs from the one recorded in
 * _manifest.json at export time. Each edited program routine becomes
 * `edits/<Program>__<Routine>.L5X`, plus `edits/IMPORT_REPORT.md` listing validation
 * issues and how to import.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Controller, Routine } from '../model';
import { editedFiles, findRoutine, readManifest, readModel } from './exporter';
import { parseRoutineFile } from './routineFile';
import { ValidationIssue, routineL5x, validateRoutine } from '../l5x/write';
import { canonicalRung } from './rungText';

export interface EditResult {
  file: string;
  program?: string;
  routine: string;
  /** Written L5X path, absent when the routine could not be packaged. */
  l5x?: string;
  issues: ValidationIssue[];
  skipped?: string;
  /** Structured Text: counts are source lines, issue numbers are 0-based lines. */
  st?: boolean;
  rungsBefore: number;
  rungsAfter: number;
  /** Rungs (ST: lines) that are new or whose logic changed (layout-only changes excluded). */
  changedRungs?: number;
}

export function pendingEdits(dir: string): string[] {
  return editedFiles(dir);
}

export function buildImports(dir: string): EditResult[] {
  const manifest = readManifest(dir);
  const model: Controller | undefined = readModel(dir);
  if (!manifest || !model) throw new Error('Export folder has no manifest/model: re-export the project first.');
  const outDir = path.join(dir, 'edits');
  const results: EditResult[] = [];
  for (const rel of editedFiles(dir, manifest)) {
    const f = manifest.files[rel]!;
    const { program, routine: original } = findRoutine(model, f);
    const parsed = parseRoutineFile(fs.readFileSync(path.join(dir, rel), 'utf8'));
    const st = f.type === 'ST';
    const res: EditResult = {
      file: rel, program: f.program, routine: f.routine, issues: parsed.problems.map(message => ({ message })),
      st: st || undefined,
      rungsBefore: st ? original?.lines?.length ?? 0 : original?.rungs.length ?? 0,
      rungsAfter: st ? parsed.lines?.length ?? 0 : parsed.rungs.length,
    };
    results.push(res);
    if (f.aoi) {
      res.skipped = 'AOI logic cannot be imported as a routine; edit the AOI definition in Studio 5000.';
      continue;
    }
    if (!f.editable) {
      res.skipped = 'This routine was not decoded, so it cannot be rebuilt from the export.';
      continue;
    }
    if (parsed.header.routine && parsed.header.routine !== f.routine) {
      res.issues.push({ message: `header names routine "${parsed.header.routine}" but the file belongs to "${f.routine}"; using "${f.routine}".` });
    }
    // Rungs whose logic is unchanged (only re-laid-out) keep Studio's exact original text;
    // changed rungs get canonical spacing.
    const originalText = new Map((original?.rungs ?? []).map(g => [canonicalRung(g.text), g.text]));
    const rungs = parsed.rungs.map(g => {
      const canon = canonicalRung(g.text);
      return { ...g, text: originalText.get(canon) ?? canon };
    });
    if (st) {
      const before = new Set(original?.lines ?? []);
      res.changedRungs = (parsed.lines ?? []).filter(l => !before.has(l)).length;
    } else {
      res.changedRungs = rungs.filter(g => !originalText.has(canonicalRung(g.text))).length;
    }
    const edited: Routine = {
      name: f.routine,
      type: original?.type ?? (f.type as Routine['type']),
      description: parsed.header.description,
      rungs,
      lines: parsed.lines,
    };
    res.issues.push(...validateRoutine(model, program, edited));
    fs.mkdirSync(outDir, { recursive: true });
    const out = path.join(outDir, `${safe(f.program ?? '_')}__${safe(f.routine)}.L5X`);
    fs.writeFileSync(out, routineL5x(model, f.program!, edited), 'utf8');
    res.l5x = out;
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'IMPORT_REPORT.md'), renderReport(model, results), 'utf8');
  return results;
}

function safe(s: string): string {
  return s.replace(/[<>:"/\\|?*]/g, '_');
}

function renderReport(c: Controller, results: EditResult[]): string {
  const L = [`# Import report — ${c.name}`, '', `Generated ${new Date().toLocaleString()}.`, ''];
  if (!results.length) {
    L.push('No edited routines found.');
    return L.join('\n');
  }
  L.push('## How to import', '',
    '1. Open the project in Studio 5000 (offline) and save a backup copy first.',
    '2. For each file below: in the Controller Organizer, right-click the program\'s routine > **Import Rungs…**',
    '   to merge (ladder), or right-click the program > **Add > Import Routine…** to replace the whole routine',
    '   (ladder or Structured Text).',
    '3. In the import dialog, check the Tags/Other Components tabs for anything marked "Create" or "Undefined".',
    '4. Verify the routine (Logic > Verify Routine) before downloading.', '');
  for (const r of results) {
    L.push(`## ${r.program ?? ''}/${r.routine}`, '');
    L.push(`- Source: \`${r.file}\``);
    L.push(r.l5x ? `- L5X: \`${r.l5x}\`` : `- **Not packaged:** ${r.skipped}`);
    L.push(`- ${r.st ? 'Lines' : 'Rungs'}: ${r.rungsBefore} → ${r.rungsAfter}${r.changedRungs !== undefined ? ` (${r.changedRungs} new or changed)` : ''}`);
    if (r.issues.length) {
      L.push('- Issues:');
      for (const i of r.issues) {
        const at = i.rung === undefined ? '' : r.st ? `line ${i.rung + 1}: ` : `rung ${i.rung}: `;
        L.push(`  - ${at}${i.message}`);
      }
    } else {
      L.push('- No issues found.');
    }
    L.push('');
  }
  return L.join('\n');
}
