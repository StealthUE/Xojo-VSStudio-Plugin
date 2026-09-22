/**
 * parse.ts — Read an .L5X (Studio 5000's documented XML export) into the neutral model.
 *
 * L5X carries everything the ACD decoder has plus ST/FBD/SFC source, tag aliases and AOI
 * parameter usage, so an L5X of the same project is also the reference the ACD decoder is
 * checked against.
 */

import * as fs from 'fs';
import { XMLParser } from 'fast-xml-parser';
import {
  Aoi, Controller, DataType, Member, Module, Program, Routine, RoutineType, Tag, Task, TaskType, emptyController,
} from '../model';
import { renderFbd, renderSfc } from './graphical';
import { vendorName } from '../acd/modules';
import { productName } from '../acd/infoXml';
import { separateUnused } from '../export/unused';
import { reportSafetyCoverage } from '../export/analysis';

const ARRAYS = new Set([
  'DataType', 'Member', 'Tag', 'Program', 'Routine', 'Rung', 'Line', 'Task', 'ScheduledProgram',
  'AddOnInstructionDefinition', 'Parameter', 'LocalTag', 'Module', 'Port', 'EncodedData',
  'Sheet', 'IRef', 'ORef', 'ICon', 'OCon', 'Block', 'Function', 'AddOnInstruction', 'Wire', 'TextBox',
  'InOutParameter', 'Step', 'Action', 'Transition', 'Branch', 'Leg', 'DirectedLink', 'Stop',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  trimValues: false,
  parseTagValue: false,
  // CDATA kept apart from the formatting whitespace around it, so ST indentation survives.
  cdataPropName: '__cdata',
  parseAttributeValue: false,
  // Only elements: the DataType attribute on Tag/Member must stay a string.
  isArray: (name, _jpath, _leaf, isAttribute) => !isAttribute && ARRAYS.has(name),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type X = any;

/** Exact content of an element: its CDATA section(s) if any, else its text. */
function rawText(node: X): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return String(node);
  const cd = node.__cdata;
  if (cd !== undefined) return Array.isArray(cd) ? cd.join('') : String(cd);
  return '#text' in node ? String(node['#text']) : undefined;
}

function textOf(node: X): string | undefined {
  const t = rawText(node)?.replace(/\r\n/g, '\n').trim();
  return t || undefined;
}

function dimsFrom(v: X): number[] | undefined {
  if (v === undefined || v === null) return undefined;
  const d = String(v).trim().split(/[\s,]+/).map(Number).filter(n => Number.isFinite(n) && n > 0);
  return d.length ? d : undefined;
}

const ROUTINE_TYPES = new Set(['RLL', 'ST', 'FBD', 'SFC']);

function routineFrom(r: X): Routine {
  const type = (ROUTINE_TYPES.has(r.Type) ? r.Type : 'Unknown') as RoutineType;
  const routine: Routine = { name: r.Name, type, rungs: [], description: textOf(r.Description) };
  if (type === 'RLL') {
    for (const g of (r.RLLContent?.Rung ?? []) as X[]) {
      routine.rungs.push({
        number: Number(g.Number ?? routine.rungs.length),
        text: textOf(g.Text) ?? '',
        // Leading blank lines are part of the comment as Studio 5000 stores it; keep them.
        comment: rawText(g.Comment)?.replace(/\r\n/g, '\n').replace(/\s+$/, '') || undefined,
      });
    }
  } else if (type === 'ST') {
    routine.lines = ((r.STContent?.Line ?? []) as X[]).map(l => (rawText(l) ?? '').replace(/\r/g, ''));
  } else if (type === 'FBD' && r.FBDContent) {
    routine.lines = renderFbd(r.FBDContent, rawText);
    routine.rendered = true;
  } else if (type === 'SFC' && r.SFCContent) {
    routine.lines = renderSfc(r.SFCContent, rawText);
    routine.rendered = true;
  } else {
    routine.undecoded = `${type} logic is not included in this L5X.`;
  }
  if (r.EncodedData || r.Use === 'Reference') routine.undecoded ??= 'Routine is source-protected.';
  return routine;
}

/** A source-protected routine or AOI: only its name (and AOI signature) is readable. */
function encodedRoutine(e: X): Routine {
  const type = (ROUTINE_TYPES.has(e.Type) ? e.Type : 'Unknown') as RoutineType;
  return { name: e.Name, type, rungs: [], description: textOf(e.Description), undecoded: 'Routine is source-protected.' };
}

const isSafety = (e: X) => e?.Class === 'Safety' || undefined;

/**
 * `<SafetyTagMap> Std1=Safe1, Std2=Safe2` (Logic > Map Safety Tags): each scan the standard
 * tag on the left is copied into the safety tag on the right.
 */
function safetyTagMap(v: X): { standard: string; safety: string }[] {
  const text = rawText(v)?.trim();
  if (!text) return [];
  return text.split(',').map(p => p.split('=').map(s => s.trim())).filter(p => p.length === 2 && p[0] && p[1])
    .map(([standard, safety]) => ({ standard: standard!, safety: safety! }));
}

function modulesFrom(ctl: X): Module[] {
  return ((ctl.Modules?.Module ?? []) as X[]).map((m): Module => {
    const ports = (m.Ports?.Port ?? []) as X[];
    const up = ports.find(p => p.Upstream === 'true');
    return {
      name: m.Name,
      parent: m.ParentModule && m.ParentModule !== m.Name ? m.ParentModule : undefined,
      catalogNumber: m.CatalogNumber,
      // The device's own vendor: for a generic profile that is the user-defined one (as in the ACD).
      vendor: vendorName(m.UserDefinedVendor ?? m.Vendor),
      revision: m.Major !== undefined ? `${m.Major}.${m.Minor ?? 0}` : undefined,
      address: up?.Address,
      description: textOf(m.Description),
      inhibited: m.Inhibited === 'true' || undefined,
      // A CIP Safety device has a non-zero safety network number; controllers have one too.
      safety: (!!m.SafetyNetwork && /[1-9a-f]/i.test(String(m.SafetyNetwork).replace(/^16#/, '')) && m.ProductType !== '14') ||
        m.SafetyEnabled === 'true' || undefined,
    };
  });
}

function tagFrom(t: X): Tag {
  return {
    name: t.Name,
    dataType: t.DataType ?? '',
    dimensions: dimsFrom(t.Dimensions),
    description: textOf(t.Description),
    aliasFor: t.AliasFor,
    usage: t.Usage,
    constant: t.Constant === 'true' || undefined,
    externalAccess: t.ExternalAccess,
    safety: isSafety(t),
    produced: t.TagType === 'Produced' || undefined,
    consumed: t.TagType === 'Consumed' || undefined,
  };
}

function memberFrom(m: X): Member {
  return {
    name: m.Name,
    dataType: m.DataType ?? '',
    dimensions: dimsFrom(m.Dimension ?? m.Dimensions),
    description: textOf(m.Description),
    hidden: m.Hidden === 'true' || undefined,
    bit: m.BitNumber !== undefined ? Number(m.BitNumber) : undefined,
    target: m.Target,
    usage: m.Usage,
    required: m.Required === 'true' || undefined,
    visible: m.Visible === 'true' || undefined,
  };
}

const TASK_TYPES = new Set(['CONTINUOUS', 'PERIODIC', 'EVENT']);

export function parseL5x(filePath: string): Controller {
  let xml = fs.readFileSync(filePath, 'utf8');
  if (xml.charCodeAt(0) === 0xfeff) xml = xml.slice(1);
  return parseL5xString(xml, filePath);
}

export function parseL5xString(xml: string, filePath = '<string>'): Controller {
  const root: X = parser.parse(xml)?.RSLogix5000Content;
  if (!root) throw new Error('Not an L5X file: RSLogix5000Content root element not found.');
  const ctl: X = root.Controller ?? {};
  const c: Controller = emptyController('L5X', filePath);
  c.name = ctl.Name ?? '';
  c.description = textOf(ctl.Description);
  c.processorType = ctl.ProcessorType;
  c.revision = ctl.MajorRev !== undefined ? `${ctl.MajorRev}.${ctl.MinorRev ?? 0}` : undefined;
  c.softwareVersion = root.SoftwareRevision ? productName(String(root.SoftwareRevision)) : undefined;
  if (ctl.Use && ctl.Use !== 'Target') {
    c.warnings.push(`This L5X is a partial export (target: ${root.TargetType ?? '?'} ${root.TargetName ?? ''}); only the exported part is shown.`);
  }

  c.dataTypes = ((ctl.DataTypes?.DataType ?? []) as X[]).map((d): DataType => ({
    name: d.Name,
    description: textOf(d.Description),
    members: ((d.Members?.Member ?? []) as X[]).map(memberFrom),
    kind: d.Class === 'ProductDefined' ? 'builtin' : 'udt',
  }));

  const aoiFrom = (a: X, encoded: boolean): Aoi => ({
    name: a.Name,
    description: textOf(a.Description),
    revision: a.Revision,
    parameters: ((a.Parameters?.Parameter ?? []) as X[]).map(memberFrom),
    localTags: ((a.LocalTags?.LocalTag ?? []) as X[]).map(memberFrom),
    routines: encoded
      ? [{ name: 'Logic', type: 'Unknown', rungs: [], undecoded: 'AOI is source-protected.' }]
      : ((a.Routines?.Routine ?? []) as X[]).map(routineFrom),
    safety: isSafety(a),
    encoded: encoded || undefined,
  });
  const aoiDefs = ctl.AddOnInstructionDefinitions ?? {};
  c.aois = [
    ...((aoiDefs.AddOnInstructionDefinition ?? []) as X[]).map(a => aoiFrom(a, false)),
    ...((aoiDefs.EncodedData ?? []) as X[]).filter(e => e.EncodedType === 'AddOnInstructionDefinition').map(a => aoiFrom(a, true)),
  ];

  c.tags = ((ctl.Tags?.Tag ?? []) as X[]).map(tagFrom);

  c.programs = ((ctl.Programs?.Program ?? []) as X[]).map((p): Program => ({
    name: p.Name,
    description: textOf(p.Description),
    mainRoutine: p.MainRoutineName,
    faultRoutine: p.FaultRoutineName,
    disabled: p.Disabled === 'true' || undefined,
    safety: isSafety(p),
    tags: ((p.Tags?.Tag ?? []) as X[]).map(tagFrom),
    routines: [
      ...((p.Routines?.Routine ?? []) as X[]).map(routineFrom),
      ...((p.Routines?.EncodedData ?? []) as X[]).map(encodedRoutine),
    ],
  }));

  c.tasks = ((ctl.Tasks?.Task ?? []) as X[]).map((t): Task => ({
    name: t.Name,
    type: (TASK_TYPES.has(t.Type) ? t.Type : 'Unknown') as TaskType,
    rateMs: t.Rate !== undefined ? Number(t.Rate) : undefined,
    priority: t.Priority !== undefined ? Number(t.Priority) : undefined,
    watchdogMs: t.Watchdog !== undefined ? Number(t.Watchdog) : undefined,
    description: textOf(t.Description),
    safety: isSafety(t),
    programs: ((t.ScheduledPrograms?.ScheduledProgram ?? []) as X[]).map(s => s.Name),
  }));

  c.modules = modulesFrom(ctl);
  // Program tags carry no Class in an L5X: in a safety program they are implicitly safety
  // (the ACD records the same tags as safety-class).
  for (const p of c.programs) if (p.safety) for (const t of p.tags) t.safety = true;

  const map = safetyTagMap(ctl.SafetyInfo?.SafetyTagMap);
  if (map.length) c.safetyTagMap = map;
  separateUnused(c);
  reportSafetyCoverage(c);
  return c;
}
