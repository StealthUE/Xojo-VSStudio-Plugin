/**
 * modules.ts — The I/O configuration tree (RxMapDeviceCollection in Comps.Dat).
 *
 * Each module is a Comps object of kind 0xA4 whose name may contain `@id@` references (a
 * partner controller is stored as `@<controller id>@:Partner`). Attribute 0x01 holds the
 * identity (verified against L5X <Module> on V31 projects):
 *
 *     2  u16  vendor id              8  u8   major revision (bit 7 = keying flag)
 *     4  u16  product type           9  u8   minor revision
 *     6  u16  product code          20  bit 2 = inhibited
 *    22  u16  parent module's comment id (Comps body u16 @12)
 *    26  u16  port on the parent    28  u16  slot on that port (backplane modules)
 *   305  48-bit safety network number, little-endian (0 when the module has none)
 *
 * The module's description is an ordinary object comment (Comments.Dat).
 *
 * Ethernet devices keep their IP address as ASCII text inside the same block. Catalog
 * numbers are not in the module object; where a module's port XML (a `$id$` data record
 * with `<in><Port … Addr="…"/>`, `<public><CatNum>`) has the module's unique IP address,
 * the catalog number is taken from there.
 */

import { CompsDb, Comp, attributes } from './comps';
import { Module } from '../model';

const KIND_MODULE = 0xa4;

/** CIP device profile (product type) names from the CIP specification. */
const PRODUCT_TYPES: Record<number, string> = {
  0: 'Generic Device', 2: 'AC Drive', 3: 'Motor Overload', 4: 'Limit Switch', 5: 'Inductive Proximity Switch',
  6: 'Photoelectric Sensor', 7: 'General Purpose Discrete I/O', 9: 'Resolver', 10: 'General Purpose Analog I/O',
  12: 'Communications Adapter', 14: 'Programmable Logic Controller', 16: 'Position Controller',
  19: 'DC Drive', 21: 'Contactor', 22: 'Motor Starter', 23: 'Soft Start', 24: 'Human-Machine Interface',
  26: 'Mass Flow Controller', 27: 'Pneumatic Valve', 28: 'Vacuum Pressure Gauge', 29: 'Process Control Value',
  30: 'Residual Gas Analyzer', 31: 'DC Power Generator', 32: 'RF Power Generator', 33: 'Turbomolecular Vacuum Pump',
  34: 'Encoder', 35: 'Safety Discrete I/O Device', 36: 'Fluid Flow Controller', 37: 'CIP Motion Drive',
  38: 'CompoNet Repeater', 39: 'Mass Flow Controller, Enhanced', 40: 'CIP Modbus Device',
  41: 'CIP Modbus Translator', 42: 'Safety Analog I/O Device', 43: 'Generic Device (keyable)',
  44: 'Managed Switch', 50: 'ControlNet Physical Layer Component', 150: 'Safety Drive',
};

/**
 * Catalog numbers by CIP identity (vendor / product type / product code), for modules whose
 * catalog number the ACD does not store (Studio 5000 looks it up in its device catalogue).
 * A product code names exactly one product, so this is a lookup, not a guess. Only entries
 * confirmed against Studio 5000's own L5X export of a project are listed.
 */
const KNOWN_CATALOG: Record<string, string> = {
  '1/14/147': '1756-L72S',
  '1/14/146': '1756-L7SP',
  '1/14/213': '1756-L83ES',
  '1/14/171': '1756-L8SP',
  '1/12/166': '1756-EN2T',
  '1/7/11': '1756-IB16',
  '1/0/18': 'ETHERNET-MODULE',
  '1/0/26': 'ETHERNET-SAFETYMODULE',
  '43/43/20618': 'BNI006A',
  '524/43/1': '501xxxxx',
  '645/12/2267': 'BWU2380 BWU2381 BWU2267 BWU2317 BWU2579 BWU2742 BWU2821 BWU3079',
};

/**
 * Vendor as both decoders report it: Allen-Bradley by name, anyone else by CIP vendor id.
 * For a third-party device configured through a generic profile, this is the device's own
 * (user-defined) vendor, which is what the ACD stores.
 */
export function vendorName(id: number | string | undefined): string | undefined {
  if (id === undefined || id === '') return undefined;
  return Number(id) === 1 ? 'Allen-Bradley' : String(id);
}

export function productTypeName(t: number | undefined): string | undefined {
  return t === undefined ? undefined : PRODUCT_TYPES[t] ?? `product type ${t}`;
}

export interface ModuleIdentity {
  vendor: number;
  productType: number;
  productCode: number;
}

export function decodeModules(
  comps: CompsDb,
  resolveName: (raw: string) => string,
  describe: (module: Comp) => string | undefined,
  warn: (m: string) => void,
): Module[] {
  const coll = comps.findByName('RxMapDeviceCollection');
  if (!coll) return [];
  const mods = comps.childrenOf(coll.id).filter(c => c.kind === KIND_MODULE);
  const byCommentId = new Map<number, Comp>();
  for (const m of mods) if (m.body.length >= 14) byCommentId.set(m.body.readUInt16LE(12), m);
  const records = portRecords(comps);
  const catalogByIp = catalogNumbersByAddress(records);

  const out: Module[] = [];
  const identity = new Map<Module, string>();
  // An address identifies a module only if no other module uses it: one device can be several
  // modules (e.g. a gateway's standard and CIP Safety connections share an IP address).
  const ipOf = (m: Comp) => /(?:\d{1,3}\.){3}\d{1,3}/.exec(attributes(m).get(0x01)?.toString('latin1') ?? '')?.[0];
  const ipCount = new Map<string, number>();
  for (const m of mods) { const ip = ipOf(m); if (ip) ipCount.set(ip, (ipCount.get(ip) ?? 0) + 1); }
  for (const m of mods) {
    const a = attributes(m).get(0x01);
    const name = resolveName(m.name);
    const mod: Module = { name, description: describe(m) };
    if (!a || a.length < 30) {
      warn(`Module ${name}: identity block not found.`);
      out.push(mod);
      continue;
    }
    const vendor = a.readUInt16LE(2);
    const type = a.readUInt16LE(4);
    const code = a.readUInt16LE(6);
    mod.vendor = vendorName(vendor);
    mod.revision = `${a[8]! & 0x7f}.${a[9]}`;
    const parent = byCommentId.get(a.readUInt16LE(22));
    if (parent && parent !== m) mod.parent = resolveName(parent.name);
    const ip = /(?:\d{1,3}\.){3}\d{1,3}/.exec(a.toString('latin1'))?.[0];
    mod.address = ip ?? (mod.parent ? String(a.readUInt16LE(28)) : undefined);
    const cat = ip && ipCount.get(ip) === 1 ? catalogByIp.get(ip) : undefined;
    if (cat) mod.catalogNumber = cat;
    if ((a[20]! & 0x04) !== 0) mod.inhibited = true;
    // Safety network number (48 bits, little-endian @305): set on every CIP Safety device.
    // A non-controller with one is safety I/O (the L5X marks the same modules).
    const snn = a.length >= 311 ? a.subarray(305, 311) : undefined;
    if ((snn && snn.some(x => x !== 0) && type !== 14) || type === 35 || type === 42 || type === 150) mod.safety = true;
    // One device can be both a standard and a CIP Safety module with the same identity: keep
    // them apart when sharing catalog numbers.
    identity.set(mod, `${vendor}/${type}/${code}${mod.safety ? '/safety' : ''}`);
    out.push(mod);
  }

  // Modules of the same product (vendor / type / product code) share a catalog number; only
  // some of them store it. Propagate where every module that stores one agrees.
  const byIdentity = new Map<string, Set<string>>();
  for (const m of out) {
    if (!m.catalogNumber) continue;
    const k = identity.get(m)!;
    const s = byIdentity.get(k) ?? new Set();
    s.add(m.catalogNumber);
    byIdentity.set(k, s);
  }
  for (const m of out) {
    if (m.catalogNumber) continue;
    const known = byIdentity.get(identity.get(m) ?? '');
    if (known?.size === 1) m.catalogNumber = [...known][0];
  }
  // The local controller (and its safety partner) keep their catalog number in a port record
  // with no upstream Ethernet port: the one Logix controller catalog there is this controller.
  const local = records.filter(r => !r.upstreamEn && r.catalog && /^\d{4}-L\d+/i.test(r.catalog));
  const controllers = local.filter(r => !/SP$/i.test(r.catalog!));
  const partners = local.filter(r => /SP$/i.test(r.catalog!));
  const localModule = out.find(m => m.name === 'Local') ?? out.find(m => !m.parent && identity.get(m)?.split('/')[1] === '14');
  if (localModule && !localModule.catalogNumber && controllers.length === 1) localModule.catalogNumber = controllers[0]!.catalog;
  const localPartner = out.find(m => m.parent === localModule?.name && /:Partner$/.test(m.name) && identity.get(m)?.split('/')[1] === '14');
  if (localPartner && !localPartner.catalogNumber && partners.length === 1) localPartner.catalogNumber = partners[0]!.catalog;

  for (const m of out) {
    if (m.catalogNumber) continue;
    const [vendor, type, code] = (identity.get(m) ?? '').split('/').map(Number);
    const known = KNOWN_CATALOG[`${vendor}/${type}/${code}`];
    if (known) m.catalogNumber = known;
    else if (type !== undefined && code !== undefined) m.catalogNumber = `${productTypeName(type)} (code ${code})`;
  }
  return out;
}

/** Catalog number of the local controller, when the ACD stores it (see decodeModules). */
export function controllerCatalog(modules: Module[]): string | undefined {
  const local = modules.find(m => m.name === 'Local');
  return local?.catalogNumber && /^\d{4}-L\d+/i.test(local.catalogNumber) ? local.catalogNumber : undefined;
}

interface PortRecord {
  catalog?: string;
  /** Address of the record's upstream Ethernet port (the device's own IP), if any. */
  upstreamEn?: string;
}

/** The `$id$` data records holding each module's port XML (`<in>…</in><public>…`). */
function portRecords(comps: CompsDb): PortRecord[] {
  const out: PortRecord[] = [];
  for (const c of comps.byId.values()) {
    if (c.name.length !== 10 || c.name[0] !== '$' || c.name[9] !== '$') continue;
    for (const v of attributes(c).values()) {
      const s = v.toString('latin1');
      if (!s.startsWith('<in>')) continue;
      const catalog = /<CatNum>([^<]+)<\/CatNum>/.exec(s)?.[1];
      // The device's own (upstream) Ethernet port: Type="EN" without Ups="False".
      const own = [...s.matchAll(/<Port [^>]*Type="EN"[^>]*>/g)].map(p => p[0]).find(p => !/Ups="False"/.test(p));
      out.push({ catalog, upstreamEn: own ? /Addr="([^"]+)"/.exec(own)?.[1] : undefined });
    }
  }
  return out;
}

/** IP address → catalog number, where exactly one catalog number is recorded for that address. */
function catalogNumbersByAddress(records: PortRecord[]): Map<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const r of records) {
    if (!r.upstreamEn || !r.catalog) continue;
    const s = seen.get(r.upstreamEn) ?? new Set();
    s.add(r.catalog);
    seen.set(r.upstreamEn, s);
  }
  const out = new Map<string, string>();
  for (const [k, v] of seen) if (v.size === 1) out.set(k, [...v][0]!);
  return out;
}
