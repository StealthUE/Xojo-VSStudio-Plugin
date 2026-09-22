/**
 * write.ts — Package an edited routine as an L5X routine export that Studio 5000 can
 * import (Program > right-click Routines > Import Routine, or right-click a routine's
 * rungs > Import Rungs). The .ACD itself is never written.
 *
 * Before writing, each routine is checked:
 *   - ladder: structure of every rung (balanced brackets and parentheses, terminating ';')
 *     and instruction names against the Logix instruction set and the project's AOIs
 *   - ST: balanced brackets and comments, matched IF/CASE/FOR/WHILE/REPEAT blocks
 *   - JSR targets, and tag names against program and controller tags
 * Problems are reported, not fixed; the file is still written so it can be inspected.
 */

import { Controller, Program, Routine, Rung } from '../model';
import { parseInstructions, rungProblems } from '../export/rungText';
import { stProblems } from '../export/stText';
import { locList, routineUnits } from '../export/logicUnits';
import { buildAoiIndex } from '../export/aoiIndex';

const KNOWN_INSTRUCTIONS = new Set([
  // bit, timer, counter
  'XIC', 'XIO', 'OTE', 'OTL', 'OTU', 'ONS', 'OSR', 'OSF', 'TON', 'TOF', 'RTO', 'TONR', 'TOFR', 'RTOR',
  'CTU', 'CTD', 'CTUD', 'RES',
  // compare
  'EQU', 'NEQ', 'LES', 'LEQ', 'GRT', 'GEQ', 'LIM', 'MEQ', 'CMP',
  // math / move / logic
  'ADD', 'SUB', 'MUL', 'DIV', 'MOD', 'SQR', 'SQRT', 'NEG', 'ABS', 'CPT', 'XPY', 'SIN', 'COS', 'TAN', 'ASN',
  'ACS', 'ATN', 'LN', 'LOG', 'DEG', 'RAD', 'TOD', 'FRD', 'TRN', 'TRUNC', 'MOV', 'MVM', 'BTD', 'BTDT', 'CLR',
  'SWPB', 'AND', 'OR', 'XOR', 'NOT', 'BAND', 'BOR', 'BXOR', 'BNOT', 'SCL', 'SCP',
  // array / file
  'COP', 'CPS', 'FLL', 'FAL', 'FSC', 'AVE', 'SRT', 'STD', 'SIZE', 'BSL', 'BSR', 'FFL', 'FFU', 'LFL', 'LFU',
  'SQI', 'SQO', 'SQL', 'FBC', 'DDT', 'DDD',
  // program control
  'JSR', 'SBR', 'RET', 'JMP', 'LBL', 'JXR', 'TND', 'MCR', 'UID', 'UIE', 'SFR', 'SFP', 'EOT', 'AFI', 'NOP',
  'EVENT', 'IOT', 'GSV', 'SSV', 'MSG', 'PID', 'ALMD', 'ALMA',
  // string
  'CONCAT', 'MID', 'DTOS', 'STOD', 'RTOS', 'STOR', 'UPPER', 'LOWER', 'DELETE', 'INSERT', 'FIND',
  // motion (common)
  'MSO', 'MSF', 'MASD', 'MASR', 'MDO', 'MDF', 'MAFR', 'MAJ', 'MAM', 'MAS', 'MAH', 'MAW', 'MAR', 'MAOC',
  'MAG', 'MCD', 'MRP', 'MAPC', 'MATC', 'MDAC', 'MGS', 'MGSD', 'MGSR', 'MGSP', 'MCS', 'MCLM', 'MCCM', 'MCT',
  'MCTP', 'MCSD', 'MCSR', 'MDCC', 'MRAT', 'MAHD', 'MSG',
  // safety
  'ESTOP', 'ROUT', 'DCS', 'DCST', 'DCSTL', 'DCSTM', 'DCSRT', 'DCM', 'SMAT', 'TSAM', 'TSSM', 'THRS', 'THRSE',
  'LC', 'CROUT', 'DIN', 'ENPEN', 'FPMS', 'CBCM', 'CBIM', 'CBSSM', 'AVC', 'MMVC', 'SFX', 'SLS', 'SOS', 'SS1',
  'SS2', 'STO', 'SDI', 'SBC', 'SLP', 'SSM', 'SLT', 'SSX', 'SCK', 'SCA',
  // process / drives (common)
  'PIDE', 'RMPS', 'POSP', 'SRTP', 'LDLG', 'FGEN', 'TOT', 'DEDT', 'LDL2', 'HPF', 'LPF', 'NTCH', 'INTG', 'SCRV',
  'PI', 'DERV', 'SNEG', 'SEL', 'ESEL', 'SSUM', 'MUX', 'HLL', 'RLIM', 'MAXC', 'MINC', 'MAVE', 'MSTD', 'LLL',
  'DFF', 'JKFF', 'RESD', 'SETD', 'CUTD', 'OSRI', 'OSFI', 'BTDT',
]);

export interface ValidationIssue {
  rung?: number;
  message: string;
}

/** Lower-case tag names visible from a program (program tags + controller tags). */
function visibleTags(c: Controller, program?: Program): Set<string> {
  const s = new Set<string>([...c.tags, ...(c.moduleTags ?? [])].map(t => t.name.toLowerCase()));
  for (const t of program?.tags ?? []) s.add(t.name.toLowerCase());
  return s;
}

/**
 * Check an edited routine before packaging. Ladder: rung structure, instruction names, JSR
 * targets, tags. ST: bracket/comment/block balance, JSR targets, tags. Module I/O tags
 * (`Module:I.Data`) and program-qualified references (`\Program.Tag`) are not checked.
 * `rung` in an ST issue is the 0-based line index.
 */
export function validateRoutine(c: Controller, program: Program | undefined, r: Routine): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (r.type !== 'RLL' && r.type !== 'ST') return issues;
  const aois = new Set(c.aois.map(a => a.name.toUpperCase()));
  const aoiIndex = buildAoiIndex(c);
  const tags = visibleTags(c, program);
  const routines = new Set((program?.routines ?? []).map(x => x.name.toLowerCase()));
  const unknownTags = new Map<string, number[]>();
  const st = r.type === 'ST';
  if (st) {
    for (const p of stProblems(r.lines ?? [])) issues.push({ rung: p.line, message: p.message });
  } else {
    for (const rung of r.rungs) {
      for (const p of rungProblems(rung.text)) issues.push({ rung: rung.number, message: p });
      for (const ins of parseInstructions(rung.text)) {
        if (!KNOWN_INSTRUCTIONS.has(ins.name) && !aois.has(ins.name)) {
          issues.push({ rung: rung.number, message: `unknown instruction ${ins.name}` });
        }
      }
    }
  }
  for (const unit of routineUnits({ ...r, lines: r.lines ?? (st ? [] : undefined) }, aoiIndex)) {
    for (const target of unit.calls) {
      if (program && !routines.has(target.toLowerCase())) {
        issues.push({ rung: unit.n, message: `JSR to routine "${target}" which does not exist in ${program.name}` });
      }
    }
    for (const u of unit.uses) {
      if (tags.has(u.base.toLowerCase()) || u.base.startsWith('\\') || u.base.includes(':')) continue;
      const list = unknownTags.get(u.base) ?? [];
      list.push(unit.n);
      unknownTags.set(u.base, list);
    }
  }
  const where = (ns: number[]) => locList([...new Set(ns)], st);
  for (const [tag, ns] of unknownTags) {
    issues.push({ rung: ns[0], message: `tag "${tag}" is not defined (${where(ns)}): create it in Studio 5000 before or during import` });
  }
  return issues;
}

function cdata(s: string): string {
  return `<![CDATA[${s.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

function attr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function exportDate(d = new Date()): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${days[d.getDay()]} ${mons[d.getMonth()]} ${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${d.getFullYear()}`;
}

/** "RSLogix 5000 v31.00" / "31.11" → "31.00" */
export function softwareRevision(c: Controller): string {
  const m = /v?(\d+)\.(\d+)/.exec(c.softwareVersion ?? '') ?? /(\d+)\.(\d+)/.exec(c.revision ?? '');
  return m ? `${m[1]}.${m[2]!.padStart(2, '0')}` : '31.00';
}

function rungXml(r: Rung, i: number): string[] {
  const out = [`<Rung Number="${i}" Type="N">`];
  if (r.comment) out.push(`<Comment>`, cdata(r.comment.replace(/\n/g, '\r\n')), `</Comment>`);
  out.push(`<Text>`, cdata(r.text), `</Text>`, `</Rung>`);
  return out;
}

/** L5X routine export for one program routine. */
export function routineL5x(c: Controller, programName: string, r: Routine): string {
  const L: string[] = [];
  L.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  L.push(`<RSLogix5000Content SchemaRevision="1.0" SoftwareRevision="${softwareRevision(c)}" TargetName="${attr(r.name)}" ` +
    `TargetType="Routine" TargetSubType="${r.type}" ContainsContext="true" ExportDate="${exportDate()}" ` +
    'ExportOptions="References NoRawData L5KData DecoratedData Context RoutineLabels AliasReferences IOTags NoStringData ForceProtectedEncoding AllProjDocTrans">');
  L.push(`<Controller Use="Context" Name="${attr(c.name)}">`);
  L.push('<Programs Use="Context">');
  L.push(`<Program Use="Context" Name="${attr(programName)}">`);
  L.push('<Routines Use="Context">');
  L.push(`<Routine Use="Target" Name="${attr(r.name)}" Type="${r.type}">`);
  if (r.description) L.push('<Description>', cdata(r.description.replace(/\n/g, '\r\n')), '</Description>');
  if (r.type === 'RLL') {
    L.push('<RLLContent>');
    r.rungs.forEach((g, i) => L.push(...rungXml(g, i)));
    L.push('</RLLContent>');
  } else if (r.type === 'ST') {
    L.push('<STContent>');
    (r.lines ?? []).forEach((line, i) => L.push(`<Line Number="${i}">`, cdata(line), '</Line>'));
    L.push('</STContent>');
  }
  L.push('</Routine>', '</Routines>', '</Program>', '</Programs>', '</Controller>', '</RSLogix5000Content>', '');
  return L.join('\r\n');
}
