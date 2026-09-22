/**
 * rungText.ts — Logix neutral rung text: tokenising, structure, layout, and read/write
 * classification of every operand.
 *
 * Neutral text grammar (what Studio 5000 stores and L5X uses):
 *   rung     := series ';'
 *   series   := element*
 *   element  := instr | '[' series (',' series)* ']'
 *   instr    := NAME '(' operand (',' operand)* ')'
 * Operands may contain nested brackets (array indices) and parentheses (CPT/CMP
 * expressions), so splitting is depth-aware. Whitespace between elements is not
 * significant.
 */

export interface Instruction {
  /** Upper-cased mnemonic or AOI name. */
  name: string;
  operands: string[];
  /** The instruction exactly as written, e.g. `XIC(Start)`. */
  text: string;
}

/** Read one instruction starting at `i` (which must be the first letter of its name). */
function readInstruction(text: string, i: number): { ins: Instruction; end: number } | undefined {
  const n = text.length;
  let j = i + 1;
  while (j < n && /[A-Za-z0-9_]/.test(text[j]!)) j++;
  let p = j;
  while (p < n && text[p] === ' ') p++;
  if (text[p] !== '(') return undefined;
  const operands: string[] = [];
  let depth = 0;
  let cur = '';
  let k = p + 1;
  for (; k < n; k++) {
    const c = text[k]!;
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') {
      if (depth === 0 && c === ')') break;
      depth--;
    } else if (c === ',' && depth === 0) {
      operands.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== '' || operands.length) operands.push(cur.trim());
  return { ins: { name: text.slice(i, j).toUpperCase(), operands, text: text.slice(i, k + 1) }, end: k + 1 };
}

export function parseInstructions(text: string): Instruction[] {
  const out: Instruction[] = [];
  let i = 0;
  while (i < text.length) {
    if (/[A-Za-z_]/.test(text[i]!)) {
      const r = readInstruction(text, i);
      if (r) { out.push(r.ins); i = r.end; continue; }
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i]!)) i++;
      continue;
    }
    i++;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------------------

export type Element =
  | { kind: 'ins'; ins: Instruction }
  | { kind: 'branch'; legs: Element[][] };

/** Parse a rung into its series/branch tree. Tolerant: stops quietly at malformed text. */
export function parseRung(text: string): Element[] {
  let i = 0;
  const n = text.length;
  const series = (): Element[] => {
    const out: Element[] = [];
    while (i < n) {
      const c = text[i]!;
      if (c === '[') {
        i++;
        const legs: Element[][] = [series()];
        while (i < n && text[i] === ',') { i++; legs.push(series()); }
        if (text[i] === ']') i++;
        out.push({ kind: 'branch', legs });
      } else if (c === ',' || c === ']' || c === ';') {
        return out;
      } else if (/[A-Za-z_]/.test(c)) {
        const r = readInstruction(text, i);
        if (!r) { i++; continue; }
        out.push({ kind: 'ins', ins: r.ins });
        i = r.end;
      } else {
        i++;
      }
    }
    return out;
  };
  const root = series();
  return root;
}

/** Every instruction in a series, depth first. */
export function instructionsOf(series: Element[]): Instruction[] {
  const out: Instruction[] = [];
  for (const e of series) {
    if (e.kind === 'ins') out.push(e.ins);
    else for (const leg of e.legs) out.push(...instructionsOf(leg));
  }
  return out;
}

/** Series back to compact neutral text. */
export function seriesText(series: Element[]): string {
  let s = '';
  for (const e of series) {
    if (e.kind === 'ins') s += (s && !/[[,]$/.test(s) ? ' ' : '') + e.ins.text;
    else s += `[${e.legs.map(seriesText).join(',')}]`;
  }
  return s;
}

/**
 * Canonical spacing: no whitespace around branch punctuation, exactly one space between
 * two adjacent instructions, operands untouched. Two rungs that differ only in layout have
 * the same canonical text. (Studio accepts both `XIC(a)XIC(b)` and `XIC(a) XIC(b)`.)
 */
export function canonicalRung(text: string): string {
  let out = '';
  let depth = 0;
  const t = text.trim();
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (depth === 0 && /\s/.test(c)) continue;
    // Exactly one space between two adjacent instructions, whatever the original had.
    if (depth === 0 && out.endsWith(')') && /[A-Za-z_\\]/.test(c)) out += ' ';
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    out += c;
  }
  return out;
}

/**
 * Lay a long rung with branches out over several lines, one branch leg per line,
 * nested legs indented. Short or branch-free rungs stay on one line.
 */
export function formatRungLines(text: string, maxWidth = 110): string[] {
  const t = text.trim();
  if (t.length <= maxWidth || !t.includes('[')) return [t];
  const tree = parseRung(t);
  if (canonicalRung(seriesText(tree) + ';') !== canonicalRung(t)) return [t]; // not safely re-layable
  const lines: string[] = [];
  let cur = '';
  const pad = (d: number) => '  '.repeat(d);
  const flush = () => { if (cur.trim()) lines.push(cur); cur = ''; };
  const emit = (series: Element[], d: number) => {
    for (const e of series) {
      if (e.kind === 'ins') {
        // Long series wrap at instruction boundaries, continuing at the same indent.
        if (cur.length + e.ins.text.length > maxWidth && /\)$/.test(cur)) {
          flush();
          cur = pad(d) + (d > 0 ? ' ' : '');
        }
        cur += (cur.trim() && !/[[,\]]$/.test(cur) ? ' ' : '') + e.ins.text;
      } else {
        flush();
        e.legs.forEach((leg, j) => {
          cur = pad(d) + (j === 0 ? '[' : ',');
          emit(leg, d + 1);
          flush();
        });
        cur = pad(d) + ']';
      }
    }
  };
  emit(tree, 0);
  cur += ';';
  flush();
  return lines;
}

// ---------------------------------------------------------------------------------------
// Reads and writes
// ---------------------------------------------------------------------------------------

/** Operand positions (0-based) each instruction writes. Anything not listed is a read. */
const WRITES: Record<string, number[]> = {
  OTE: [0], OTL: [0], OTU: [0], ONS: [0], OSR: [0, 1], OSF: [0, 1],
  TON: [0], TOF: [0], RTO: [0], TONR: [0], TOFR: [0], RTOR: [0],
  CTU: [0], CTD: [0], CTUD: [0], RES: [0],
  MOV: [1], MVM: [2], COP: [1], CPS: [1], FLL: [1], CLR: [0], BTD: [3], BTDT: [0],
  ADD: [2], SUB: [2], MUL: [2], DIV: [2], MOD: [2], XPY: [2],
  SQR: [1], SQRT: [1], NEG: [1], ABS: [1], SIN: [1], COS: [1], TAN: [1], ASN: [1], ACS: [1], ATN: [1],
  LN: [1], LOG: [1], DEG: [1], RAD: [1], TOD: [1], FRD: [1], TRN: [1], TRUNC: [1],
  AND: [2], OR: [2], XOR: [2], NOT: [1], BAND: [0], BOR: [0], BXOR: [0], BNOT: [0],
  SWPB: [2], CPT: [0], SCL: [0], SCP: [5],
  BSL: [0, 1], BSR: [0, 1], FFL: [1, 2], FFU: [1, 2], LFL: [1, 2], LFU: [1, 2],
  SQO: [2, 3], SQI: [3], SQL: [0, 2], FAL: [0], FSC: [0], FBC: [3, 4], DDT: [3, 4],
  AVE: [1, 2], SRT: [1], STD: [2, 3], SIZE: [2],
  GSV: [3], MSG: [0], PID: [0, 4], PIDE: [0], ALMD: [0], ALMA: [0],
  CONCAT: [2], MID: [3], DTOS: [1], STOD: [1], RTOS: [1], STOR: [1], UPPER: [1], LOWER: [1],
  DELETE: [3], INSERT: [3], FIND: [4],
  MAOC: [0], MSO: [1], MSF: [1], MAS: [1], MAM: [1], MAJ: [1], MAH: [1], MRP: [1],
  EVENT: [], JSR: [], SBR: [], RET: [], JMP: [], LBL: [], TND: [], MCR: [], NOP: [], AFI: [],
  UID: [], UIE: [], SFR: [], SFP: [], EOT: [],
};

/** Instructions whose operand 0 is a routine / label name, not a tag. */
const NON_TAG_OPERAND0 = new Set(['JSR', 'SFR', 'SFP', 'JMP', 'LBL']);

/** Instructions whose operands are expressions containing several tags. */
const EXPRESSION_OPERANDS = new Set(['CMP', 'CPT', 'FAL', 'FSC']);

export interface OperandUse {
  instruction: string;
  /** Operand path as used, e.g. `Motor.Run[3]`; for AOI InOut, caller tag + inner member. */
  operand: string;
  /** Base tag name, e.g. `Motor` for `Motor.Run[3].Bit`. */
  base: string;
  write: boolean;
  /** AOI calls: the parameter this operand is bound to ("instance" for operand 0). */
  via?: string;
  /** 0-based operand position in the instruction. */
  index: number;
}

/** What an AOI call does with each argument: required parameters in call order. */
export interface AoiSignature {
  name: string;
  args: { name: string; usage?: string }[];
  /** Per parameter (lower-case): member suffixes the AOI logic writes / reads, "" = whole. */
  inner: Map<string, { writes: Set<string>; reads: Set<string> }>;
}

/** Upper-cased AOI name → signature. */
export type AoiIndex = Map<string, AoiSignature>;

const IDENT = /[A-Za-z_][A-Za-z0-9_:]*(?:\.[A-Za-z0-9_:]+|\[[^\]]*\])*/g;
const EXPR_FUNCS = new Set([
  'AND', 'OR', 'XOR', 'NOT', 'MOD', 'ABS', 'SQR', 'SQRT', 'SIN', 'COS', 'TAN', 'ASN', 'ACS', 'ATN',
  'LN', 'LOG', 'DEG', 'RAD', 'TRN', 'FRD', 'TOD',
]);

/** Leading identifier of an operand: `Tag.Member[1]` → `Tag`; `\Prog.Tag` → `\Prog.Tag`. */
export function baseTag(operand: string): string | undefined {
  const s = operand.trim();
  if (s.startsWith('\\')) {
    const m = /^\\[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*/.exec(s);
    return m ? m[0] : undefined;
  }
  const m = /^[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z0-9_]+)*/.exec(s);
  if (!m) return undefined;
  return m[0];
}

export function isLiteral(s: string): boolean {
  return /^[-+]?(\d|\.\d|16#|8#|2#)/.test(s) || s === '?' || s === '' || /^'.*'$/.test(s);
}

function aoiArgUses(ins: Instruction, sig: AoiSignature, out: OperandUse[]): void {
  ins.operands.forEach((op, idx) => {
    if (isLiteral(op)) return;
    const base = baseTag(op);
    if (!base) return;
    if (idx === 0) { out.push({ instruction: ins.name, operand: op, base, write: true, via: 'instance', index: 0 }); return; }
    const p = sig.args[idx - 1];
    const push = (operand: string, write: boolean) =>
      out.push({ instruction: ins.name, operand, base, write, via: p?.name, index: idx });
    if (!p || !p.usage) { push(op, false); return; }
    if (p.usage === 'Input') { push(op, false); return; }
    if (p.usage === 'Output') { push(op, true); return; }
    // InOut: the caller's tag is read/written exactly where the AOI logic touches the parameter.
    const inner = sig.inner.get(p.name.toLowerCase());
    if (!inner || (!inner.writes.size && !inner.reads.size)) { push(op, false); push(op, true); return; }
    for (const s of inner.writes) push(op + s, true);
    for (const s of inner.reads) push(op + s, false);
  });
}

/**
 * Every tag operand in a rung, with read/write classification. AOI calls are resolved
 * through `aois`: Input arguments are reads, Output arguments writes, InOut arguments are
 * read/written at the members the AOI's own logic reads/writes, and the instance is written.
 */
export function operandUses(text: string, aois?: AoiIndex): OperandUse[] {
  const out: OperandUse[] = [];
  for (const ins of parseInstructions(text)) instructionUses(ins, aois, out);
  return out;
}

/** True for a built-in instruction whose operand read/write positions are known. */
export function isKnownInstruction(name: string): boolean {
  return WRITES[name.toUpperCase()] !== undefined;
}

/** Operand uses of one instruction (built-in or AOI call), appended to `out`. */
export function instructionUses(ins: Instruction, aois: AoiIndex | undefined, out: OperandUse[]): void {
  const sig = WRITES[ins.name] ? undefined : aois?.get(ins.name);
  if (sig) { aoiArgUses(ins, sig, out); return; }
  const writes = WRITES[ins.name] ?? [];
  ins.operands.forEach((op, idx) => {
    if (idx === 0 && NON_TAG_OPERAND0.has(ins.name)) return;
    if (isLiteral(op)) return;
    const write = writes.includes(idx);
    if (EXPRESSION_OPERANDS.has(ins.name) && !write) {
      for (const m of op.match(IDENT) ?? []) {
        const b = baseTag(m);
        if (b && !EXPR_FUNCS.has(b.toUpperCase())) out.push({ instruction: ins.name, operand: m, base: b, write: false, index: idx });
      }
      return;
    }
    const b = baseTag(op);
    if (b) out.push({ instruction: ins.name, operand: op, base: b, write, index: idx });
  });
}

/** Routine names called with JSR in a rung. */
export function jsrTargets(text: string): string[] {
  return parseInstructions(text)
    .filter(i => i.name === 'JSR' && i.operands[0])
    .map(i => i.operands[0]!);
}

/** Structural checks on one rung: balanced brackets and parentheses, terminating `;`. */
export function rungProblems(text: string): string[] {
  const problems: string[] = [];
  const t = text.trim();
  if (!t.endsWith(';')) problems.push('does not end with ";"');
  let paren = 0;
  let bracket = 0;
  for (const c of t) {
    if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
    if (paren < 0 || bracket < 0) break;
  }
  if (paren !== 0) problems.push('unbalanced parentheses');
  if (bracket !== 0) problems.push('unbalanced branch brackets');
  return problems;
}
