/**
 * model.ts — Format-neutral model of a Logix 5000 controller project.
 *
 * Both decoders (.ACD and .L5X) produce this, and everything downstream (export, docs,
 * cross reference, tree view, L5X writer) consumes only this. Nothing in here knows which
 * file format it came from except `source`.
 */

export type RoutineType = 'RLL' | 'ST' | 'FBD' | 'SFC' | 'Unknown';
export type TaskType = 'CONTINUOUS' | 'PERIODIC' | 'EVENT' | 'Unknown';

export interface Rung {
  /** 0-based position in the routine, as Studio 5000 numbers it. */
  number: number;
  /** Neutral text with every reference resolved to a name, e.g. `XIC(Start)OTE(Motor);` */
  text: string;
  comment?: string;
}

export interface Routine {
  name: string;
  type: RoutineType;
  description?: string;
  /** RLL only. */
  rungs: Rung[];
  /**
   * ST: one entry per source line. FBD/SFC (from L5X): a generated, read-only text view in
   * ST syntax (see l5x/graphical.ts), with `rendered` set.
   */
  lines?: string[];
  /** `lines` is a generated view of graphical logic, not source that can be edited back. */
  rendered?: boolean;
  /** Set when the logic could not be decoded, explaining why. */
  undecoded?: string;
}

export interface Member {
  name: string;
  dataType: string;
  dimensions?: number[];
  description?: string;
  hidden?: boolean;
  /**
   * BIT members of a UDT (dataType `BIT`): the bit number within `target`, the hidden SINT
   * host member that holds it, exactly as Studio 5000 defines them.
   */
  bit?: number;
  target?: string;
  /** AOI parameters only: Input / Output / InOut. */
  usage?: string;
  required?: boolean;
  visible?: boolean;
}

export interface Tag {
  name: string;
  dataType: string;
  dimensions?: number[];
  description?: string;
  aliasFor?: string;
  /** Program-scoped tags: Input / Output / Public / Local when the source says. */
  usage?: string;
  constant?: boolean;
  externalAccess?: string;
  /** Safety-class tag (GuardLogix). */
  safety?: boolean;
  /** Produced / consumed tag. */
  produced?: boolean;
  consumed?: boolean;
}

export interface DataType {
  name: string;
  description?: string;
  members: Member[];
  /**
   * `udt` user-defined, `module` I/O module types (Vendor:Module:...), `builtin` atomic and
   * Rockwell predefined types (TIMER, AXIS_*, CB_*, ...).
   */
  kind: 'udt' | 'module' | 'builtin';
}

export interface Aoi {
  name: string;
  description?: string;
  revision?: string;
  parameters: Member[];
  localTags: Member[];
  routines: Routine[];
  /** Safety-class AOI (GuardLogix). */
  safety?: boolean;
  /** Source-protected: parameters known, logic not readable. */
  encoded?: boolean;
}

export interface Program {
  name: string;
  description?: string;
  mainRoutine?: string;
  faultRoutine?: string;
  disabled?: boolean;
  /** Safety program (GuardLogix). */
  safety?: boolean;
  tags: Tag[];
  routines: Routine[];
}

export interface Task {
  name: string;
  type: TaskType;
  /** Milliseconds, for PERIODIC tasks. */
  rateMs?: number;
  priority?: number;
  watchdogMs?: number;
  description?: string;
  /** The GuardLogix safety task. */
  safety?: boolean;
  programs: string[];
}

export interface Module {
  name: string;
  /** Parent module name; undefined for the local controller. */
  parent?: string;
  catalogNumber?: string;
  vendor?: string;
  /** Firmware revision, e.g. "2.11". */
  revision?: string;
  /** Slot or network address on the parent's port, when known. */
  address?: string;
  description?: string;
  inhibited?: boolean;
  /** Safety I/O module. */
  safety?: boolean;
}

export interface Controller {
  name: string;
  description?: string;
  processorType?: string;
  softwareVersion?: string;
  /** e.g. "31.11" */
  revision?: string;
  source: 'ACD' | 'L5X';
  sourcePath: string;
  /** Save history from the ACD text header, newest last. */
  saveLog?: string[];
  tasks: Task[];
  programs: Program[];
  aois: Aoi[];
  dataTypes: DataType[];
  tags: Tag[];
  /** I/O configuration, in configuration order. */
  modules: Module[];
  /** Safety tag mapping (GuardLogix): each scan `standard` is copied into `safety`. */
  safetyTagMap?: { standard: string; safety: string }[];
  /**
   * Module-defined connection tags (`Module:I`, `Module:O`, `Module:C`, `Module:SI`...). They
   * exist in the controller but are not user tags, so they are kept apart from `tags`.
   */
  moduleTags?: Tag[];
  /**
   * Definitions nothing in the project uses: AOIs with no parameters, no logic and no calls
   * (typically deleted or stale records), and predefined or module types no tag, member or
   * parameter refers to. Kept out of the main lists and counts; listed in UNUSED.md.
   */
  unused?: { aois: Aoi[]; dataTypes: DataType[] };
  /** Everything the decoder had to guess at or skip. Never fatal. */
  warnings: string[];
}

export function emptyController(source: 'ACD' | 'L5X', sourcePath: string): Controller {
  return {
    name: '', source, sourcePath,
    tasks: [], programs: [], aois: [], dataTypes: [], tags: [], modules: [], warnings: []
  };
}
