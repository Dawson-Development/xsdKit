import { ElementNode } from './node.js';
import { ComplexType, ElementDecl, Particle, SimpleType, TypeDef, isDerivedFrom } from './xsd/model.js';
import type { SchemaSet } from './xsd/loader.js';
import { compileXsdPattern } from './xsd/regex.js';
import {
  checkSimple,
  derivesFromBuiltin,
  effectiveFacets,
  isIntegerType,
  listItemType,
  primitiveOf,
  unionMembers,
  varietyOf,
} from './xsd/simple.js';

export interface SampleOptions {
  /** Include optional elements and attributes too (default: false, only required content). */
  optional?: boolean;
  /** Maximum depth at which optional content is still added (default: 8). */
  maxDepth?: number;
  /** Add a comment before each element describing its type and occurrence (default: false). */
  comments?: boolean;
}

const DEFAULTS: Record<string, string> = {
  boolean: 'true',
  float: '0',
  double: '0',
  decimal: '0',
  duration: 'P1D',
  dateTime: '2000-01-01T00:00:00',
  time: '00:00:00',
  date: '2000-01-01',
  gYearMonth: '2000-01',
  gYear: '2000',
  gMonthDay: '--01-01',
  gDay: '---01',
  gMonth: '--01',
  hexBinary: '00',
  base64Binary: 'AA==',
  anyURI: 'http://example.com/',
  QName: 'name',
  NOTATION: 'name',
};

export class SampleGenerator {
  private idCounter = 0;
  private readonly maxDepth: number;

  constructor(
    private readonly set: SchemaSet,
    private readonly opts: SampleOptions = {},
  ) {
    this.maxDepth = opts.maxDepth ?? 8;
  }

  element(decl: ElementDecl, depth = 0): ElementNode | undefined {
    let d: ElementDecl | undefined = decl;
    if (d.abstract) d = d.substitutes.find((s) => !s.abstract);
    if (!d) return undefined;
    let type = d.type;
    const node: ElementNode = { kind: 'element', name: d.name, attributes: [], children: [], nil: false, decl: d, type };
    if (type.kind === 'complex' && type.abstract) {
      const concrete = [...this.set.types.values()].find(
        (t) => t !== type && t.kind === 'complex' && !t.abstract && t.name && isDerivedFrom(t, type),
      );
      if (concrete) {
        type = concrete;
        node.type = concrete;
        node.xsiType = concrete.name;
      }
    }
    if (type.kind === 'complex') {
      for (const a of type.attributes) {
        if (a.required || this.opts.optional) {
          node.attributes.push({ name: a.name, value: a.fixed ?? a.default ?? this.simple(a.type) });
        }
      }
    }
    const st = type.kind === 'simple' ? type : type.content === 'simple' ? type.simpleType : undefined;
    if (st) {
      node.children.push({ kind: 'text', value: d.fixed ?? d.default ?? this.simple(st) });
    } else if ((type as ComplexType).particle && depth < this.maxDepth + 20) {
      this.particle(node, (type as ComplexType).particle!, depth);
    }
    return node;
  }

  private particle(node: ElementNode, p: Particle, depth: number): void {
    if (p.kind === 'any' && p.min === 0) return;
    const count = p.min > 0 ? p.min : this.opts.optional && depth < this.maxDepth ? 1 : 0;
    for (let i = 0; i < count; i++) this.term(node, p, depth);
  }

  private term(node: ElementNode, p: Particle, depth: number): void {
    switch (p.kind) {
      case 'element': {
        const child = this.element(p.decl, depth + 1);
        if (!child) return;
        if (this.opts.comments) {
          const occ = `${p.min}..${p.max === Infinity ? '*' : p.max}`;
          node.children.push({ kind: 'comment', value: ` ${describeType(child.type!)} [${occ}] ` });
        }
        node.children.push(child);
        return;
      }
      case 'any':
        node.children.push({ kind: 'comment', value: ' any element ' });
        return;
      case 'choice': {
        const pick = p.items.find((it) => !(it.kind === 'element' && it.decl.abstract && !it.decl.substitutes.length)) ?? p.items[0];
        if (pick) this.particle(node, pick, depth);
        return;
      }
      default:
        for (const it of p.items) this.particle(node, it, depth);
    }
  }

  /** Produces a sample lexical value that satisfies the simple type where possible. */
  simple(st: SimpleType): string {
    const f = effectiveFacets(st);
    if (f.enumeration?.length) return f.enumeration[0];
    const variety = varietyOf(st);
    if (variety === 'list') {
      const item = this.simple(listItemType(st)!);
      const n = Math.max(1, f.length ?? f.minLength ?? 1);
      return Array(n).fill(item).join(' ');
    }
    if (variety === 'union') return this.simple(unionMembers(st)![0]);

    for (const group of f.allPatterns) {
      for (const src of group) {
        const s = compileXsdPattern(src).sample();
        if (s !== undefined && checkSimple(st, s) === null) return s;
      }
    }

    const candidates: string[] = [];
    if (derivesFromBuiltin(st, 'ID')) candidates.push(`id${++this.idCounter}`);
    else if (derivesFromBuiltin(st, 'IDREF')) candidates.push('id1');
    const primitive = primitiveOf(st) ?? 'string';
    if (isIntegerType(st)) candidates.push(this.integer(f));
    else if (['decimal', 'float', 'double'].includes(primitive)) candidates.push(this.number(f));
    else if (primitive in DEFAULTS) {
      candidates.push(f.minInclusive ?? f.maxInclusive ?? DEFAULTS[primitive]);
    } else {
      let s = derivesFromBuiltin(st, 'language')
        ? 'en'
        : derivesFromBuiltin(st, 'Name') || derivesFromBuiltin(st, 'NMTOKEN')
          ? 'name'
          : 'string';
      const len = f.length ?? f.minLength;
      if (len !== undefined && s.length < len) s = s.padEnd(len, 'x');
      const max = f.length ?? f.maxLength;
      if (max !== undefined && s.length > max) s = s.slice(0, max);
      candidates.push(s);
    }
    if (primitive in DEFAULTS) candidates.push(DEFAULTS[primitive]);
    for (const c of candidates) if (checkSimple(st, c) === null) return c;
    return candidates[0];
  }

  private integer(f: ReturnType<typeof effectiveFacets>): string {
    const big = (s: string | undefined) => {
      try {
        return s === undefined ? undefined : BigInt(s.trim().replace(/^\+/, '').replace(/\.0*$/, ''));
      } catch {
        return undefined;
      }
    };
    const minE = big(f.minExclusive);
    const maxE = big(f.maxExclusive);
    const lo = big(f.minInclusive) ?? (minE !== undefined ? minE + 1n : undefined);
    const hi = big(f.maxInclusive) ?? (maxE !== undefined ? maxE - 1n : undefined);
    let v = 0n;
    if (lo !== undefined && v < lo) v = lo;
    if (hi !== undefined && v > hi) v = hi;
    return v.toString();
  }

  private number(f: ReturnType<typeof effectiveFacets>): string {
    const num = (s: string | undefined) => (s === undefined ? undefined : Number(s));
    const lo = num(f.minInclusive) ?? num(f.minExclusive);
    const hi = num(f.maxInclusive) ?? num(f.maxExclusive);
    const loEx = f.minInclusive === undefined && f.minExclusive !== undefined;
    const hiEx = f.maxInclusive === undefined && f.maxExclusive !== undefined;
    let v = 0;
    if (lo !== undefined && (v < lo || (loEx && v <= lo))) v = loEx ? lo + 1 : lo;
    if (hi !== undefined && (v > hi || (hiEx && v >= hi))) v = hiEx ? hi - 1 : hi;
    if (lo !== undefined && hi !== undefined && (v < lo || v > hi || (loEx && v === lo) || (hiEx && v === hi))) v = (lo + hi) / 2;
    return String(v);
  }
}

function describeType(t: TypeDef): string {
  if (t.name) return t.name.local;
  return t.kind === 'simple' ? 'simple' : 'complex';
}
