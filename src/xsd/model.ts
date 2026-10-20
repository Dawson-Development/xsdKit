export const XS_NS = 'http://www.w3.org/2001/XMLSchema';
export const XSI_NS = 'http://www.w3.org/2001/XMLSchema-instance';
export { XML_NS } from '../xml/parser.js';

export interface QName {
  ns: string;
  local: string;
}

export function qkey(q: QName): string {
  return q.ns ? `{${q.ns}}${q.local}` : q.local;
}

export function qeq(a: QName, b: QName): boolean {
  return a.ns === b.ns && a.local === b.local;
}

export type WhiteSpace = 'preserve' | 'replace' | 'collapse';

export interface PatternFacet {
  source: string;
  regex: RegExp;
}

export interface Facets {
  length?: number;
  minLength?: number;
  maxLength?: number;
  /** Patterns declared in the same derivation step are OR-ed together. */
  patterns?: PatternFacet[];
  enumeration?: string[];
  whiteSpace?: WhiteSpace;
  minInclusive?: string;
  minExclusive?: string;
  maxInclusive?: string;
  maxExclusive?: string;
  totalDigits?: number;
  fractionDigits?: number;
}

export interface SimpleType {
  kind: 'simple';
  name?: QName;
  /** Name of the built-in type, when this is one of the XSD built-ins. */
  builtin?: string;
  /** Restriction base. */
  base?: SimpleType;
  /** Set when this type is defined as an xs:list. */
  itemType?: SimpleType;
  /** Set when this type is defined as an xs:union. */
  memberTypes?: SimpleType[];
  facets: Facets;
  /** Extra lexical check (used by built-ins). Returns an error message or null. */
  lexical?: (value: string) => string | null;
  documentation?: string;
}

export type ProcessContents = 'strict' | 'lax' | 'skip';

export interface Wildcard {
  mode: 'any' | 'other' | 'list';
  namespaces: string[];
  targetNamespace: string;
  process: ProcessContents;
}

export interface AttributeUse {
  name: QName;
  type: SimpleType;
  required: boolean;
  default?: string;
  fixed?: string;
  documentation?: string;
}

export interface ElementDecl {
  name: QName;
  type: TypeDef;
  global: boolean;
  nillable: boolean;
  abstract: boolean;
  default?: string;
  fixed?: string;
  substitutionGroup?: ElementDecl;
  /** Elements that may substitute for this one (transitive). */
  substitutes: ElementDecl[];
  documentation?: string;
}

export type Particle =
  | { kind: 'element'; decl: ElementDecl; min: number; max: number }
  | { kind: 'any'; wildcard: Wildcard; min: number; max: number }
  | { kind: 'sequence' | 'choice' | 'all'; items: Particle[]; min: number; max: number };

export interface ComplexType {
  kind: 'complex';
  name?: QName;
  abstract: boolean;
  mixed: boolean;
  attributes: AttributeUse[];
  anyAttribute?: Wildcard;
  content: 'empty' | 'simple' | 'element';
  simpleType?: SimpleType;
  particle?: Particle;
  base?: TypeDef;
  derivation?: 'extension' | 'restriction';
  documentation?: string;
}

export type TypeDef = SimpleType | ComplexType;

export function wildcardAllows(w: Wildcard, ns: string): boolean {
  switch (w.mode) {
    case 'any':
      return true;
    case 'other':
      return ns !== w.targetNamespace && ns !== '';
    default:
      return w.namespaces.includes(ns);
  }
}

export function describeWildcard(w: Wildcard): string {
  if (w.mode === 'any') return 'any namespace';
  if (w.mode === 'other') return `any namespace other than "${w.targetNamespace}"`;
  return w.namespaces.map((n) => (n === '' ? '(no namespace)' : `"${n}"`)).join(' | ');
}

export function typeName(t: TypeDef | undefined): string {
  if (!t) return '?';
  if (t.name) return t.name.ns === XS_NS ? `xs:${t.name.local}` : t.name.local;
  return t.kind === 'simple' ? '(anonymous simple type)' : '(anonymous complex type)';
}

export function isDerivedFrom(t: TypeDef, base: TypeDef): boolean {
  if (base.kind === 'complex' && base.name?.ns === XS_NS && base.name.local === 'anyType') return true;
  for (let cur: TypeDef | undefined = t; cur; cur = cur.base) {
    if (cur === base) return true;
  }
  return false;
}
