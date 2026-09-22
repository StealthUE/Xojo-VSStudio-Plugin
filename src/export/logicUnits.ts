/**
 * logicUnits.ts — A routine's logic as a list of addressable units, whatever its language:
 * one unit per rung for ladder, one per source line (that uses a tag or calls a routine)
 * for Structured Text. Cross reference, analysis and validation all work on units, so ST is
 * covered everywhere ladder is.
 *
 * A unit's `n` is the rung number for RLL and the 0-based line index for ST. `locText`
 * renders it: `#12` for rung 12, `#L13` for ST line 13 (1-based, as Studio 5000 numbers it).
 */

import { Routine } from '../model';
import { AoiIndex, OperandUse, jsrTargets, operandUses } from './rungText';
import { stJsrTargets, stOperandUses } from './stText';

export interface LogicUnit {
  n: number;
  /** Rung text, or the ST source line (trimmed). */
  text: string;
  uses: OperandUse[];
  /** Routines called with JSR. */
  calls: string[];
}

/** Routines whose logic is text lines in ST syntax: ST source, or the rendered view of FBD/SFC. */
export function isStRoutine(r: Routine): boolean {
  return !!r.lines && (r.type === 'ST' || !!r.rendered);
}

export function routineUnits(r: Routine, aois?: AoiIndex): LogicUnit[] {
  if (isStRoutine(r)) {
    const lines = r.lines!;
    const byLine = new Map<number, LogicUnit>();
    const unit = (n: number) => {
      let u = byLine.get(n);
      if (!u) { u = { n, text: (lines[n] ?? '').trim(), uses: [], calls: [] }; byLine.set(n, u); }
      return u;
    };
    for (const u of stOperandUses(lines, aois)) unit(u.line).uses.push(u);
    for (const j of stJsrTargets(lines)) unit(j.line).calls.push(j.target);
    return [...byLine.values()].sort((a, b) => a.n - b.n);
  }
  return r.rungs.map(g => ({ n: g.number, text: g.text, uses: operandUses(g.text, aois), calls: jsrTargets(g.text) }));
}

/** `#12` for a rung, `#L13` for ST line index 12. */
export function locText(n: number, st: boolean): string {
  return st ? `#L${n + 1}` : `#${n}`;
}

/** "rung 3" / "rungs 3, 4" / "line 13" / "lines 13, 20". */
export function locList(ns: number[], st: boolean): string {
  if (st) return (ns.length === 1 ? 'line ' : 'lines ') + ns.map(n => n + 1).join(', ');
  return (ns.length === 1 ? 'rung ' : 'rungs ') + ns.join(', ');
}
