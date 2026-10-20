import { ElementNode, childElements, textContent } from './node.js';
import {
  ComplexType,
  ElementDecl,
  Particle,
  QName,
  SimpleType,
  TypeDef,
  Wildcard,
  XML_NS,
  XSI_NS,
  XS_NS,
  describeWildcard,
  isDerivedFrom,
  qeq,
  qkey,
  typeName,
  wildcardAllows,
} from './xsd/model.js';
import type { SchemaSet } from './xsd/loader.js';
import { checkSimple, derivesFromBuiltin, listItemType, normalizeFor } from './xsd/simple.js';
import { getBuiltinSimpleType } from './xsd/simple.js';
import { XmlElement } from './xml/parser.js';

export interface ValidationIssue {
  /** XPath-like location, e.g. /order/items/item[2]/@sku */
  path: string;
  message: string;
  /** Source line, when validating a parsed document. */
  line?: number;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
}

export class XsdValidationError extends Error {
  constructor(readonly errors: ValidationIssue[]) {
    super(
      `XML is not valid against the schema (${errors.length} error${errors.length === 1 ? '' : 's'}):\n` +
        errors.map((e) => `  - ${e.path}${e.line ? ` (line ${e.line})` : ''}: ${e.message}`).join('\n'),
    );
    this.name = 'XsdValidationError';
  }
}

export function displayName(q: QName): string {
  if (q.ns === XML_NS) return `xml:${q.local}`;
  if (q.ns === XSI_NS) return `xsi:${q.local}`;
  return q.local;
}

// ---------- content model helpers ----------

export interface ContentDecls {
  /** Every element declaration that can appear (substitution group members included, abstract ones excluded), in schema order. */
  decls: ElementDecl[];
  wildcards: Wildcard[];
  /**
   * True when children can be placed purely by their schema position: no repeating
   * sequence/choice/all contains more than one distinct element.
   */
  orderable: boolean;
  /** Schema position of each element term (by qkey); substitutes share their head's position. */
  rank: Map<string, number>;
  /** Schema position of the first wildcard term, if any. */
  wildcardRank: number;
}

const declCache = new WeakMap<Particle, ContentDecls>();

export function contentDecls(p: Particle | undefined): ContentDecls {
  if (!p) return { decls: [], wildcards: [], orderable: true, rank: new Map(), wildcardRank: Infinity };
  const hit = declCache.get(p);
  if (hit) return hit;
  const out: ContentDecls = { decls: [], wildcards: [], orderable: true, rank: new Map(), wildcardRank: Infinity };
  const seen = new Set<string>();
  let term = 0;
  const add = (d: ElementDecl, pos: number) => {
    const k = qkey(d.name);
    if (!out.rank.has(k)) out.rank.set(k, pos);
    if (d.abstract || seen.has(k)) return;
    seen.add(k);
    out.decls.push(d);
  };
  const walk = (q: Particle, fixedPos?: number) => {
    if (q.max === 0) return;
    if (q.kind === 'element') {
      const pos = fixedPos ?? term++;
      add(q.decl, pos);
      q.decl.substitutes.forEach((s) => add(s, pos));
    } else if (q.kind === 'any') {
      if (!out.wildcards.length) out.wildcardRank = fixedPos ?? term;
      if (fixedPos === undefined) term++;
      out.wildcards.push(q.wildcard);
    } else {
      if (q.max > 1 && countTerms(q) > 1) out.orderable = false;
      // xs:all members may appear in any order, so they share one position and keep insertion order.
      const shared = fixedPos ?? (q.kind === 'all' ? term++ : undefined);
      q.items.forEach((i) => walk(i, shared));
    }
  };
  walk(p);
  declCache.set(p, out);
  return out;
}

function countTerms(p: Particle): number {
  if (p.kind === 'element' || p.kind === 'any') return 1;
  return p.items.reduce((n, i) => n + countTerms(i), 0);
}

function matchDecl(decl: ElementDecl, name: QName): boolean {
  if (!decl.abstract && qeq(decl.name, name)) return true;
  return decl.substitutes.some((s) => !s.abstract && qeq(s.name, name));
}

function declLabel(decl: ElementDecl): string[] {
  const all = [decl, ...decl.substitutes].filter((d) => !d.abstract);
  return all.map((d) => `<${d.name.local}>`);
}

/** Matches a sequence of child element names against a content model (NFA-style, with memoization). */
export class ContentMatcher {
  private readonly memo = new Map<Particle, Map<number, number[]>>();
  reached = 0;
  readonly expected = new Map<number, Set<string>>();

  constructor(private readonly names: QName[]) {}

  matches(p: Particle): boolean {
    return this.run(p, 0).includes(this.names.length);
  }

  private expect(i: number, labels: string[]) {
    let s = this.expected.get(i);
    if (!s) this.expected.set(i, (s = new Set()));
    labels.forEach((l) => s!.add(l));
    if (i > this.reached) this.reached = i;
  }

  run(p: Particle, i: number): number[] {
    let m = this.memo.get(p);
    if (!m) this.memo.set(p, (m = new Map()));
    const hit = m.get(i);
    if (hit) return hit;
    m.set(i, []);
    const result = new Set<number>();
    if (p.min === 0) result.add(i);
    let frontier = [i];
    const seen = new Set<number>();
    for (let count = 1; frontier.length && count <= p.max; count++) {
      const next = new Set<number>();
      for (const f of frontier) for (const e of this.once(p, f)) next.add(e);
      if (count >= p.min) {
        next.forEach((e) => result.add(e));
        frontier = [...next].filter((e) => !seen.has(e));
        frontier.forEach((e) => seen.add(e));
      } else frontier = [...next];
      if (count > this.names.length + p.min + 1) break;
    }
    const out = [...result];
    m.set(i, out);
    return out;
  }

  private once(p: Particle, i: number): number[] {
    const n = this.names.length;
    switch (p.kind) {
      case 'element':
        if (i < n && matchDecl(p.decl, this.names[i])) {
          if (i + 1 > this.reached) this.reached = i + 1;
          return [i + 1];
        }
        this.expect(i, declLabel(p.decl));
        return [];
      case 'any':
        if (i < n && wildcardAllows(p.wildcard, this.names[i].ns)) {
          if (i + 1 > this.reached) this.reached = i + 1;
          return [i + 1];
        }
        this.expect(i, [`any element (${describeWildcard(p.wildcard)})`]);
        return [];
      case 'sequence': {
        let pos = [i];
        for (const item of p.items) {
          const next = new Set<number>();
          for (const x of pos) for (const e of this.run(item, x)) next.add(e);
          pos = [...next];
          if (!pos.length) return [];
        }
        return pos;
      }
      case 'choice': {
        const out = new Set<number>();
        for (const item of p.items) for (const e of this.run(item, i)) out.add(e);
        return [...out];
      }
      case 'all':
        return this.all(p.items, i);
    }
  }

  private all(items: Particle[], start: number): number[] {
    const out = new Set<number>();
    const visited = new Set<string>();
    const visit = (pos: number, used: bigint) => {
      const key = `${pos}:${used}`;
      if (visited.has(key)) return;
      visited.add(key);
      if (items.every((it, k) => (used & (1n << BigInt(k))) !== 0n || it.min === 0)) out.add(pos);
      items.forEach((it, k) => {
        const bit = 1n << BigInt(k);
        if (used & bit) return;
        for (const e of this.run(it, pos)) if (e > pos) visit(e, used | bit);
      });
    };
    visit(start, 0n);
    return [...out];
  }
}

// ---------- validator ----------

export class Validator {
  readonly errors: ValidationIssue[] = [];
  private readonly ids = new Map<string, string>();
  private readonly idrefs: { value: string; path: string; line?: number }[] = [];

  constructor(private readonly set: SchemaSet) {}

  private err(path: string, message: string, node?: ElementNode) {
    this.errors.push({ path, message, ...(node?.line ? { line: node.line } : {}) });
  }

  findType(q: QName): TypeDef | undefined {
    if (q.ns === XS_NS) return q.local === 'anyType' ? this.set.anyType : getBuiltinSimpleType(q.local);
    return this.set.types.get(qkey(q));
  }

  validateRoot(node: ElementNode): ValidationResult {
    const path = '/' + displayName(node.name);
    const decl = node.decl?.global ? node.decl : this.set.elements.get(qkey(node.name));
    if (!decl) {
      const ns = node.name.ns ? ` in namespace "${node.name.ns}"` : '';
      this.err(path, `No global element declaration for <${node.name.local}>${ns}`, node);
    } else {
      this.element(node, decl, path);
      for (const r of this.idrefs) {
        if (!this.ids.has(r.value)) this.errors.push({ path: r.path, message: `IDREF "${r.value}" does not match any ID in the document`, line: r.line });
      }
    }
    return { valid: this.errors.length === 0, errors: this.errors };
  }

  element(node: ElementNode, decl: ElementDecl, path: string): void {
    node.decl = decl;
    if (decl.abstract) {
      const subs = decl.substitutes.filter((s) => !s.abstract).map((s) => `<${s.name.local}>`);
      this.err(path, `Element <${decl.name.local}> is abstract${subs.length ? `; use one of: ${subs.join(', ')}` : ''}`, node);
    }
    let type = decl.type;
    if (node.xsiType) {
      const t = this.findType(node.xsiType);
      if (!t) this.err(path, `xsi:type "${node.xsiType.local}" does not name a known type`, node);
      else if (!isDerivedFrom(t, type)) {
        this.err(path, `xsi:type "${typeName(t)}" is not derived from the declared type "${typeName(type)}"`, node);
      } else type = t;
    }
    node.type = type;
    if (type.kind === 'complex' && type.abstract) {
      this.err(path, `Type "${typeName(type)}" is abstract; select a concrete derived type with xsi:type`, node);
    }
    this.attributes(node, type, path);

    const kids = childElements(node);
    const text = textContent(node);
    if (node.nil) {
      if (!decl.nillable) this.err(path, `Element <${decl.name.local}> is not nillable`, node);
      else if (kids.length || text !== '') this.err(path, 'An element with xsi:nil="true" must be empty', node);
      else if (decl.fixed !== undefined) this.err(path, 'An element with a fixed value cannot be nil', node);
      return;
    }

    const st = type.kind === 'simple' ? type : type.content === 'simple' ? type.simpleType : undefined;
    if (st) {
      if (kids.length) {
        this.err(path, `Element <${decl.name.local}> has simple content (${typeName(st)}); child elements are not allowed`, node);
        return;
      }
      let value = text;
      if (value === '' && decl.fixed !== undefined) value = decl.fixed;
      else if (value === '' && decl.default !== undefined) value = decl.default;
      if (decl.fixed !== undefined && normalizeFor(st, value) !== normalizeFor(st, decl.fixed)) {
        this.err(path, `Value must be the fixed value "${decl.fixed}"`, node);
        return;
      }
      this.simpleValue(st, value, path, node);
      return;
    }
    const ct = type as ComplexType;
    if (ct.content === 'empty') {
      if (kids.length || text.trim()) this.err(path, `Element <${decl.name.local}> must be empty`, node);
      return;
    }
    if (!ct.mixed && text.trim()) {
      const snippet = text.trim().length > 30 ? text.trim().slice(0, 30) + '…' : text.trim();
      this.err(path, `Element <${decl.name.local}> does not allow text content (found "${snippet}")`, node);
    }
    this.content(node, ct, kids, path);
  }

  private content(node: ElementNode, type: ComplexType, kids: ElementNode[], path: string): void {
    const local = node.name.local;
    if (!type.particle) {
      if (kids.length) this.err(path, `Element <${local}> does not allow child elements (found <${kids[0].name.local}>)`, node);
      return;
    }
    const matcher = new ContentMatcher(kids.map((k) => k.name));
    if (!matcher.matches(type.particle)) {
      const at = matcher.reached;
      const expected = [...(matcher.expected.get(at) ?? [])];
      const exp = expected.length ? `; expected ${expected.length > 1 ? 'one of: ' : ''}${expected.join(', ')}` : '';
      if (at < kids.length) {
        const k = kids[at];
        const known = contentDecls(type.particle).decls.some((d) => qeq(d.name, k.name));
        const hint = known ? ' (check element order and maxOccurs)' : '';
        this.err(path, `Unexpected element <${k.name.local}>${hint}${exp}`, k.line ? k : node);
      } else {
        this.err(path, `Element <${local}> is incomplete${exp}`, node);
      }
    }

    const { decls, wildcards } = contentDecls(type.particle);
    const totals = new Map<string, number>();
    for (const k of kids) totals.set(qkey(k.name), (totals.get(qkey(k.name)) ?? 0) + 1);
    const counters = new Map<string, number>();
    for (const k of kids) {
      const key = qkey(k.name);
      const idx = (counters.get(key) ?? 0) + 1;
      counters.set(key, idx);
      const childPath = `${path}/${displayName(k.name)}${(totals.get(key) ?? 0) > 1 ? `[${idx}]` : ''}`;
      const d = decls.find((x) => qeq(x.name, k.name));
      if (d) {
        this.element(k, d, childPath);
        continue;
      }
      const wc = wildcards.find((w) => wildcardAllows(w, k.name.ns));
      if (!wc || wc.process === 'skip') continue;
      const g = this.set.elements.get(key);
      if (g) this.element(k, g, childPath);
      else if (wc.process === 'strict') this.err(childPath, `No global declaration found for wildcard element <${k.name.local}>`, k);
    }
  }

  private attributes(node: ElementNode, type: TypeDef, path: string): void {
    const uses = type.kind === 'complex' ? type.attributes : [];
    const any = type.kind === 'complex' ? type.anyAttribute : undefined;
    const seen = new Set<string>();
    for (const a of node.attributes) {
      if (a.name.ns === XSI_NS) continue;
      const apath = `${path}/@${displayName(a.name)}`;
      const use = uses.find((u) => qeq(u.name, a.name));
      if (use) {
        seen.add(qkey(use.name));
        if (use.fixed !== undefined && normalizeFor(use.type, a.value) !== normalizeFor(use.type, use.fixed)) {
          this.err(apath, `Attribute must have the fixed value "${use.fixed}"`, node);
        } else this.simpleValue(use.type, a.value, apath, node);
        continue;
      }
      if (any && wildcardAllows(any, a.name.ns)) {
        if (any.process === 'skip') continue;
        const g = this.set.attributes.get(qkey(a.name));
        if (g) this.simpleValue(g.type, a.value, apath, node);
        else if (any.process === 'strict' && a.name.ns !== XML_NS) {
          this.err(apath, `No global declaration found for wildcard attribute "${displayName(a.name)}"`, node);
        }
        continue;
      }
      const allowed = uses.map((u) => displayName(u.name));
      this.err(
        apath,
        `Attribute "${displayName(a.name)}" is not allowed on <${node.name.local}>${allowed.length ? ` (allowed: ${allowed.join(', ')})` : ''}`,
        node,
      );
    }
    for (const u of uses) {
      if (u.required && !seen.has(qkey(u.name))) this.err(path, `Missing required attribute "${displayName(u.name)}"`, node);
    }
  }

  private simpleValue(st: SimpleType, value: string, path: string, node: ElementNode): void {
    const e = checkSimple(st, value);
    if (e) {
      this.err(path, e, node);
      return;
    }
    const v = normalizeFor(st, value);
    if (derivesFromBuiltin(st, 'ID')) {
      if (this.ids.has(v)) this.err(path, `Duplicate ID "${v}" (first used at ${this.ids.get(v)})`, node);
      else this.ids.set(v, path);
    } else if (derivesFromBuiltin(st, 'IDREF')) {
      this.idrefs.push({ value: v, path, line: node.line });
    } else {
      const item = listItemType(st);
      if (item && derivesFromBuiltin(item, 'IDREF')) {
        for (const x of v.split(' ').filter(Boolean)) this.idrefs.push({ value: x, path, line: node.line });
      }
    }
  }
}

/** Converts a parsed XML element into the validator's node model. */
export function nodeFromXml(el: XmlElement): ElementNode {
  const node: ElementNode = {
    kind: 'element',
    name: { ns: el.ns, local: el.local },
    attributes: [],
    children: [],
    nil: false,
    line: el.line,
  };
  for (const a of el.attributes) {
    if (a.ns === XSI_NS && a.local === 'nil') {
      node.nil = a.value.trim() === 'true' || a.value.trim() === '1';
    } else if (a.ns === XSI_NS && a.local === 'type') {
      const [p, l] = a.value.trim().includes(':') ? a.value.trim().split(':', 2) : ['', a.value.trim()];
      node.xsiType = { ns: el.namespaces.get(p) ?? '', local: l };
    } else node.attributes.push({ name: { ns: a.ns, local: a.local }, value: a.value });
  }
  for (const c of el.children) {
    if (c.type === 'element') node.children.push(nodeFromXml(c));
    else if (c.type === 'text') node.children.push({ kind: 'text', value: c.value });
    else if (c.type === 'comment') node.children.push({ kind: 'comment', value: c.value });
  }
  return node;
}
