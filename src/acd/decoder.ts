/**
 * decoder.ts — Turn an .ACD file into the neutral Controller model. Read-only: the ACD is
 * never written.
 *
 * Sources, in order of trust:
 *   TagInfo.XML / QuickInfo.XML  tags, data types, descriptions, controller identity
 *   Comps.Dat                    object tree: tasks, programs, AOIs, routines, name of every id
 *   Comps "Region Map"           which rungs belong to which routine, in order
 *   SbRegion.Dat                 rung neutral text
 *   RegnLink.Dat + Comments.Dat  rung comments, routine and module descriptions
 *   Nameless.Dat                 Structured Text source, AOI parameter order, safety tag map
 *   ProjectTemplate.ACD          the empty template: which data types are predefined
 *
 * Safety information (tasks, programs, AOIs, tags, tag map, safety I/O) is decoded from the
 * file itself, never from names; reportSafetyCoverage notes anything missing.
 */

import * as path from 'path';
import { AcdContainer } from './container';
import {
  CompsDb, Comp, CompKind, attributes, commentMemberKey, commentParentKey,
  regionMap, routineTypeCode, scheduleId,
} from './comps';
import { CommentIndex, commentRecords, regionCommentKeys, resolveRefs, rungTexts } from './logic';
import { parseQuickInfo, parseTagInfo } from './infoXml';
import { refineAoiParameterOrder } from './aoiOrder';
import { StSourceIndex, orderedIdLists, safetyTagMapRefs } from './stSource';
import { controllerCatalog, decodeModules } from './modules';
import { separateUnused } from '../export/unused';
import { reportSafetyCoverage } from '../export/analysis';
import {
  Aoi, Controller, DataType, Member, Program, Routine, RoutineType, Rung, Tag, Task, TaskType, emptyController,
} from '../model';

const ROUTINE_TYPES: Record<number, RoutineType> = { 1: 'RLL', 2: 'FBD', 3: 'SFC', 4: 'ST' };
const TASK_TYPES: Record<number, TaskType> = { 1: 'EVENT', 2: 'PERIODIC', 4: 'CONTINUOUS' };

const BUILTIN_TYPES = new Set([
  'BOOL', 'SINT', 'INT', 'DINT', 'LINT', 'USINT', 'UINT', 'UDINT', 'ULINT', 'REAL', 'LREAL',
  'TIMER', 'COUNTER', 'CONTROL', 'PID', 'MESSAGE', 'MOTION_INSTRUCTION', 'STRING', 'ALARM',
  'ALARM_ANALOG', 'ALARM_DIGITAL', 'AXIS_CONSUMED', 'AXIS_VIRTUAL', 'AXIS_SERVO', 'AXIS_SERVO_DRIVE',
  'AXIS_CIP_DRIVE', 'COORDINATE_SYSTEM', 'MOTION_GROUP', 'SERIAL_PORT_CONTROL', 'CAM', 'CAM_PROFILE',
  'OUTPUT_CAM', 'OUTPUT_COMPENSATION', 'PHASE', 'PHASE_INSTRUCTION', 'SFC_ACTION', 'SFC_STEP',
  'SFC_STOP', 'DATALOG_INSTRUCTION', 'FBD_TIMER', 'FBD_COUNTER', 'FBD_ONESHOT', 'FBD_BOOLEAN_AND',
  'FBD_BOOLEAN_OR', 'FBD_BOOLEAN_XOR', 'FBD_BOOLEAN_NOT', 'FBD_COMPARE', 'FBD_CONVERT', 'FBD_LIMIT',
  'FBD_LOGICAL', 'FBD_MASK_EQUAL', 'FBD_MATH', 'FBD_MATH_ADVANCED', 'FBD_TRUNCATE', 'FBD_BIT_FIELD_DISTRIBUTE',
  'ENERGY_BASE', 'ENERGY_ELECTRICAL', 'HMIBC', 'CONNECTION_STATUS',
]);

export interface DecodeStats {
  comps: number;
  regions: number;
  rungs: number;
  stLines: number;
  unresolvedRefs: number;
  rungComments: number;
}

export interface DecodeResult {
  controller: Controller;
  stats: DecodeStats;
}

export function decodeAcd(filePath: string): DecodeResult {
  return decodeContainer(AcdContainer.open(filePath));
}

export function decodeContainer(acd: AcdContainer): DecodeResult {
  const c = emptyController('ACD', acd.filePath);
  const warn = (m: string) => c.warnings.push(m);
  c.saveLog = acd.saveLog();

  // --- Identity, tags and types from the XML indexes ---------------------------------
  const quick = acd.has('QuickInfo.XML') ? parseQuickInfo(acd.readXml('QuickInfo.XML')) : undefined;
  c.name = quick?.name || path.basename(acd.filePath, path.extname(acd.filePath));
  c.description = quick?.description;
  c.softwareVersion = quick?.softwareVersion;
  c.revision = quick?.revision;
  const tagInfo = acd.has('TagInfo.XML') ? parseTagInfo(acd.readXml('TagInfo.XML')) : undefined;
  if (!tagInfo) warn('TagInfo.XML is missing: tag and data type definitions are unavailable.');
  c.tags = tagInfo?.controllerTags ?? [];

  // --- Object tree ---------------------------------------------------------------------
  const comps = new CompsDb(acd.read('Comps.Dat'));
  const nameOf = (id: number) => comps.get(id)?.name;
  const texts = rungTexts(acd.read('SbRegion.Dat'));
  const commentKeys = acd.has('RegnLink.Dat') ? regionCommentKeys(acd.read('RegnLink.Dat')) : new Map<number, number>();
  const comments = new CommentIndex(acd.has('Comments.Dat') ? commentRecords(acd.read('Comments.Dat')) : []);
  let stSource: StSourceIndex | undefined;
  try {
    if (acd.has('Nameless.Dat')) stSource = new StSourceIndex(acd.read('Nameless.Dat'));
  } catch (e) {
    warn(`Nameless.Dat could not be read, so ST source is unavailable: ${(e as Error).message}`);
  }

  const regionsByOwner = new Map<number, { order: number; regionId: number }[]>();
  const entries = regionMap(comps);
  for (const e of entries) {
    const list = regionsByOwner.get(e.ownerId);
    if (list) list.push(e); else regionsByOwner.set(e.ownerId, [e]);
  }
  if (!entries.length) warn('Region Map not found: rung order could not be recovered.');

  const stats: DecodeStats = {
    comps: comps.byId.size, regions: entries.length, rungs: 0, stLines: 0, unresolvedRefs: 0, rungComments: 0,
  };
  const unresolved = { count: 0 };

  const buildRoutine = (r: Comp): Routine => {
    const type = ROUTINE_TYPES[routineTypeCode(r)] ?? 'Unknown';
    const pKey = commentParentKey(r);
    const mKey = commentMemberKey(r);
    const routine: Routine = { name: r.name, type, rungs: [], description: comments.description(pKey, mKey) };
    const regions = (regionsByOwner.get(r.id) ?? []).slice().sort((a, b) => a.order - b.order);
    if (type === 'RLL' || (type === 'Unknown' && regions.length)) {
      let n = 0;
      for (const reg of regions) {
        const raw = texts.get(reg.regionId);
        const rung: Rung = {
          number: n++,
          text: raw === undefined ? '' : resolveRefs(raw, nameOf, unresolved),
        };
        if (raw === undefined) warn(`${r.name}: rung ${rung.number} has no stored text (region ${hex(reg.regionId)}).`);
        const key = commentKeys.get(reg.regionId);
        if (key !== undefined) {
          const cmt = comments.rungComment(pKey, mKey, key);
          if (cmt) { rung.comment = cmt; stats.rungComments++; }
        }
        routine.rungs.push(rung);
      }
      stats.rungs += routine.rungs.length;
      if (type === 'Unknown') routine.type = 'RLL';
    } else if (type === 'ST') {
      const src = stSource?.routine(r.id);
      if (src) {
        routine.lines = src.original.lines.map(l => resolveRefs(l, nameOf, unresolved));
        stats.stLines += routine.lines.length;
        if (src.original.missing) warn(`${r.name}: ${src.original.missing} ST line(s) listed but not stored; left blank.`);
        if (src.hasPendingEdits) warn(`${r.name}: has pending or test ST edits in Studio 5000; the original (accepted) code is shown.`);
      } else {
        routine.undecoded =
          'ST source text for this routine was not found in the ACD. ' +
          'Export the program to .L5X from Studio 5000 and open that to read it.';
      }
    } else {
      routine.undecoded =
        `${type} logic is stored in the ACD only in compiled form. ` +
        'Export the program to .L5X from Studio 5000 and open that to read it.';
    }
    return routine;
  };

  const routinesOf = (owner: Comp): Routine[] => {
    const coll = comps.collection(owner.id, 'RxRoutineCollection');
    return coll ? comps.childrenOf(coll.id).filter(x => x.kind === CompKind.Routine).map(buildRoutine) : [];
  };

  // --- Programs ------------------------------------------------------------------------
  const programColl = comps.findByName('RxProgramCollection');
  const programComps = programColl
    ? comps.childrenOf(programColl.id).filter(x => x.kind === CompKind.ProgramOrAoi)
    : [];
  if (!programColl) warn('RxProgramCollection not found: no programs decoded.');
  const programBySchedule = new Map<number, string>();
  for (const pc of programComps) {
    const attrs = attributes(pc);
    const refName = (attr: number) => {
      const v = attrs.get(attr);
      return v && v.length >= 4 ? nameOf(v.readUInt32LE(0)) : undefined;
    };
    const info = tagInfo?.programs.get(pc.name);
    const prog: Program = {
      name: pc.name,
      description: info?.description,
      mainRoutine: refName(0x12d),
      faultRoutine: refName(0x66),
      tags: info?.tags ?? [],
      routines: routinesOf(pc),
    };
    const flags = attrs.get(0x01);
    if (flags && flags.length >= 0x28) prog.disabled = flags.readUInt32LE(0x24) !== 0 || undefined;
    // Safety class: attribute 0x01 byte 139 = 6 (checked against L5X Class="Safety").
    if (flags && flags.length > 139 && flags[139] === SAFETY_CLASS) prog.safety = true;
    applyTagFlags(comps, comps.collection(pc.id, 'RxTagCollection'), prog.tags);
    c.programs.push(prog);
    programBySchedule.set(scheduleId(pc), pc.name);
  }

  // --- Tasks ---------------------------------------------------------------------------
  const taskColl = comps.findByName('RxTaskCollection');
  for (const tc of taskColl ? comps.childrenOf(taskColl.id).filter(x => x.kind === CompKind.Task) : []) {
    c.tasks.push(decodeTask(tc, programBySchedule, warn));
  }

  // --- Add-On Instructions -------------------------------------------------------------
  const typesByName = new Map((tagInfo?.dataTypes ?? []).map(d => [d.name, d]));
  const aoiColl = comps.findByName('RxUDIDefinitionCollection');
  const aoiNames = new Set<string>();
  const creationIndex = new Map<string, Map<string, number>>();
  const layoutOrder = new Map<string, string[]>();
  const exactOrder = new Set<string>();
  let idLists: number[][] = [];
  try {
    if (acd.has('Nameless.Dat')) idLists = orderedIdLists(acd.read('Nameless.Dat'));
  } catch { /* reported with the ST source above */ }
  for (const ac of aoiColl ? comps.childrenOf(aoiColl.id).filter(x => x.kind === CompKind.ProgramOrAoi) : []) {
    const def = typesByName.get(ac.name);
    const decl = aoiTags(comps, ac, def?.members ?? [], idLists, comments);
    // Stored definition order is exact; otherwise infer it from call sites (aoiOrder.ts).
    if (decl) creationIndex.set(ac.name, decl.creation);
    if (decl?.ordered) exactOrder.add(ac.name);
    layoutOrder.set(ac.name, (def?.members ?? []).map(m => m.name));
    const aoiFlags = attributes(ac).get(0x01);
    const aoi: Aoi = {
      name: ac.name,
      description: comments.description(commentParentKey(ac), 0) ?? def?.description,
      // Attribute 0x01: u16 major @26, u16 minor @28; byte 134 = 6 for a safety-class AOI.
      revision: aoiFlags && aoiFlags.length >= 30 ? `${aoiFlags.readUInt16LE(26)}.${aoiFlags.readUInt16LE(28)}` : undefined,
      parameters: decl?.parameters ?? (def?.members ?? []).filter(m => !m.hidden),
      localTags: decl?.localTags ?? [],
      routines: routinesOf(ac),
      safety: (aoiFlags && aoiFlags.length > 134 && aoiFlags[134] === SAFETY_CLASS) || undefined,
    };
    // Empty stub definitions have no children at all; only warn when there is logic to analyse.
    if (!decl && aoi.routines.length) warn(`AOI ${ac.name}: parameter declarations not found; usage (Input/Output/InOut) unknown.`);
    aoiNames.add(ac.name);
    c.aois.push(aoi);
  }
  // Call operands follow parameter order; recover it (see aoiOrder.ts).
  refineAoiParameterOrder(c, creationIndex, layoutOrder, exactOrder);

  // --- Controller tags: class and access flags; module connection tags apart -------------
  const controllerComp = [...comps.byId.values()].find(x => x.parentId === 0 && x.name === c.name)
    ?? comps.get(programColl?.parentId ?? -1);
  const ctlTagColl = controllerComp ? comps.collection(controllerComp.id, 'RxTagCollection') : undefined;
  applyTagFlags(comps, ctlTagColl, c.tags);
  c.moduleTags = c.tags.filter(t => t.name.includes(':'));
  c.tags = c.tags.filter(t => !t.name.includes(':'));

  // --- I/O configuration ---------------------------------------------------------------
  try {
    c.modules = decodeModules(comps, raw => resolveRefs(raw, nameOf, unresolved),
      m => comments.description(commentParentKey(m), 0), warn);
    c.processorType = controllerCatalog(c.modules);
    // Safety I/O: a module with a safety connection (Module:SI / Module:SO).
    const safetyConn = new Set(c.moduleTags.filter(t => /:S[IO]$/i.test(t.name)).map(t => t.name.replace(/:S[IO]$/i, '').toLowerCase()));
    for (const m of c.modules) if (safetyConn.has(m.name.toLowerCase())) m.safety = true;
    // The controller's own safety partner has no module record, only its __Map tag.
    const partner = `${c.name}:Partner`;
    const partnerTag = [...comps.byId.values()].some(x => x.kind === CompKind.Tag && x.name === `__Map:${partner}`);
    if (partnerTag && !c.modules.some(m => m.name === partner)) {
      c.modules.push({ name: partner, parent: 'Local', description: 'Safety partner of this controller (from its connection tag; the ACD keeps no module record for it)' });
    }
  } catch (e) {
    warn(`I/O configuration could not be decoded: ${(e as Error).message}`);
  }

  // --- Safety tag map -----------------------------------------------------------------
  try {
    if (acd.has('Nameless.Dat')) {
      const map = safetyTagMapRefs(acd.read('Nameless.Dat'))
        .map(m => ({ standard: resolveRefs(m.standard, nameOf, unresolved), safety: resolveRefs(m.safety, nameOf, unresolved) }));
      if (map.length) c.safetyTagMap = map;
    }
  } catch (e) {
    warn(`Safety tag map could not be read: ${(e as Error).message}`);
  }

  // --- Data types (UDTs, module types, predefined), AOIs listed separately --------------
  // Predefined types are the ones the empty project template embedded in every ACD also has.
  let predefined = new Set<string>();
  try {
    if (acd.has('ProjectTemplate.ACD')) {
      const tpl = new CompsDb(AcdContainer.fromBuffer(acd.read('ProjectTemplate.ACD'), 'template').read('Comps.Dat'));
      const tc = tpl.findByName('RxDataTypeCollection');
      if (tc) predefined = new Set(tpl.childrenOf(tc.id).map(x => x.name));
    }
  } catch {
    warn('Embedded project template could not be read: predefined data types are listed as user-defined.');
  }
  c.dataTypes = (tagInfo?.dataTypes ?? [])
    .filter(d => !aoiNames.has(d.name))
    .map((d): DataType => ({
      ...d,
      kind: d.kind === 'module' ? 'module' : BUILTIN_TYPES.has(d.name) || predefined.has(d.name) ? 'builtin' : 'udt',
    }));

  // Match Studio 5000's order (its L5X export): by name, character by character, ignoring
  // case, so `MainRoutine` comes before `_010_…` (a locale sort would put `_` first).
  const byName = (a: { name: string }, b: { name: string }) => {
    const x = a.name.toUpperCase();
    const y = b.name.toUpperCase();
    return x < y ? -1 : x > y ? 1 : 0;
  };
  c.programs.sort(byName);
  for (const p of c.programs) p.routines.sort(byName);
  c.aois.sort(byName);
  for (const a of c.aois) a.routines.sort(byName);

  // Programs scheduled in the safety task are safety programs. (Their tags carry their own
  // class bit; the analysis treats the whole safety program as safety scope anyway.)
  const safetyProgs = new Set(c.tasks.filter(t => t.safety).flatMap(t => t.programs));
  for (const p of c.programs) if (safetyProgs.has(p.name)) p.safety = true;

  separateUnused(c);
  reportSafetyCoverage(c);
  stats.unresolvedRefs = unresolved.count;
  if (unresolved.count) warn(`${unresolved.count} object references in rung text could not be resolved and were left as @id@.`);
  return { controller: c, stats };
}

/**
 * AOI parameters and local tags from the AOI's RxTagCollection. Body u32 @42 is the data
 * type's object id, u32 @26/@30/@34 the array dimensions. Flags byte at attribute 0x01 offset 526:
 *   0x04 input · 0x08 output (both = InOut) · 0x10 local tag · 0x20 required · 0x40 visible
 * The required parameters are exactly the operands after the instance in a call,
 * AOI_Name(Instance, req1, req2, ...). Definition order is stored in Nameless.Dat as an
 * ordered list of the parameter tags' object ids (see orderedIdLists); `ordered` is set when
 * it was found. Otherwise `creation` (main-record index, body u16 @16) is the starting point
 * for refineAoiParameterOrder.
 */
function aoiTags(comps: CompsDb, aoi: Comp, members: Member[], idLists: number[][], comments: CommentIndex):
  { parameters: Member[]; localTags: Member[]; creation: Map<string, number>; ordered: boolean } | undefined {
  const coll = comps.collection(aoi.id, 'RxTagCollection');
  if (!coll) return undefined;
  const byName = new Map(members.map(m => [m.name.toLowerCase(), m]));
  const decls = comps.childrenOf(coll.id)
    .filter(t => t.kind === CompKind.Tag && !t.name.startsWith('$') && t.body.length >= 18)
    .map(t => ({ t, index: t.body.readUInt16LE(16), flags: attributes(t).get(0x01)?.[526] }))
    .filter(d => d.flags !== undefined)
    .sort((a, b) => a.index - b.index);
  if (!decls.length) return undefined;
  const parameters: Member[] = [];
  const localTags: Member[] = [];
  const creation = new Map<string, number>();
  const idOf = new Map<string, number>();
  for (const { t, flags, index } of decls) {
    idOf.set(t.name, t.id);
    creation.set(t.name, index);
    const f = flags!;
    const m = byName.get(t.name.toLowerCase());
    // InOut parameters are references, absent from the AOI's data type layout: their type
    // comes from the tag record itself (body u32 @42 = data type object id).
    const typeId = t.body.length >= 46 ? t.body.readUInt32LE(42) : 0;
    const typeName = comps.get(typeId)?.name;
    const out: Member = {
      name: t.name, dataType: m?.dataType || typeName || '',
      dimensions: m?.dimensions ?? tagDimensions(t),
      // InOut parameters are not in the AOI type layout: their description is the tag's own comment.
      description: m?.description ?? comments.description(commentParentKey(t), commentMemberKey(t)),
    };
    if (f & 0x10) { localTags.push(out); continue; }
    out.usage = (f & 0x0c) === 0x0c ? 'InOut' : f & 0x08 ? 'Output' : 'Input';
    out.required = (f & 0x20) !== 0 || undefined;
    out.visible = (f & 0x40) !== 0 || undefined;
    parameters.push(out);
  }
  // The stored order lists: one naming exactly these parameters, one these local tags.
  const orderBy = (list: Member[]): boolean => {
    const ids = new Set(list.map(m => idOf.get(m.name)));
    const stored = idLists.find(l => l.length === list.length && l.every(id => ids.has(id)));
    if (!stored || !list.length) return false;
    const pos = new Map(stored.map((id, i) => [id, i]));
    list.sort((a, b) => pos.get(idOf.get(a.name)!)! - pos.get(idOf.get(b.name)!)!);
    return true;
  };
  const ordered = orderBy(parameters);
  orderBy(localTags);
  return { parameters, localTags, creation, ordered };
}

function decodeTask(tc: Comp, programBySchedule: Map<number, string>, warn: (m: string) => void): Task {
  const task: Task = { name: tc.name, type: 'Unknown', programs: [] };
  const cfg = attributes(tc).get(0x01);
  if (!cfg || cfg.length < 2) {
    warn(`Task ${tc.name}: configuration block not found.`);
    return task;
  }
  const count = cfg.readUInt16LE(0);
  for (let i = 0; i < count && 2 + i * 4 + 4 <= cfg.length; i++) {
    const id = cfg.readUInt32LE(2 + i * 4) & 0xffff;
    const name = programBySchedule.get(id);
    if (name) task.programs.push(name);
    else warn(`Task ${tc.name}: scheduled program #${i} (id ${hex(id)}) not found.`);
  }
  // Timing fields move between versions. Known layouts, validated by the task type value.
  const layouts = [
    { rate: 4114, type: 4252, prio: 4254, wd: 4272 },   // V31 (4372-byte block)
    { rate: 514, type: 652, prio: 654, wd: 802 },       // layout used by acd-tools' samples
  ];
  for (const L of layouts) {
    if (cfg.length < L.wd + 4) continue;
    const t = TASK_TYPES[cfg.readUInt16LE(L.type)];
    if (!t) continue;
    task.type = t;
    task.priority = cfg.readUInt16LE(L.prio);
    task.watchdogMs = Math.round(cfg.readUInt32LE(L.wd) / 1000);
    if (t === 'PERIODIC') task.rateMs = cfg.readUInt32LE(L.rate) / 1000;
    break;
  }
  if (task.type === 'Unknown') warn(`Task ${tc.name}: type/rate/priority layout not recognised for this version.`);
  // GuardLogix safety task. The byte at 4316 of the V31 block was 6 for the safety task and 0
  // for every standard task in the projects checked; the name is the fallback.
  if ((cfg.length > 4316 && cfg[4316] === 6) || /safety/i.test(tc.name)) task.safety = true;
  return task;
}

/**
 * Array dimensions of a tag record: body u32 @26, @30, @34 (0 = no such dimension). Checked
 * against L5X on every AOI parameter and local tag, including InOut arrays, which are
 * references and so are absent from the AOI's TagInfo layout.
 */
function tagDimensions(t: Comp): number[] | undefined {
  if (t.body.length < 38) return undefined;
  const dims = [t.body.readUInt32LE(26), t.body.readUInt32LE(30), t.body.readUInt32LE(34)];
  const n = dims.indexOf(0);
  const used = n < 0 ? dims : dims.slice(0, n);
  return used.length ? used : undefined;
}

/** Class byte value marking a GuardLogix safety object (program, AOI). */
const SAFETY_CLASS = 6;

/**
 * Tag class and access flags from the tag records of an RxTagCollection (attribute 0x01),
 * checked against L5X on every controller tag of a V31 project:
 *   byte 589 bit 0  safety class          byte 543 bit 0  constant
 *   byte 542 & 3    external access: 0 Read/Write, 2 Read Only (other values left unset)
 * Produced comes from TagInfo.XML; a consumed tag has attribute 0x6B and is not produced.
 */
function applyTagFlags(comps: CompsDb, coll: Comp | undefined, tags: Tag[]): void {
  if (!coll || !tags.length) return;
  const records = new Map(comps.childrenOf(coll.id).filter(t => t.kind === CompKind.Tag).map(t => [t.name.toLowerCase(), t]));
  for (const tag of tags) {
    const rec = records.get(tag.name.toLowerCase());
    if (!rec) continue;
    const attrs = attributes(rec);
    const a = attrs.get(0x01);
    if (a && a.length > 589) {
      if (a[589]! & 1) tag.safety = true;
      if (a[543]! & 1) tag.constant = true;
      const access = a[542]! & 3;
      tag.externalAccess = access === 0 ? 'Read/Write' : access === 2 ? 'Read Only' : undefined;
    }
    // Attribute 0x6B is the connection block of both produced and consumed tags.
    if (attrs.has(0x6b) && !tag.produced) tag.consumed = true;
  }
}

function hex(n: number): string {
  return n.toString(16).padStart(8, '0');
}
