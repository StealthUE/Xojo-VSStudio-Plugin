/**
 * aoiIndex.ts — Call signatures of the project's Add-On Instructions, so a call such as
 *   EStop_Device(Inst, Remote_IO:I.Pt02, 0, HMI.Reset, Zone1_EStop)
 * can be read as: Inst written; the input bit, 0 and the reset read; and, because the
 * device object parameter is InOut and the AOI logic writes Device.Ok, Zone1_EStop.Ok
 * written by this call.
 *
 * Inner member use is taken from the AOI's own routines, ladder or Structured Text. Nested
 * AOI calls inside AOI logic are resolved with a second pass.
 */

import { Controller } from '../model';
import { AoiIndex, AoiSignature } from './rungText';
import { routineUnits } from './logicUnits';

function signatures(c: Controller, prev?: AoiIndex): AoiIndex {
  const out: AoiIndex = new Map();
  for (const a of c.aois) {
    const params = a.parameters.filter(p => p.name !== 'EnableIn' && p.name !== 'EnableOut');
    const known = params.some(p => p.usage);
    const sig: AoiSignature = {
      name: a.name,
      // Without declaration info (older decode), fall back to "unknown usage" arguments.
      args: known ? params.filter(p => p.required).map(p => ({ name: p.name, usage: p.usage })) : [],
      inner: new Map(),
    };
    const byLower = new Map(params.map(p => [p.name.toLowerCase(), p.name]));
    for (const r of a.routines) {
      for (const unit of routineUnits(r, prev)) {
        for (const u of unit.uses) {
          const pname = byLower.get(u.base.toLowerCase());
          if (!pname) continue;
          const key = pname.toLowerCase();
          let e = sig.inner.get(key);
          if (!e) { e = { writes: new Set(), reads: new Set() }; sig.inner.set(key, e); }
          const suffix = u.operand.slice(u.base.length).replace(/\s+/g, '');
          (u.write ? e.writes : e.reads).add(suffix);
        }
      }
    }
    out.set(a.name.toUpperCase(), sig);
  }
  return out;
}

export function buildAoiIndex(c: Controller): AoiIndex {
  return signatures(c, signatures(c));
}
