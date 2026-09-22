/**
 * stText.ts — Structured Text: read/write classification of every operand, JSR targets,
 * and structural checks. The ST counterpart of the operand half of rungText.ts.
 *
 * A routine is analysed as one text (statements may span lines); every use records the
 * 0-based source line it is on. Before scanning, comments (`//`, `(* *)`, `/* *\/`), string
 * literals and typed literals (`16#FF`, `T#5s`) are blanked out with spaces, keeping line
 * breaks, so offsets still map to lines.
 *
 *   Tag := expr;  Tag [:= ] expr;   Tag is written, every tag in expr is read
 *   FOR i := a TO b BY c DO          i is written, a/b/c are read
 *   Name(args)                       AOI call or built-in instruction: classified exactly as
 *                                    in a rung (instance written, Output args written, ...)
 *   Func(args) in an expression      e.g. ABS(x): the function name is not a tag, args are read
 *   anything else                    read
 */

import { AoiIndex, Instruction, OperandUse, baseTag, instructionUses, isKnownInstruction } from './rungText';

export interface StUse extends OperandUse {
  /** 0-based line within the routine's source. */
  line: number;
}

const KEYWORDS = new Set([
  'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF', 'CASE', 'OF', 'END_CASE', 'FOR', 'TO', 'BY', 'DO', 'END_FOR',
  'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT', 'EXIT', 'RETURN',
  'AND', 'OR', 'XOR', 'NOT', 'MOD', 'TRUE', 'FALSE',
]);

/** Blank comments, strings and typed literals (same length, newlines kept). */
export function blankNonCode(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      const e = src.indexOf('\n', i);
      const end = e < 0 ? n : e;
      blank(i, end); i = end;
    } else if (c === '(' && d === '*') {
      const e = src.indexOf('*)', i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end); i = end;
    } else if (c === '/' && d === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e < 0 ? n : e + 2;
      blank(i, end); i = end;
    } else if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '$' ? 2 : 1;
      blank(i, j + 1); i = j + 1;
    } else if (/[A-Za-z0-9_]/.test(c) && (i === 0 || !/[A-Za-z0-9_.]/.test(src[i - 1]!))) {
      // Typed literal: 16#FF, 2#1010_0101, T#5s, TIME#1h2m, and plain numbers 1.5E3.
      const m = /^(?:\d+#[0-9A-Fa-f_]+|(?:T|TIME|LT|D|DATE|TOD|DT)#[0-9A-Za-z_.:+-]+|\d[0-9_]*(?:\.[0-9_]+)?(?:[eE][-+]?\d+)?)/i.exec(src.slice(i, i + 64));
      if (m) { blank(i, i + m[0].length); i += m[0].length; continue; }
      while (i < n && /[A-Za-z0-9_]/.test(src[i]!)) i++;
    } else {
      i++;
    }
  }
  return out.join('');
}

/** Index of the `)` closing the `(` at `open`, or -1. */
function closeParen(s: string, open: number): number {
  let depth = 0;
  for (let k = open; k < s.length; k++) {
    const c = s[k];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') { depth--; if (depth === 0) return c === ')' ? k : -1; }
  }
  return -1;
}

/**
 * Split call arguments at top-level commas, keeping each argument's offset. Structure is
 * read from `s` (blanked), text taken from `text` (the original, same offsets).
 */
function splitArgs(s: string, text: string, from: number, to: number): { text: string; at: number }[] {
  const out: { text: string; at: number }[] = [];
  let depth = 0;
  let start = from;
  for (let k = from; k <= to; k++) {
    const c = s[k];
    if (k === to || (c === ',' && depth === 0)) {
      const raw = text.slice(start, k);
      const lead = raw.length - raw.trimStart().length;
      out.push({ text: raw.trim(), at: start + lead });
      start = k + 1;
      continue;
    }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
  }
  return out;
}

const PATH = /\\?[A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z0-9_]+)*(?:\s*\.\s*[A-Za-z0-9_]+|\s*\[[^\]]*\])*/y;

/** Operand uses in an ST routine, each with its 0-based line. */
export function stOperandUses(lines: string[], aois?: AoiIndex): StUse[] {
  // `[:=]` (non-retentive assignment) → ` := `, same length, so offsets agree between the
  // original text and its blanked copy.
  const text = lines.join('\n').replace(/\[:=\]/g, ' := ');
  const src = blankNonCode(text);
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1);
  const lineOf = (off: number) => {
    let lo = 0; let hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid]! <= off) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const out: StUse[] = [];
  const add = (u: OperandUse, at: number) => out.push({ ...u, line: lineOf(at) });

  /** Reads of every tag path in src[from, to), recursing into calls. */
  const scan = (from: number, to: number) => {
    let i = from;
    while (i < to) {
      const c = src[i]!;
      if (!/[A-Za-z_\\]/.test(c) || (i > 0 && /[A-Za-z0-9_]/.test(src[i - 1]!))) { i++; continue; }
      PATH.lastIndex = i;
      const m = PATH.exec(src);
      if (!m) { i++; continue; }
      const end = i + m[0].length;
      const path = text.slice(i, end).replace(/\s+/g, '');
      const word = /^\\?[A-Za-z_][A-Za-z0-9_]*/.exec(path)![0];
      const upper = word.toUpperCase();
      // Call: Name( ... )
      let p = end;
      while (p < to && (src[p] === ' ' || src[p] === '\t' || src[p] === '\r' || src[p] === '\n')) p++;
      if (src[p] === '(' && path === word) {
        const close = closeParen(src, p);
        const stop = close < 0 ? to : close;
        const args = splitArgs(src, text, p + 1, stop);
        if (isKnownInstruction(upper) || aois?.has(upper)) {
          const ins: Instruction = { name: upper, operands: args.map(a => a.text), text: text.slice(i, stop + 1) };
          const uses: OperandUse[] = [];
          instructionUses(ins, aois, uses);
          for (const u of uses) add(u, args[u.index]?.at ?? i);
          // Index expressions inside array operands are reads too.
          for (const a of args) scanIndexes(a.text, a.at);
        } else {
          scan(p + 1, stop);
        }
        i = stop + 1;
        continue;
      }
      if (KEYWORDS.has(upper)) { i = end; continue; }
      const base = baseTag(path);
      // Assignment target?
      let q = end;
      while (q < to && /\s/.test(src[q]!)) q++;
      const write = src[q] === ':' && src[q + 1] === '=';
      if (base) add({ instruction: write ? ':=' : 'ST', operand: path, base, write, index: 0 }, i);
      scanIndexes(m[0], i);
      i = end;
    }
  };
  /** Tags used inside `[...]` of a path at offset `at`. */
  const scanIndexes = (text: string, at: number) => {
    let k = text.indexOf('[');
    while (k >= 0) {
      const e = text.indexOf(']', k);
      if (e < 0) break;
      scan(at + k + 1, at + e);
      k = text.indexOf('[', e);
    }
  };
  scan(0, src.length);
  return out;
}

/** Routines called with JSR in ST, with the 0-based line of each call. */
export function stJsrTargets(lines: string[]): { target: string; line: number }[] {
  const src = blankNonCode(lines.join('\n'));
  const out: { target: string; line: number }[] = [];
  const re = /\bJSR\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const line = (src.slice(0, m.index).match(/\n/g) ?? []).length;
    out.push({ target: m[1]!, line });
  }
  return out;
}

/** Structural checks: balanced brackets and comments, and matched block keywords. */
export function stProblems(lines: string[]): { line?: number; message: string }[] {
  const problems: { line?: number; message: string }[] = [];
  const joined = lines.join('\n');
  const opens = (re: RegExp) => (joined.match(re) ?? []).length;
  if (opens(/\(\*/g) !== opens(/\*\)/g)) problems.push({ message: 'unterminated (* comment *)' });
  if (opens(/\/\*/g) !== opens(/\*\//g)) problems.push({ message: 'unterminated /* comment */' });
  const src = blankNonCode(joined);
  let paren = 0;
  let bracket = 0;
  let line = 0;
  for (const c of src) {
    if (c === '\n') line++;
    else if (c === '(') paren++;
    else if (c === ')') paren--;
    else if (c === '[') bracket++;
    else if (c === ']') bracket--;
    if (paren < 0) { problems.push({ line, message: 'unexpected ")"' }); paren = 0; }
    if (bracket < 0) { problems.push({ line, message: 'unexpected "]"' }); bracket = 0; }
  }
  if (paren > 0) problems.push({ message: 'unbalanced parentheses' });
  if (bracket > 0) problems.push({ message: 'unbalanced brackets' });
  const count = (w: string) => (src.match(new RegExp(`\\b${w}\\b`, 'gi')) ?? []).length;
  for (const [open, close] of [['IF', 'END_IF'], ['CASE', 'END_CASE'], ['FOR', 'END_FOR'], ['WHILE', 'END_WHILE'], ['REPEAT', 'END_REPEAT']] as const) {
    const a = count(open);
    const b = count(close);
    if (a !== b) problems.push({ message: `${a} ${open} but ${b} ${close}` });
  }
  return problems;
}
