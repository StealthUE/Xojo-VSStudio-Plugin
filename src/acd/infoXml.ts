/**
 * infoXml.ts — QuickInfo.XML and TagInfo.XML, the two plain-XML indexes Studio 5000 keeps
 * inside every ACD.
 *
 * QuickInfo: controller name, description, software version, device identity.
 * TagInfo:   every data type with members, controller tags, and per-program tags with
 *            data type, dimensions and description. It is the most reliable source for
 *            tag definitions, so the ACD decoder takes tags and types from here.
 */

import { XMLParser } from 'fast-xml-parser';
import { DataType, Member, Tag } from '../model';

const ARRAYS = new Set(['DataType', 'Member', 'Tag', 'Program', 'Dim']);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  cdataPropName: false,
  trimValues: true,
  parseAttributeValue: false,
  // Only elements: the DataType attribute on Tag/Member must stay a string.
  isArray: (name, _jpath, _leaf, isAttribute) => !isAttribute && ARRAYS.has(name),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type X = any;

function text(node: X): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === 'string') return node.trim() || undefined;
  if (typeof node === 'object' && '#text' in node) return String(node['#text']).trim() || undefined;
  return undefined;
}

function dims(node: X): number[] | undefined {
  const list: X[] = node?.Dimensions?.Dim ?? [];
  const out = list.map(d => Number(d.Size)).filter(n => Number.isFinite(n) && n > 0);
  return out.length ? out : undefined;
}

export interface QuickInfo {
  name: string;
  description?: string;
  softwareVersion?: string;
  revision?: string;
  productCode?: number;
}

export function parseQuickInfo(xml: string): QuickInfo {
  const root: X = parser.parse(xml)?.LogixQuickInfo ?? {};
  const id: X = root.DeviceIdentity ?? {};
  return {
    name: root.Name ?? '',
    description: text(root.Description),
    softwareVersion: root.SWVersion?.String,
    revision: id.MajorRevision !== undefined ? `${id.MajorRevision}.${id.MinorRevision ?? 0}` : undefined,
    productCode: id.ProductCode !== undefined ? Number(id.ProductCode) : undefined,
  };
}

export interface TagInfo {
  description?: string;
  dataTypes: DataType[];
  controllerTags: Tag[];
  programs: Map<string, { description?: string; tags: Tag[] }>;
}

function toTag(t: X): Tag {
  return {
    name: t.Name, dataType: t.DataType ?? '', dimensions: dims(t), description: text(t.Description),
    produced: t.Produced === 'true' || undefined,
  };
}

function toMember(m: X): Member {
  return {
    name: m.Name,
    dataType: m.DataType ?? '',
    dimensions: dims(m),
    description: text(m.Description),
    hidden: m.Hidden === 'true' || undefined,
    bit: m.Bit !== undefined ? Number(m.Bit) : undefined,
  };
}

/** Module-defined types look like `AB:1756_DI:C:0` or `_002B:BNI006A_F26693AA:I:0`. */
function typeKind(name: string): DataType['kind'] {
  return name.includes(':') ? 'module' : 'udt';
}

/**
 * TagInfo lists a packed BOOL as `DataType="BOOL" Offset=o Bit=b`, where b may run past 7
 * (bit 16 = third byte). Studio 5000 defines it as a BIT of a hidden SINT host: the host is
 * the hidden SINT at offset o + b/8, and the bit number is b % 8 (checked against L5X).
 */
function bitMembers(members: X[]): Member[] {
  const hosts = new Map<number, string>();
  for (const m of members) {
    if (m.Hidden === 'true' && m.DataType === 'SINT' && m.Offset !== undefined) hosts.set(Number(m.Offset), m.Name);
  }
  return members.map(m => {
    const out = toMember(m);
    if (out.bit !== undefined && m.Offset !== undefined && (out.dataType === 'BOOL' || out.dataType === 'BIT')) {
      const host = hosts.get(Number(m.Offset) + Math.floor(out.bit / 8));
      if (host) {
        out.dataType = 'BIT';
        out.target = host;
        out.bit %= 8;
      }
    }
    return out;
  });
}

export function parseTagInfo(xml: string): TagInfo {
  const root: X = parser.parse(xml)?.LogixTagInfo ?? {};
  const dataTypes: DataType[] = (root.DataTypes?.DataType ?? []).map((d: X) => ({
    name: d.Name,
    description: text(d.Description),
    members: bitMembers(d.Members?.Member ?? []),
    kind: typeKind(d.Name),
  }));
  const programs = new Map<string, { description?: string; tags: Tag[] }>();
  for (const p of (root.Programs?.Program ?? []) as X[]) {
    programs.set(p.Name, { description: text(p.Description), tags: (p.Tags?.Tag ?? []).map(toTag) });
  }
  return {
    description: text(root.Description),
    dataTypes,
    controllerTags: (root.Tags?.Tag ?? []).map(toTag),
    programs,
  };
}
