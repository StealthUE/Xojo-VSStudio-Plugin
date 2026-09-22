/**
 * routineFile.ts — The editable text form of a routine (.rll for ladder, .st for
 * structured text), and the parser that reads an edited file back.
 *
 * .rll layout:
 *
 *   // @program MainProgram
 *   // @routine _030_Mode
 *   // @type RLL
 *   // @description A routine to control the mode of the area
 *
 *   // ---- Rung 0 ----
 *   // > Rung comment line 1
 *   // > Rung comment line 2
 *   XIC(Start)OTE(Motor);
 *
 * Rules the parser applies (and the AI guide documents):
 *   - `// @key value` lines are metadata; only the first block is read.
 *   - `// > text` lines are the comment of the NEXT rung.
 *   - any other `//` line is ignored (rung markers are regenerated, numbers are not trusted).
 *   - every other line is rung text; a rung ends at `;` and may span several lines.
 *     Long rungs with branches are written one branch leg per line:
 *
 *       XIC(Auto)
 *       [XIC(Start)
 *       ,XIC(Seal)
 *       ]XIO(Stop) OTE(Run);
 *
 *     Whitespace between elements is not significant (see canonicalRung).
 */

import { Routine, Rung } from '../model';
import { formatRungLines } from './rungText';

export const RLL_EXT = '.rll';
export const ST_EXT = '.st';

export interface RoutineHeader {
  program?: string;
  aoi?: string;
  routine: string;
  type: string;
  description?: string;
  undecoded?: string;
}

function metaLines(h: RoutineHeader): string[] {
  const out: string[] = [];
  if (h.aoi) out.push(`// @aoi ${h.aoi}`);
  if (h.program) out.push(`// @program ${h.program}`);
  out.push(`// @routine ${h.routine}`);
  out.push(`// @type ${h.type}`);
  if (h.description) {
    for (const line of h.description.split('\n')) out.push(`// @description ${line}`);
  }
  if (h.undecoded) out.push(`// @undecoded ${h.undecoded}`);
  return out;
}

export function formatRoutine(owner: { program?: string; aoi?: string }, r: Routine): string {
  const header = metaLines({ ...owner, routine: r.name, type: r.type, description: r.description, undecoded: r.undecoded });
  const body: string[] = [];
  if (r.type === 'RLL') {
    for (const rung of r.rungs) {
      body.push('', `// ---- Rung ${rung.number} ----`);
      if (rung.comment) for (const c of rung.comment.split('\n')) body.push(c ? `// > ${c}` : '// >');
      if (rung.text) body.push(...formatRungLines(rung.text));
      else body.push('// (rung text not stored in the project file)');
    }
  } else if (r.lines) {
    body.push('', ...r.lines);
  }
  return [...header, ...body, ''].join('\n');
}

export interface ParsedRoutineFile {
  header: RoutineHeader;
  rungs: Rung[];
  lines?: string[];
  /** Problems found while parsing: unterminated rung, etc. */
  problems: string[];
}

export function parseRoutineFile(text: string): ParsedRoutineFile {
  const header: RoutineHeader = { routine: '', type: 'RLL' };
  const problems: string[] = [];
  const descr: string[] = [];
  const src = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  // Metadata block: leading `// @` lines (blank lines allowed before the first).
  for (; i < src.length; i++) {
    if (src[i]!.trim() === '') { if (header.routine) break; continue; }
    const m = /^\/\/\s*@(\w+)\s?(.*)$/.exec(src[i]!.trimStart());
    if (!m) break;
    const key = m[1]!.toLowerCase();
    const val = m[2] ?? '';
    if (key === 'program') header.program = val.trim();
    else if (key === 'aoi') header.aoi = val.trim();
    else if (key === 'routine') header.routine = val.trim();
    else if (key === 'type') header.type = val.trim().toUpperCase();
    else if (key === 'description') descr.push(val);
    else if (key === 'undecoded') header.undecoded = val;
  }
  if (descr.length) header.description = descr.join('\n');
  if (!header.routine) problems.push('Missing "// @routine <name>" header line.');

  if (header.type !== 'RLL') {
    // ST keeps every remaining line verbatim, minus the single blank separator.
    const rest = src.slice(i);
    while (rest.length && rest[0]!.trim() === '') rest.shift();
    while (rest.length && rest[rest.length - 1]!.trim() === '') rest.pop();
    return { header, rungs: [], lines: rest, problems };
  }

  const rungs: Rung[] = [];
  let comment: string[] = [];
  let pending = '';
  for (; i < src.length; i++) {
    const raw = src[i]!;
    const l = raw.trim();
    if (l === '') continue;
    // Comment text keeps its trailing whitespace: it is part of the rung comment.
    const cm = /^\/\/\s?>\s?(.*)$/.exec(raw.trimStart());
    if (cm) {
      if (pending) problems.push(`Line ${i + 1}: comment found inside an unterminated rung.`);
      comment.push(cm[1] ?? '');
      continue;
    }
    if (l.startsWith('//')) continue;
    pending += (pending ? ' ' : '') + l;
    if (l.endsWith(';')) {
      const rung: Rung = { number: rungs.length, text: pending };
      if (comment.length) rung.comment = comment.join('\n');
      rungs.push(rung);
      pending = '';
      comment = [];
    }
  }
  if (pending) problems.push(`Last rung is missing its terminating ";": ${pending.slice(0, 80)}`);
  return { header, rungs, problems };
}
