/**
 * graphical.ts — Function Block Diagram and Sequential Function Chart routines from an L5X,
 * rendered as read-only text in Structured Text syntax, so people and AI can follow them
 * and the ST analyser can cross-reference them.
 *
 * FBD: one section per sheet. Every wire becomes an assignment from its source to its
 * destination pin:
 *     ADD_01.SourceA := Tank_Level;       input reference → block pin
 *     Alarm_Out := ADD_01.Dest;           block pin → output reference
 *     TON_2.TimerEnable := GRT_1.Dest;    block → block
 * On-page connectors (OCon → ICon of the same name) are followed through. Blocks are named
 * by their backing tag (Operand); functions without one by Type_ID.
 *
 * SFC: steps with their actions (ST bodies copied as is), transitions as
 * `Transition := condition;`, then the chart's flow as `From -> To` lines.
 *
 * The result is documentation, not source: these files are not packaged back into L5X.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type X = any;

const list = (v: X): X[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

function stLines(st: X, rawText: (n: X) => string | undefined): string[] {
  return list(st?.Line).map(l => (rawText(l) ?? '').replace(/\r/g, ''));
}

export function renderFbd(content: X, rawText: (n: X) => string | undefined): string[] {
  const out: string[] = [];
  for (const sheet of list(content?.Sheet)) {
    out.push(`// ---- Sheet ${sheet.Number ?? ''}${sheet.Description ? ` — ${String(rawText(sheet.Description) ?? '').trim()}` : ''} ----`);
    type Node = { kind: string; e: X };
    const nodes = new Map<string, Node>();
    for (const kind of ['IRef', 'ORef', 'ICon', 'OCon', 'Block', 'Function', 'AddOnInstruction', 'JSR', 'SBR', 'RET', 'TextBox']) {
      for (const e of list(sheet[kind])) if (e?.ID !== undefined) nodes.set(String(e.ID), { kind, e });
    }
    const nameOf = (n: Node) => n.e.Operand ?? `${n.e.Type ?? n.e.Name ?? n.kind}_${n.e.ID}`;
    const wires = list(sheet.Wire);
    const endpoint = (id: string, param: string | undefined, side: 'from' | 'to'): string => {
      const n = nodes.get(id);
      if (!n) return `?${id}`;
      if (n.kind === 'IRef' || n.kind === 'ORef') return String(n.e.Operand ?? `?${id}`);
      if (n.kind === 'ICon' || n.kind === 'OCon') return `/*connector ${n.e.Name ?? id}*/`;
      const base = nameOf(n);
      return param ? `${base}.${param}` : side === 'from' ? `${base}.Out` : `${base}.In`;
    };
    // Follow connectors: whatever feeds OCon "X" is the source of every ICon "X".
    const conSource = new Map<string, string>();
    for (const w of wires) {
      const to = nodes.get(String(w.ToID));
      if (to?.kind === 'OCon') conSource.set(String(to.e.Name), endpoint(String(w.FromID), w.FromParam, 'from'));
    }
    for (const n of nodes.values()) {
      if (n.kind === 'Block' || n.kind === 'Function') out.push(`// Block ${nameOf(n)} : ${n.e.Type ?? '?'}`);
      else if (n.kind === 'AddOnInstruction') {
        out.push(`// AOI ${nameOf(n)} : ${n.e.Name ?? '?'}`);
        for (const p of list(n.e.InOutParameter)) out.push(`// InOut ${p.Name} = ${p.Argument}`);
      } else if (n.kind === 'JSR') out.push(`JSR(${n.e.Routine ?? '?'});`);
      else if (n.kind === 'TextBox') {
        const t = rawText(n.e.Text) ?? rawText(n.e);
        if (t) for (const l of t.replace(/\r/g, '').split('\n')) out.push(`// ${l}`);
      }
    }
    for (const w of wires) {
      const to = nodes.get(String(w.ToID));
      if (to?.kind === 'OCon') continue;
      const from = nodes.get(String(w.FromID));
      const src = from?.kind === 'ICon'
        ? conSource.get(String(from.e.Name)) ?? `/*connector ${from.e.Name}*/`
        : endpoint(String(w.FromID), w.FromParam, 'from');
      out.push(`${endpoint(String(w.ToID), w.ToParam, 'to')} := ${src};`);
    }
    out.push('');
  }
  return out;
}

export function renderSfc(content: X, rawText: (n: X) => string | undefined): string[] {
  const out: string[] = [];
  const names = new Map<string, string>();
  for (const s of list(content?.Step)) names.set(String(s.ID), s.Operand ?? s.Name ?? `Step_${s.ID}`);
  for (const t of list(content?.Transition)) names.set(String(t.ID), t.Operand ?? `Tran_${t.ID}`);
  for (const s of list(content?.Stop)) names.set(String(s.ID), s.Operand ?? `Stop_${s.ID}`);
  for (const b of list(content?.Branch)) {
    const label = `${b.BranchType ?? ''} ${b.BranchFlow ?? ''} branch ${b.ID}`.trim();
    names.set(String(b.ID), `<${label}>`);
    for (const leg of list(b.Leg)) names.set(String(leg.ID), `<${label} leg ${leg.ID}>`);
  }

  for (const s of list(content?.Step)) {
    out.push(`// ---- Step ${names.get(String(s.ID))}${s.InitialStep === 'true' ? ' (initial)' : ''} ----`);
    if (s.Preset !== undefined) out.push(`// Preset ${s.Preset} ms`);
    for (const a of list(s.Action)) {
      out.push(`// Action ${a.Operand ?? a.Name ?? a.ID} (qualifier ${a.Qualifier ?? 'N'})`);
      out.push(...stLines(a.Body?.STContent, rawText));
    }
    out.push('');
  }
  for (const t of list(content?.Transition)) {
    const cond = stLines(t.Condition?.STContent, rawText);
    out.push(`// ---- Transition ${names.get(String(t.ID))} ----`);
    if (cond.length) {
      // A transition condition is one boolean expression, possibly over several lines.
      out.push(`${names.get(String(t.ID))} := ${cond[0]!.trim()}`, ...cond.slice(1));
      if (!/;\s*$/.test(cond[cond.length - 1]!)) out[out.length - 1] += ';';
    }
    out.push('');
  }
  const links = list(content?.DirectedLink);
  if (links.length) {
    out.push('// ---- Flow ----');
    for (const l of links) out.push(`// ${names.get(String(l.FromID)) ?? l.FromID} -> ${names.get(String(l.ToID)) ?? l.ToID}`);
  }
  return out;
}
