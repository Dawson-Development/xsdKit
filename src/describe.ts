import { displayName } from './validator.js';
import { ElementDecl, Particle, SimpleType, TypeDef, describeWildcard, typeName } from './xsd/model.js';
import { effectiveFacets, listItemType, unionMembers, varietyOf } from './xsd/simple.js';

export type Occurs = number | 'unbounded';

export interface AttributeInfo {
  name: string;
  namespace: string;
  type: string;
  required: boolean;
  default?: string;
  fixed?: string;
  restrictions?: string;
  documentation?: string;
}

export interface ElementInfo {
  kind: 'element';
  name: string;
  namespace: string;
  type: string;
  minOccurs: number;
  maxOccurs: Occurs;
  content: 'simple' | 'element' | 'mixed' | 'empty';
  nillable: boolean;
  abstract: boolean;
  /** Type of the text value for simple content. */
  valueType?: string;
  /** Human-readable summary of facets (enumeration, pattern, ranges...). */
  restrictions?: string;
  default?: string;
  fixed?: string;
  attributes: AttributeInfo[];
  model?: ModelInfo;
  /** Set when the type was already expanded higher up (recursive structure). */
  recursive?: boolean;
  documentation?: string;
}

export interface ModelInfo {
  kind: 'sequence' | 'choice' | 'all';
  minOccurs: number;
  maxOccurs: Occurs;
  items: (ModelInfo | ElementInfo | WildcardInfo)[];
}

export interface WildcardInfo {
  kind: 'any';
  namespaces: string;
  processContents: string;
  minOccurs: number;
  maxOccurs: Occurs;
}

const occ = (n: number): Occurs => (n === Infinity ? 'unbounded' : n);

export function summarizeFacets(st: SimpleType): string | undefined {
  const parts: string[] = [];
  const variety = varietyOf(st);
  if (variety === 'list') parts.push(`list of ${typeName(listItemType(st))}`);
  if (variety === 'union') parts.push(`union of ${unionMembers(st)!.map(memberLabel).join(' | ')}`);
  const f = effectiveFacets(st);
  if (f.enumeration) parts.push(`one of: ${f.enumeration.join(' | ')}`);
  for (const g of f.allPatterns) parts.push(`pattern: ${g.join(' | ')}`);
  if (f.length !== undefined) parts.push(`length = ${f.length}`);
  if (f.minLength !== undefined) parts.push(`minLength = ${f.minLength}`);
  if (f.maxLength !== undefined) parts.push(`maxLength = ${f.maxLength}`);
  const skipBuiltinRange = st.builtin !== undefined;
  if (!skipBuiltinRange) {
    if (f.minInclusive !== undefined) parts.push(`>= ${f.minInclusive}`);
    if (f.minExclusive !== undefined) parts.push(`> ${f.minExclusive}`);
    if (f.maxInclusive !== undefined) parts.push(`<= ${f.maxInclusive}`);
    if (f.maxExclusive !== undefined) parts.push(`< ${f.maxExclusive}`);
  }
  if (f.totalDigits !== undefined) parts.push(`totalDigits = ${f.totalDigits}`);
  if (f.fractionDigits !== undefined && !st.builtin) parts.push(`fractionDigits = ${f.fractionDigits}`);
  return parts.length ? parts.join('; ') : undefined;
}

function memberLabel(st: SimpleType): string {
  if (st.name) return typeName(st);
  const s = summarizeFacets(st);
  return s ? `${baseBuiltinName(st)} (${s})` : baseBuiltinName(st);
}

function baseBuiltinName(st: SimpleType): string {
  for (let cur: SimpleType | undefined = st; cur; cur = cur.base) if (cur.name) return typeName(cur);
  return typeName(st);
}

export function describeElement(decl: ElementDecl, min = 1, max = 1, stack: TypeDef[] = []): ElementInfo {
  const t = decl.type;
  const info: ElementInfo = {
    kind: 'element',
    name: displayName(decl.name),
    namespace: decl.name.ns,
    type: t.kind === 'simple' ? baseBuiltinName(t) : typeName(t),
    minOccurs: min,
    maxOccurs: occ(max),
    content: 'empty',
    nillable: decl.nillable,
    abstract: decl.abstract,
    attributes: [],
    ...(decl.default !== undefined ? { default: decl.default } : {}),
    ...(decl.fixed !== undefined ? { fixed: decl.fixed } : {}),
    ...(decl.documentation ?? t.documentation ? { documentation: decl.documentation ?? t.documentation } : {}),
  };
  const st = t.kind === 'simple' ? t : t.content === 'simple' ? t.simpleType : undefined;
  if (st) {
    info.content = 'simple';
    info.valueType = baseBuiltinName(st);
    const r = summarizeFacets(st);
    if (r) info.restrictions = r;
  }
  if (t.kind === 'complex') {
    info.attributes = t.attributes.map((a) => ({
      name: displayName(a.name),
      namespace: a.name.ns,
      type: baseBuiltinName(a.type),
      required: a.required,
      ...(a.default !== undefined ? { default: a.default } : {}),
      ...(a.fixed !== undefined ? { fixed: a.fixed } : {}),
      ...(summarizeFacets(a.type) ? { restrictions: summarizeFacets(a.type) } : {}),
      ...(a.documentation ? { documentation: a.documentation } : {}),
    }));
    if (t.content === 'element') {
      info.content = t.mixed ? 'mixed' : 'element';
      if (stack.includes(t)) info.recursive = true;
      else if (t.particle) info.model = wrapModel(describeParticle(t.particle, [...stack, t]));
    }
  }
  return info;
}

function wrapModel(m: ModelInfo | ElementInfo | WildcardInfo): ModelInfo {
  return m.kind === 'sequence' || m.kind === 'choice' || m.kind === 'all'
    ? m
    : { kind: 'sequence', minOccurs: 1, maxOccurs: 1, items: [m] };
}

function describeParticle(p: Particle, stack: TypeDef[]): ModelInfo | ElementInfo | WildcardInfo {
  if (p.kind === 'element') {
    if (p.decl.abstract && p.decl.substitutes.length) {
      return {
        kind: 'choice',
        minOccurs: p.min,
        maxOccurs: occ(p.max),
        items: p.decl.substitutes.filter((s) => !s.abstract).map((s) => describeElement(s, 1, 1, stack)),
      };
    }
    return describeElement(p.decl, p.min, p.max, stack);
  }
  if (p.kind === 'any') {
    return {
      kind: 'any',
      namespaces: describeWildcard(p.wildcard),
      processContents: p.wildcard.process,
      minOccurs: p.min,
      maxOccurs: occ(p.max),
    };
  }
  return { kind: p.kind, minOccurs: p.min, maxOccurs: occ(p.max), items: p.items.map((i) => describeParticle(i, stack)) };
}

/** Renders an ElementInfo as an indented text tree. */
export function renderTree(info: ElementInfo): string {
  const lines: string[] = [];
  const range = (min: number, max: Occurs) => (min === 1 && max === 1 ? '' : ` [${min}..${max === 'unbounded' ? '*' : max}]`);
  const el = (e: ElementInfo, depth: number) => {
    const pad = '  '.repeat(depth);
    let line = `${pad}${e.name}${range(e.minOccurs, e.maxOccurs)}`;
    if (!e.type.startsWith('(')) line += ` : ${e.type}`;
    else if (e.valueType) line += ` : ${e.valueType}`;
    if (e.content === 'mixed') line += ' (mixed)';
    if (e.nillable) line += ' (nillable)';
    if (e.fixed !== undefined) line += ` fixed="${e.fixed}"`;
    else if (e.default !== undefined) line += ` default="${e.default}"`;
    if (e.restrictions) line += `  {${e.restrictions}}`;
    if (e.recursive) line += '  (recursive, see above)';
    lines.push(line);
    for (const a of e.attributes) {
      let l = `${pad}  @${a.name}${a.required ? '' : '?'} : ${a.type}`;
      if (a.fixed !== undefined) l += ` fixed="${a.fixed}"`;
      else if (a.default !== undefined) l += ` default="${a.default}"`;
      if (a.restrictions) l += `  {${a.restrictions}}`;
      lines.push(l);
    }
    if (e.model) model(e.model, depth + 1, true);
  };
  const model = (m: ModelInfo, depth: number, top: boolean) => {
    const flatten = top && m.kind === 'sequence' && m.minOccurs === 1 && m.maxOccurs === 1;
    if (!flatten) lines.push(`${'  '.repeat(depth)}(${m.kind})${range(m.minOccurs, m.maxOccurs)}`);
    const d = flatten ? depth : depth + 1;
    for (const it of m.items) {
      if (it.kind === 'element') el(it, d);
      else if (it.kind === 'any') lines.push(`${'  '.repeat(d)}* any element from ${it.namespaces}${range(it.minOccurs, it.maxOccurs)}`);
      else model(it, d, false);
    }
  };
  el(info, 0);
  return lines.join('\n');
}
