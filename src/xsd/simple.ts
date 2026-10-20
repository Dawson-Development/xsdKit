import { compileXsdPattern } from './regex.js';
import { encodeBinary } from '#platform';
import { Facets, SimpleType, WhiteSpace, XS_NS, typeName } from './model.js';

const PRIMITIVES = new Set([
  'string', 'boolean', 'decimal', 'float', 'double', 'duration', 'dateTime', 'time', 'date', 'gYearMonth',
  'gYear', 'gMonthDay', 'gDay', 'gMonth', 'hexBinary', 'base64Binary', 'anyURI', 'QName', 'NOTATION',
]);

const TZ = '(?<tz>Z|[+-](?:(?:0\\d|1[0-3]):[0-5]\\d|14:00))?';
const YEAR = '(?<y>-?(?:[1-9]\\d{4,}|\\d{4}))';
const MONTH = '(?<m>0[1-9]|1[0-2])';
const DAY = '(?<d>0[1-9]|[12]\\d|3[01])';
const TIME = '(?<time>(?<h>[01]\\d|2[0-3]):(?<mi>[0-5]\\d):(?<s>[0-5]\\d(?:\\.\\d+)?)|24:00:00(?:\\.0+)?)';

const DATE_RES: Record<string, RegExp> = {
  dateTime: new RegExp(`^${YEAR}-${MONTH}-${DAY}T${TIME}${TZ}$`),
  date: new RegExp(`^${YEAR}-${MONTH}-${DAY}${TZ}$`),
  time: new RegExp(`^${TIME}${TZ}$`),
  gYearMonth: new RegExp(`^${YEAR}-${MONTH}${TZ}$`),
  gYear: new RegExp(`^${YEAR}${TZ}$`),
  gMonthDay: new RegExp(`^--${MONTH}-${DAY}${TZ}$`),
  gDay: new RegExp(`^---${DAY}${TZ}$`),
  gMonth: new RegExp(`^--${MONTH}${TZ}$`),
};

const DECIMAL_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const INTEGER_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^(?:[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[+-]?INF|NaN)$/;
const DURATION_RE = /^-?P(?=\d|T\d)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?=\d)(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;
const NCNAME_RE = /^[\p{L}_][\p{L}\p{N}\p{M}_.\-\u00B7]*$/u;
const NAME_RE = /^[\p{L}_:][\p{L}\p{N}\p{M}_:.\-\u00B7]*$/u;
const NMTOKEN_RE = /^[\p{L}\p{N}\p{M}_:.\-\u00B7]+$/u;
const LANGUAGE_RE = /^[a-zA-Z]{1,8}(?:-[a-zA-Z0-9]{1,8})*$/;
const HEX_RE = /^(?:[0-9a-fA-F]{2})*$/;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function daysInMonth(y: number, m: number): number {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function dateLexical(kind: string) {
  const re = DATE_RES[kind];
  return (v: string): string | null => {
    const m = re.exec(v);
    if (!m) return 'invalid lexical form';
    const g = m.groups!;
    if (g.d && g.m) {
      const year = g.y ? Number(g.y) : 2000;
      if (Number(g.d) > daysInMonth(year, Number(g.m))) return 'day is out of range for month';
    }
    return null;
  };
}

const reCheck = (re: RegExp) => (v: string) => (re.test(v) ? null : 'invalid lexical form');

const builtins = new Map<string, SimpleType>();

function def(
  name: string,
  base: string | undefined,
  facets: Facets = {},
  lexical?: (v: string) => string | null,
  itemType?: string,
): void {
  builtins.set(name, {
    kind: 'simple',
    name: { ns: XS_NS, local: name },
    builtin: name,
    base: base ? builtins.get(base) : undefined,
    itemType: itemType ? builtins.get(itemType) : undefined,
    facets,
    lexical,
  });
}

def('anySimpleType', undefined);
def('anyAtomicType', 'anySimpleType');
def('string', 'anySimpleType', { whiteSpace: 'preserve' });
def('normalizedString', 'string', { whiteSpace: 'replace' });
def('token', 'normalizedString', { whiteSpace: 'collapse' });
def('language', 'token', {}, reCheck(LANGUAGE_RE));
def('NMTOKEN', 'token', {}, reCheck(NMTOKEN_RE));
def('Name', 'token', {}, reCheck(NAME_RE));
def('NCName', 'Name', {}, reCheck(NCNAME_RE));
def('ID', 'NCName');
def('IDREF', 'NCName');
def('ENTITY', 'NCName');
def('NMTOKENS', undefined, { minLength: 1 }, undefined, 'NMTOKEN');
def('IDREFS', undefined, { minLength: 1 }, undefined, 'IDREF');
def('ENTITIES', undefined, { minLength: 1 }, undefined, 'ENTITY');
def('boolean', 'anySimpleType', { whiteSpace: 'collapse' }, reCheck(/^(?:true|false|1|0)$/));
def('decimal', 'anySimpleType', { whiteSpace: 'collapse' }, reCheck(DECIMAL_RE));
def('integer', 'decimal', {}, reCheck(INTEGER_RE));
def('nonPositiveInteger', 'integer', { maxInclusive: '0' });
def('negativeInteger', 'nonPositiveInteger', { maxInclusive: '-1' });
def('long', 'integer', { minInclusive: '-9223372036854775808', maxInclusive: '9223372036854775807' });
def('int', 'long', { minInclusive: '-2147483648', maxInclusive: '2147483647' });
def('short', 'int', { minInclusive: '-32768', maxInclusive: '32767' });
def('byte', 'short', { minInclusive: '-128', maxInclusive: '127' });
def('nonNegativeInteger', 'integer', { minInclusive: '0' });
def('unsignedLong', 'nonNegativeInteger', { maxInclusive: '18446744073709551615' });
def('unsignedInt', 'unsignedLong', { maxInclusive: '4294967295' });
def('unsignedShort', 'unsignedInt', { maxInclusive: '65535' });
def('unsignedByte', 'unsignedShort', { maxInclusive: '255' });
def('positiveInteger', 'nonNegativeInteger', { minInclusive: '1' });
def('float', 'anySimpleType', { whiteSpace: 'collapse' }, reCheck(FLOAT_RE));
def('double', 'anySimpleType', { whiteSpace: 'collapse' }, reCheck(FLOAT_RE));
def('duration', 'anySimpleType', { whiteSpace: 'collapse' }, reCheck(DURATION_RE));
def('dayTimeDuration', 'duration', {}, reCheck(/^[^YM]*(?:T.*)?$/));
def('yearMonthDuration', 'duration', {}, reCheck(/^[^DT]*$/));
for (const k of Object.keys(DATE_RES)) def(k, 'anySimpleType', { whiteSpace: 'collapse' }, dateLexical(k));
def('dateTimeStamp', 'dateTime', {}, (v) => (/(?:Z|[+-]\d\d:\d\d)$/.test(v) ? null : 'a timezone is required'));
def('hexBinary', 'anySimpleType', { whiteSpace: 'collapse' }, reCheck(HEX_RE));
def('base64Binary', 'anySimpleType', { whiteSpace: 'collapse' }, (v) =>
  BASE64_RE.test(v.replace(/ /g, '')) ? null : 'invalid lexical form',
);
def('anyURI', 'anySimpleType', { whiteSpace: 'collapse' });
def('QName', 'anySimpleType', { whiteSpace: 'collapse' }, (v) => {
  const [a, b] = v.includes(':') ? v.split(':', 2) : [undefined, v];
  return (a === undefined || NCNAME_RE.test(a)) && NCNAME_RE.test(b) && v.split(':').length <= 2 ? null : 'invalid lexical form';
});
def('NOTATION', 'anySimpleType', { whiteSpace: 'collapse' }, reCheck(/^(?:[^:\s]+:)?[^:\s]+$/));

export function getBuiltinSimpleType(local: string): SimpleType | undefined {
  return builtins.get(local);
}

export function primitiveOf(t: SimpleType): string | undefined {
  for (let cur: SimpleType | undefined = t; cur; cur = cur.base) {
    if (cur.itemType || cur.memberTypes) return undefined;
    if (cur.builtin && PRIMITIVES.has(cur.builtin)) return cur.builtin;
  }
  return 'anySimpleType';
}

export function varietyOf(t: SimpleType): 'atomic' | 'list' | 'union' {
  for (let cur: SimpleType | undefined = t; cur; cur = cur.base) {
    if (cur.itemType) return 'list';
    if (cur.memberTypes) return 'union';
  }
  return 'atomic';
}

export function listItemType(t: SimpleType): SimpleType | undefined {
  for (let cur: SimpleType | undefined = t; cur; cur = cur.base) if (cur.itemType) return cur.itemType;
  return undefined;
}

export function unionMembers(t: SimpleType): SimpleType[] | undefined {
  for (let cur: SimpleType | undefined = t; cur; cur = cur.base) if (cur.memberTypes) return cur.memberTypes;
  return undefined;
}

export function derivesFromBuiltin(t: SimpleType, name: string): boolean {
  for (let cur: SimpleType | undefined = t; cur; cur = cur.base) if (cur.builtin === name) return true;
  return false;
}

export function isIntegerType(t: SimpleType): boolean {
  return derivesFromBuiltin(t, 'integer');
}

function effectiveWhiteSpace(t: SimpleType): WhiteSpace | undefined {
  for (let cur: SimpleType | undefined = t; cur; cur = cur.base) {
    if (cur.facets.whiteSpace) return cur.facets.whiteSpace;
    if (cur.itemType) return 'collapse';
    if (cur.memberTypes) return undefined;
  }
  return 'preserve';
}

export function normalizeWhiteSpace(v: string, ws: WhiteSpace | undefined): string {
  if (ws === 'replace') return v.replace(/[\t\n\r]/g, ' ');
  if (ws === 'collapse') return v.replace(/[\t\n\r ]+/g, ' ').trim();
  return v;
}

export function normalizeFor(t: SimpleType, v: string): string {
  return normalizeWhiteSpace(v, effectiveWhiteSpace(t));
}

/** Validates a lexical value against a simple type. Returns an error message, or null when valid. */
export function checkSimple(t: SimpleType, raw: string): string | null {
  const v = normalizeFor(t, raw);
  if (t.itemType) {
    const items = v === '' ? [] : v.split(' ');
    for (const item of items) {
      const e = checkSimple(t.itemType, item);
      if (e) return `list item ${e}`;
    }
  } else if (t.memberTypes) {
    if (!t.memberTypes.some((m) => checkSimple(m, v) === null)) {
      return `"${v}" is not valid for any member of union (${t.memberTypes.map(typeName).join(', ')})`;
    }
  } else {
    if (t.base) {
      const e = checkSimple(t.base, v);
      if (e) return e;
    }
    if (t.lexical) {
      const e = t.lexical(v);
      if (e) return `"${v}" is not a valid ${typeName(t)} (${e})`;
    }
  }
  return applyFacets(t, v);
}

// ---------- value space helpers ----------

interface Dec {
  neg: boolean;
  int: string;
  frac: string;
}

function parseDecimal(s: string): Dec | undefined {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s.trim());
  if (!m || (m[2] === '' && !m[3])) return undefined;
  const int = m[2].replace(/^0+/, '');
  const frac = (m[3] ?? '').replace(/0+$/, '');
  return { neg: m[1] === '-' && (int !== '' || frac !== ''), int, frac };
}

function compareDecimal(a: string, b: string): number | undefined {
  const x = parseDecimal(a);
  const y = parseDecimal(b);
  if (!x || !y) return undefined;
  if (x.neg !== y.neg) return x.neg ? -1 : 1;
  let c: number;
  if (x.int.length !== y.int.length) c = x.int.length < y.int.length ? -1 : 1;
  else if (x.int !== y.int) c = x.int < y.int ? -1 : 1;
  else {
    const len = Math.max(x.frac.length, y.frac.length);
    const fa = x.frac.padEnd(len, '0');
    const fb = y.frac.padEnd(len, '0');
    c = fa === fb ? 0 : fa < fb ? -1 : 1;
  }
  return x.neg ? -c : c;
}

function parseFloatX(s: string): number {
  if (s === 'INF' || s === '+INF') return Infinity;
  if (s === '-INF') return -Infinity;
  return Number(s);
}

function dateToNumber(kind: string, v: string): number | undefined {
  const m = DATE_RES[kind]?.exec(v);
  if (!m) return undefined;
  const g = m.groups!;
  const y = g.y ? Number(g.y) : 2000;
  const mo = g.m ? Number(g.m) - 1 : 0;
  const d = g.d ? Number(g.d) : 1;
  let h = 0;
  let mi = 0;
  let s = 0;
  if (g.time) {
    if (g.time.startsWith('24')) h = 24;
    else {
      h = Number(g.h);
      mi = Number(g.mi);
      s = Number(g.s);
    }
  }
  let t = Date.UTC(y, mo, d, h, mi, 0) + s * 1000;
  if (g.tz && g.tz !== 'Z') {
    const sign = g.tz[0] === '-' ? -1 : 1;
    t -= sign * (Number(g.tz.slice(1, 3)) * 60 + Number(g.tz.slice(4, 6))) * 60000;
  }
  return t;
}

function durationToSeconds(v: string): number | undefined {
  const m = DURATION_RE.exec(v);
  if (!m) return undefined;
  const n = (i: number) => Number(m[i] ?? 0);
  const total = ((n(1) * 12 + n(2)) * 30 + n(3)) * 86400 + n(4) * 3600 + n(5) * 60 + n(6);
  return v.startsWith('-') ? -total : total;
}

/** Compares two values in the value space of a primitive type. */
export function compareValues(primitive: string | undefined, a: string, b: string): number | undefined {
  switch (primitive) {
    case 'decimal':
      return compareDecimal(a, b);
    case 'float':
    case 'double': {
      const x = parseFloatX(a);
      const y = parseFloatX(b);
      if (Number.isNaN(x) || Number.isNaN(y)) return undefined;
      return x === y ? 0 : x < y ? -1 : 1;
    }
    case 'duration': {
      const x = durationToSeconds(a);
      const y = durationToSeconds(b);
      return x === undefined || y === undefined ? undefined : Math.sign(x - y);
    }
    default:
      if (primitive && primitive in DATE_RES) {
        const x = dateToNumber(primitive, a);
        const y = dateToNumber(primitive, b);
        return x === undefined || y === undefined ? undefined : Math.sign(x - y);
      }
      return undefined;
  }
}

function valuesEqual(primitive: string | undefined, a: string, b: string): boolean {
  if (a === b) return true;
  if (primitive === 'boolean') return (a === 'true' || a === '1') === (b === 'true' || b === '1');
  return compareValues(primitive, a, b) === 0;
}

function lengthOf(primitive: string | undefined, v: string): number | undefined {
  if (primitive === 'QName' || primitive === 'NOTATION') return undefined;
  if (primitive === 'hexBinary') return v.length / 2;
  if (primitive === 'base64Binary') {
    const s = v.replace(/ /g, '');
    return (s.length * 3) / 4 - (s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0);
  }
  return [...v].length;
}

function applyFacets(t: SimpleType, v: string): string | null {
  const f = t.facets;
  const variety = varietyOf(t);
  const primitive = variety === 'atomic' ? primitiveOf(t) : undefined;
  const what = variety === 'list' ? 'item count' : 'length';

  if (f.length !== undefined || f.minLength !== undefined || f.maxLength !== undefined) {
    const len = variety === 'list' ? (v === '' ? 0 : v.split(' ').length) : lengthOf(primitive, v);
    if (len !== undefined) {
      if (f.length !== undefined && len !== f.length) return `"${v}" must have ${what} ${f.length} (has ${len})`;
      if (f.minLength !== undefined && len < f.minLength) return `"${v}" must have ${what} >= ${f.minLength} (has ${len})`;
      if (f.maxLength !== undefined && len > f.maxLength) return `"${v}" must have ${what} <= ${f.maxLength} (has ${len})`;
    }
  }
  if (f.patterns && !f.patterns.some((p) => p.regex.test(v))) {
    return `"${v}" does not match pattern ${f.patterns.map((p) => `/${p.source}/`).join(' or ')}`;
  }
  if (f.enumeration) {
    const ok = f.enumeration.some((e) => valuesEqual(primitive, normalizeFor(t, e), v));
    if (!ok) return `"${v}" is not one of the allowed values: ${f.enumeration.map((e) => JSON.stringify(e)).join(', ')}`;
  }
  const bound = (facet: string | undefined, label: string, okWhen: (c: number) => boolean): string | null => {
    if (facet === undefined) return null;
    const c = compareValues(primitive, v, facet);
    if (c === undefined || !okWhen(c)) return `"${v}" must be ${label} ${facet}`;
    return null;
  };
  const be =
    bound(f.minInclusive, '>=', (c) => c >= 0) ??
    bound(f.minExclusive, '>', (c) => c > 0) ??
    bound(f.maxInclusive, '<=', (c) => c <= 0) ??
    bound(f.maxExclusive, '<', (c) => c < 0);
  if (be) return be;
  if ((f.totalDigits !== undefined || f.fractionDigits !== undefined) && primitive === 'decimal') {
    const d = parseDecimal(v);
    if (d) {
      if (f.totalDigits !== undefined && d.int.length + d.frac.length > f.totalDigits) {
        return `"${v}" has more than ${f.totalDigits} total digits`;
      }
      if (f.fractionDigits !== undefined && d.frac.length > f.fractionDigits) {
        return `"${v}" has more than ${f.fractionDigits} fraction digits`;
      }
    }
  }
  return null;
}

/** Collects facet values along the derivation chain; the most derived declaration wins. */
export function effectiveFacets(t: SimpleType): Facets & { allPatterns: string[][] } {
  const out: Facets & { allPatterns: string[][] } = { allPatterns: [] };
  for (let cur: SimpleType | undefined = t; cur; cur = cur.base) {
    for (const [k, val] of Object.entries(cur.facets) as [keyof Facets, never][]) {
      if (k === 'patterns') out.allPatterns.push((val as Facets['patterns'])!.map((p) => p.source));
      else if (out[k] === undefined) (out as unknown as Record<string, unknown>)[k] = val;
    }
  }
  return out;
}

// ---------- JS value -> lexical form ----------

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');

function formatDate(kind: string | undefined, d: Date): string {
  if (Number.isNaN(d.getTime())) throw new TypeError('Invalid Date');
  const y = (d.getUTCFullYear() < 0 ? '-' : '') + pad(d.getUTCFullYear(), 4);
  const mo = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());
  const iso = d.toISOString();
  switch (kind) {
    case 'date':
      return `${y}-${mo}-${day}`;
    case 'time':
      return iso.slice(iso.indexOf('T') + 1);
    case 'gYear':
      return y;
    case 'gYearMonth':
      return `${y}-${mo}`;
    case 'gMonthDay':
      return `--${mo}-${day}`;
    case 'gMonth':
      return `--${mo}`;
    case 'gDay':
      return `---${day}`;
    default:
      return iso;
  }
}

function formatNumber(primitive: string | undefined, n: number): string {
  if (primitive === 'float' || primitive === 'double') {
    if (Number.isNaN(n)) return 'NaN';
    if (n === Infinity) return 'INF';
    if (n === -Infinity) return '-INF';
    return String(n);
  }
  if (!Number.isFinite(n)) return String(n);
  const s = String(n);
  if (!/e/i.test(s)) return s;
  if (Number.isInteger(n)) return BigInt(n).toString();
  return n.toFixed(20).replace(/0+$/, '').replace(/\.$/, '');
}

/** Converts a JavaScript value into the lexical representation for a simple type. */
export function formatValue(t: SimpleType, v: unknown): string {
  if (typeof v === 'string') return v;
  const variety = varietyOf(t);
  if (variety === 'list') {
    const item = listItemType(t)!;
    const arr = Array.isArray(v) || v instanceof Set ? [...(v as Iterable<unknown>)] : [v];
    return arr.map((x) => formatValue(item, x)).join(' ');
  }
  if (variety === 'union') {
    for (const m of unionMembers(t)!) {
      try {
        const s = formatValue(m, v);
        if (checkSimple(m, s) === null) return s;
      } catch {
        // try the next member
      }
    }
    return String(v);
  }
  const primitive = primitiveOf(t);
  if (v instanceof Date) return formatDate(primitive, v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return formatNumber(primitive, v);
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) {
    return encodeBinary(v, primitive === 'hexBinary');
  }
  if (v === null || v === undefined) return '';
  return String(v);
}

export function compileFacetPattern(source: string) {
  return compileXsdPattern(source);
}
