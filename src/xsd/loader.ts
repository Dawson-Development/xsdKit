import { parentPath, readText, resolvePath } from '#platform';
import { XmlElement, XmlParseError, parseXml, splitQName } from '../xml/parser.js';
import {
  AttributeUse,
  ComplexType,
  ElementDecl,
  Facets,
  Particle,
  QName,
  SimpleType,
  TypeDef,
  Wildcard,
  XML_NS,
  XS_NS,
  qkey,
} from './model.js';
import { compileFacetPattern, getBuiltinSimpleType } from './simple.js';

export interface ResolvedSchema {
  /** Unique identifier for the document (normally an absolute path); used as the base for relative locations. */
  id: string;
  content: string;
}

/** Resolves a schemaLocation (from xs:include/xs:import) relative to the including document. */
export type SchemaResolver = (location: string, baseId: string | undefined) => ResolvedSchema;

export interface LoadOptions {
  resolver?: SchemaResolver;
}

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

export const fileResolver: SchemaResolver = (location, baseId) => {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(location) && !location.startsWith('file:')) {
    throw new SchemaError(`Cannot load remote schema "${location}"; supply a custom "resolver" option to handle it.`);
  }
  const loc = location.startsWith('file:') ? new URL(location).pathname : location;
  const p = resolvePath(loc, baseId ? parentPath(baseId) : undefined);
  return { id: p, content: readText(p) };
};

export interface SchemaSet {
  elements: Map<string, ElementDecl>;
  types: Map<string, TypeDef>;
  attributes: Map<string, AttributeUse>;
  /** Namespace URI -> preferred prefix (taken from the schema documents). */
  prefixes: Map<string, string>;
  targetNamespaces: string[];
  documents: string[];
  anyType: ComplexType;
}

interface DocCtx {
  tns: string;
  elementQualified: boolean;
  attributeQualified: boolean;
  id: string;
  chameleon: boolean;
}

interface Raw {
  node: XmlElement;
  doc: DocCtx;
}

interface AttrCollection {
  uses: AttributeUse[];
  prohibited: string[];
  any?: Wildcard;
}

const xsChildren = (n: XmlElement): XmlElement[] =>
  n.children.filter((c): c is XmlElement => c.type === 'element' && c.ns === XS_NS && c.local !== 'annotation');

const attr = (n: XmlElement, name: string): string | undefined =>
  n.attributes.find((a) => a.ns === '' && a.local === name)?.value;

function documentation(n: XmlElement): string | undefined {
  const ann = n.children.find((c): c is XmlElement => c.type === 'element' && c.ns === XS_NS && c.local === 'annotation');
  if (!ann) return undefined;
  const texts: string[] = [];
  for (const d of ann.children) {
    if (d.type === 'element' && d.local === 'documentation') {
      const t = d.children
        .map((c) => (c.type === 'text' ? c.value : ''))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
      if (t) texts.push(t);
    }
  }
  return texts.length ? texts.join('\n') : undefined;
}

export function createAnyType(): ComplexType {
  const wildcard: Wildcard = { mode: 'any', namespaces: [], targetNamespace: '', process: 'lax' };
  return {
    kind: 'complex',
    name: { ns: XS_NS, local: 'anyType' },
    abstract: false,
    mixed: true,
    attributes: [],
    anyAttribute: wildcard,
    content: 'element',
    particle: { kind: 'any', wildcard, min: 0, max: Infinity },
  };
}

function xmlAttribute(local: string): AttributeUse | undefined {
  const name = { ns: XML_NS, local };
  const b = (n: string) => getBuiltinSimpleType(n)!;
  switch (local) {
    case 'lang':
      return { name, type: b('string'), required: false };
    case 'space':
      return { name, type: { kind: 'simple', base: b('NCName'), facets: { enumeration: ['default', 'preserve'] } }, required: false };
    case 'base':
      return { name, type: b('anyURI'), required: false };
    case 'id':
      return { name, type: b('ID'), required: false };
    default:
      return undefined;
  }
}

export function loadSchemaSet(content: string, id: string, options: LoadOptions = {}): SchemaSet {
  const loader = new Loader(options.resolver ?? fileResolver);
  loader.loadDocument(content, id, undefined);
  return loader.finish();
}

class Loader {
  private readonly raw = {
    element: new Map<string, Raw>(),
    type: new Map<string, Raw>(),
    group: new Map<string, Raw>(),
    attributeGroup: new Map<string, Raw>(),
    attribute: new Map<string, Raw>(),
  };
  private readonly loaded = new Set<string>();
  private readonly documents: string[] = [];
  private readonly prefixes = new Map<string, string>();
  private readonly tns = new Set<string>();
  private readonly anyType = createAnyType();

  private readonly elements = new Map<string, ElementDecl>();
  private readonly types = new Map<string, TypeDef>();
  private readonly groups = new Map<string, Particle>();
  private readonly attrGroups = new Map<string, AttrCollection>();
  private readonly attributes = new Map<string, AttributeUse>();
  private readonly building = new Set<string>();

  constructor(private readonly resolver: SchemaResolver) {}

  private fail(msg: string, node?: XmlElement, doc?: DocCtx): never {
    const where = doc ? ` [${doc.id}${node ? `:${node.line}` : ''}]` : '';
    throw new SchemaError(msg + where);
  }

  loadDocument(content: string, id: string, chameleonTns: string | undefined): void {
    const key = `${id}|${chameleonTns ?? ''}`;
    if (this.loaded.has(key)) return;
    this.loaded.add(key);
    this.documents.push(id);

    let root: XmlElement;
    try {
      root = parseXml(content, id).root;
    } catch (e) {
      if (e instanceof XmlParseError) throw new SchemaError(`Malformed schema document: ${e.message}`);
      throw e;
    }
    if (root.ns !== XS_NS || root.local !== 'schema') {
      throw new SchemaError(`${id} is not an XML Schema document (root element is <${root.qname}>)`);
    }
    const declared = attr(root, 'targetNamespace');
    if (chameleonTns !== undefined && declared !== undefined && declared !== chameleonTns) {
      throw new SchemaError(
        `Included schema ${id} has targetNamespace "${declared}" but the including schema uses "${chameleonTns}"`,
      );
    }
    const ctx: DocCtx = {
      tns: declared ?? chameleonTns ?? '',
      elementQualified: attr(root, 'elementFormDefault') === 'qualified',
      attributeQualified: attr(root, 'attributeFormDefault') === 'qualified',
      id,
      chameleon: declared === undefined && !!chameleonTns,
    };
    if (ctx.tns) this.tns.add(ctx.tns);
    for (const [p, ns] of root.namespaces) {
      if (p && p !== 'xml' && ns !== XS_NS && !this.prefixes.has(ns)) this.prefixes.set(ns, p);
    }

    for (const child of xsChildren(root)) {
      switch (child.local) {
        case 'include':
        case 'redefine':
        case 'override': {
          const loc = attr(child, 'schemaLocation');
          if (!loc) this.fail(`<xs:${child.local}> requires schemaLocation`, child, ctx);
          const r = this.resolve(loc, ctx, child);
          this.loadDocument(r.content, r.id, ctx.tns);
          break;
        }
        case 'import': {
          const loc = attr(child, 'schemaLocation');
          const ns = attr(child, 'namespace');
          if (!loc) break;
          if (ns === XML_NS) break;
          const r = this.resolve(loc, ctx, child);
          this.loadDocument(r.content, r.id, undefined);
          break;
        }
        case 'element':
        case 'simpleType':
        case 'complexType':
        case 'group':
        case 'attributeGroup':
        case 'attribute': {
          const name = attr(child, 'name');
          if (!name) this.fail(`Top-level <xs:${child.local}> must have a name`, child, ctx);
          const kind = child.local === 'simpleType' || child.local === 'complexType' ? 'type' : child.local;
          const map = this.raw[kind as keyof Loader['raw']];
          const k = qkey({ ns: ctx.tns, local: name });
          if (map.has(k)) this.fail(`Duplicate ${kind} definition "${name}"`, child, ctx);
          map.set(k, { node: child, doc: ctx });
          break;
        }
        default:
          break;
      }
    }
  }

  private resolve(loc: string, ctx: DocCtx, node: XmlElement) {
    try {
      return this.resolver(loc, ctx.id);
    } catch (e) {
      this.fail(`Cannot load schema "${loc}": ${(e as Error).message}`, node, ctx);
    }
  }

  finish(): SchemaSet {
    for (const k of this.raw.type.keys()) this.lookupType(k);
    for (const k of this.raw.element.keys()) this.lookupElement(k);
    for (const k of this.raw.attribute.keys()) this.lookupAttribute(k);
    for (const k of this.raw.group.keys()) this.lookupGroup(k);
    for (const k of this.raw.attributeGroup.keys()) this.lookupAttrGroup(k);
    for (const decl of this.elements.values()) {
      for (let h = decl.substitutionGroup; h; h = h.substitutionGroup) {
        if (h === decl) break;
        h.substitutes.push(decl);
      }
    }
    return {
      elements: this.elements,
      types: this.types,
      attributes: this.attributes,
      prefixes: this.prefixes,
      targetNamespaces: [...this.tns],
      documents: this.documents,
      anyType: this.anyType,
    };
  }

  private qname(value: string, node: XmlElement, doc: DocCtx): QName {
    const [p, local] = splitQName(value.trim());
    const ns = node.namespaces.get(p);
    if (p && ns === undefined) this.fail(`Undeclared namespace prefix "${p}" in "${value}"`, node, doc);
    let resolved = ns ?? '';
    if (resolved === '' && doc.chameleon) resolved = doc.tns;
    return { ns: resolved, local };
  }

  // ---------- types ----------

  private getType(q: QName, node: XmlElement, doc: DocCtx): TypeDef {
    if (q.ns === XS_NS) {
      if (q.local === 'anyType') return this.anyType;
      const b = getBuiltinSimpleType(q.local);
      if (!b) this.fail(`Unknown built-in type "xs:${q.local}"`, node, doc);
      return b;
    }
    const t = this.lookupType(qkey(q));
    if (!t) this.fail(`Unknown type "${q.local}"${q.ns ? ` in namespace "${q.ns}"` : ''}`, node, doc);
    return t;
  }

  private lookupType(key: string): TypeDef | undefined {
    const cached = this.types.get(key);
    if (cached) return cached;
    const raw = this.raw.type.get(key);
    if (!raw) return undefined;
    const name = { ns: raw.doc.tns, local: attr(raw.node, 'name')! };
    return raw.node.local === 'simpleType'
      ? this.buildSimple(raw.node, raw.doc, name)
      : this.buildComplex(raw.node, raw.doc, name);
  }

  private getSimpleType(value: string, node: XmlElement, doc: DocCtx): SimpleType {
    const t = this.getType(this.qname(value, node, doc), node, doc);
    if (t.kind !== 'simple') this.fail(`"${value}" is a complex type; a simple type is required here`, node, doc);
    return t;
  }

  private inline(node: XmlElement, local: 'simpleType' | 'complexType'): XmlElement | undefined {
    return xsChildren(node).find((c) => c.local === local);
  }

  private buildSimple(node: XmlElement, doc: DocCtx, name?: QName): SimpleType {
    const t: SimpleType = { kind: 'simple', name, facets: {}, documentation: documentation(node) };
    if (name) this.types.set(qkey(name), t);
    const def = xsChildren(node).find((c) => ['restriction', 'list', 'union'].includes(c.local));
    if (!def) this.fail('<xs:simpleType> must contain restriction, list or union', node, doc);
    if (def.local === 'restriction') {
      const base = attr(def, 'base');
      const inl = this.inline(def, 'simpleType');
      if (base) t.base = this.getSimpleType(base, def, doc);
      else if (inl) t.base = this.buildSimple(inl, doc);
      else this.fail('<xs:restriction> needs a base', def, doc);
      t.facets = this.facets(def, doc);
    } else if (def.local === 'list') {
      const item = attr(def, 'itemType');
      const inl = this.inline(def, 'simpleType');
      if (item) t.itemType = this.getSimpleType(item, def, doc);
      else if (inl) t.itemType = this.buildSimple(inl, doc);
      else this.fail('<xs:list> needs an itemType', def, doc);
    } else {
      const members = (attr(def, 'memberTypes') ?? '').split(/\s+/).filter(Boolean);
      t.memberTypes = [
        ...members.map((m) => this.getSimpleType(m, def, doc)),
        ...xsChildren(def)
          .filter((c) => c.local === 'simpleType')
          .map((c) => this.buildSimple(c, doc)),
      ];
      if (t.memberTypes.length === 0) this.fail('<xs:union> has no member types', def, doc);
    }
    return t;
  }

  private facets(def: XmlElement, doc: DocCtx): Facets {
    const f: Facets = {};
    for (const c of xsChildren(def)) {
      const value = attr(c, 'value');
      if (value === undefined) continue;
      const num = () => {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0) this.fail(`Facet ${c.local} must be a non-negative integer`, c, doc);
        return n;
      };
      switch (c.local) {
        case 'enumeration':
          (f.enumeration ??= []).push(value);
          break;
        case 'pattern':
          try {
            const p = compileFacetPattern(value);
            (f.patterns ??= []).push({ source: value, regex: p.regex });
          } catch (e) {
            this.fail((e as Error).message, c, doc);
          }
          break;
        case 'length':
        case 'minLength':
        case 'maxLength':
        case 'totalDigits':
        case 'fractionDigits':
          f[c.local] = num();
          break;
        case 'whiteSpace':
          if (value !== 'preserve' && value !== 'replace' && value !== 'collapse') {
            this.fail(`Invalid whiteSpace value "${value}"`, c, doc);
          }
          f.whiteSpace = value;
          break;
        case 'minInclusive':
        case 'minExclusive':
        case 'maxInclusive':
        case 'maxExclusive':
          f[c.local] = value.trim();
          break;
        default:
          break;
      }
    }
    return f;
  }

  private buildComplex(node: XmlElement, doc: DocCtx, name?: QName): ComplexType {
    const ct: ComplexType = {
      kind: 'complex',
      name,
      abstract: attr(node, 'abstract') === 'true',
      mixed: attr(node, 'mixed') === 'true',
      attributes: [],
      content: 'empty',
      documentation: documentation(node),
    };
    if (name) this.types.set(qkey(name), ct);

    const kids = xsChildren(node);
    const sc = kids.find((c) => c.local === 'simpleContent');
    const cc = kids.find((c) => c.local === 'complexContent');
    let particle: Particle | undefined;

    if (sc || cc) {
      const holder = (sc ?? cc)!;
      const der = xsChildren(holder).find((c) => c.local === 'extension' || c.local === 'restriction');
      if (!der) this.fail(`<xs:${holder.local}> must contain extension or restriction`, holder, doc);
      const baseName = attr(der, 'base');
      if (!baseName) this.fail(`<xs:${der.local}> needs a base`, der, doc);
      const base = this.getType(this.qname(baseName, der, doc), der, doc);
      ct.base = base;
      ct.derivation = der.local as 'extension' | 'restriction';
      const own = this.collectAttributes(der, doc);
      const baseAttrs = base.kind === 'complex' ? base.attributes : [];
      const isAnyType = base === this.anyType;

      if (sc) {
        ct.content = 'simple';
        const baseSimple = base.kind === 'simple' ? base : base.simpleType ?? getBuiltinSimpleType('string')!;
        if (der.local === 'extension') ct.simpleType = baseSimple;
        else {
          const inl = this.inline(der, 'simpleType');
          const inner = inl ? this.buildSimple(inl, doc) : baseSimple;
          const facets = this.facets(der, doc);
          ct.simpleType = Object.keys(facets).length ? { kind: 'simple', base: inner, facets } : inner;
        }
        ct.attributes = mergeAttributes(baseAttrs, own);
        ct.anyAttribute = own.any ?? (der.local === 'extension' && base.kind === 'complex' ? base.anyAttribute : undefined);
      } else {
        if (base.kind !== 'complex') this.fail(`complexContent base "${baseName}" must be a complex type`, der, doc);
        const mixedAttr = attr(holder, 'mixed');
        ct.mixed = mixedAttr !== undefined ? mixedAttr === 'true' : ct.mixed;
        const ownParticle = this.particleOf(der, doc);
        if (der.local === 'extension') {
          const baseParticle = base.content === 'element' && !isAnyType ? base.particle : undefined;
          particle =
            baseParticle && ownParticle
              ? { kind: 'sequence', items: [baseParticle, ownParticle], min: 1, max: 1 }
              : baseParticle ?? ownParticle;
          ct.mixed ||= base.mixed && !isAnyType;
          ct.attributes = mergeAttributes(baseAttrs, own);
          ct.anyAttribute = own.any ?? base.anyAttribute;
        } else {
          particle = ownParticle;
          ct.attributes = isAnyType ? mergeAttributes([], own) : mergeAttributes(baseAttrs, own);
          ct.anyAttribute = own.any;
        }
      }
    } else {
      particle = this.particleOf(node, doc);
      const own = this.collectAttributes(node, doc);
      ct.attributes = mergeAttributes([], own);
      ct.anyAttribute = own.any;
    }

    if (ct.content !== 'simple') {
      if (particle && isEmptyParticle(particle)) particle = undefined;
      ct.particle = particle;
      ct.content = particle || ct.mixed ? 'element' : 'empty';
    }
    return ct;
  }

  private collectAttributes(container: XmlElement, doc: DocCtx): AttrCollection {
    const out: AttrCollection = { uses: [], prohibited: [] };
    for (const c of xsChildren(container)) {
      if (c.local === 'attribute') {
        const r = this.attributeUse(c, doc);
        if ('prohibited' in r) out.prohibited.push(r.prohibited);
        else out.uses.push(r.use);
      } else if (c.local === 'attributeGroup') {
        const ref = attr(c, 'ref');
        if (!ref) this.fail('attributeGroup reference needs ref', c, doc);
        const q = this.qname(ref, c, doc);
        const g = this.lookupAttrGroup(qkey(q));
        if (!g) this.fail(`Unknown attributeGroup "${ref}"`, c, doc);
        out.uses.push(...g.uses);
        out.prohibited.push(...g.prohibited);
        out.any ??= g.any;
      } else if (c.local === 'anyAttribute') {
        out.any = this.wildcard(c, doc);
      }
    }
    return out;
  }

  private lookupAttrGroup(key: string): AttrCollection | undefined {
    const cached = this.attrGroups.get(key);
    if (cached) return cached;
    const raw = this.raw.attributeGroup.get(key);
    if (!raw) return undefined;
    if (this.building.has('ag:' + key)) this.fail(`Circular attributeGroup "${key}"`, raw.node, raw.doc);
    this.building.add('ag:' + key);
    const g = this.collectAttributes(raw.node, raw.doc);
    this.building.delete('ag:' + key);
    this.attrGroups.set(key, g);
    return g;
  }

  private attributeUse(n: XmlElement, doc: DocCtx): { use: AttributeUse } | { prohibited: string } {
    const use = attr(n, 'use') ?? 'optional';
    let name: QName;
    let type: SimpleType;
    let def = attr(n, 'default');
    let fixed = attr(n, 'fixed');
    let docs = documentation(n);
    const ref = attr(n, 'ref');
    if (ref) {
      const q = this.qname(ref, n, doc);
      const g = q.ns === XML_NS ? xmlAttribute(q.local) : this.lookupAttribute(qkey(q));
      if (!g) this.fail(`Unknown attribute "${ref}"`, n, doc);
      name = g.name;
      type = g.type;
      def ??= g.default;
      fixed ??= g.fixed;
      docs ??= g.documentation;
    } else {
      const local = attr(n, 'name');
      if (!local) this.fail('<xs:attribute> needs a name or ref', n, doc);
      const form = attr(n, 'form') ?? (doc.attributeQualified ? 'qualified' : 'unqualified');
      name = { ns: form === 'qualified' ? doc.tns : '', local };
      type = this.attributeType(n, doc);
    }
    if (use === 'prohibited') return { prohibited: qkey(name) };
    return { use: { name, type, required: use === 'required', default: def, fixed, documentation: docs } };
  }

  private attributeType(n: XmlElement, doc: DocCtx): SimpleType {
    const t = attr(n, 'type');
    if (t) return this.getSimpleType(t, n, doc);
    const inl = this.inline(n, 'simpleType');
    return inl ? this.buildSimple(inl, doc) : getBuiltinSimpleType('anySimpleType')!;
  }

  private lookupAttribute(key: string): AttributeUse | undefined {
    const cached = this.attributes.get(key);
    if (cached) return cached;
    const raw = this.raw.attribute.get(key);
    if (!raw) return undefined;
    const a: AttributeUse = {
      name: { ns: raw.doc.tns, local: attr(raw.node, 'name')! },
      type: getBuiltinSimpleType('anySimpleType')!,
      required: false,
      default: attr(raw.node, 'default'),
      fixed: attr(raw.node, 'fixed'),
      documentation: documentation(raw.node),
    };
    this.attributes.set(key, a);
    a.type = this.attributeType(raw.node, raw.doc);
    return a;
  }

  // ---------- particles ----------

  private particleOf(container: XmlElement, doc: DocCtx): Particle | undefined {
    const n = xsChildren(container).find((c) => ['sequence', 'choice', 'all', 'group'].includes(c.local));
    return n ? this.particle(n, doc) : undefined;
  }

  private occurs(n: XmlElement, doc: DocCtx): [number, number] {
    const minS = attr(n, 'minOccurs');
    const maxS = attr(n, 'maxOccurs');
    const min = minS === undefined ? 1 : Number(minS);
    const max = maxS === undefined ? 1 : maxS === 'unbounded' ? Infinity : Number(maxS);
    if (!Number.isInteger(min) || min < 0 || (max !== Infinity && (!Number.isInteger(max) || max < min))) {
      this.fail(`Invalid minOccurs/maxOccurs (${minS ?? 1}..${maxS ?? 1})`, n, doc);
    }
    return [min, max];
  }

  private particle(n: XmlElement, doc: DocCtx): Particle | undefined {
    const [min, max] = this.occurs(n, doc);
    switch (n.local) {
      case 'element':
        return { kind: 'element', decl: this.particleElement(n, doc), min, max };
      case 'any':
        return { kind: 'any', wildcard: this.wildcard(n, doc), min, max };
      case 'sequence':
      case 'choice':
      case 'all': {
        const items = xsChildren(n)
          .map((c) => this.particle(c, doc))
          .filter((p): p is Particle => !!p);
        return { kind: n.local, items, min, max };
      }
      case 'group': {
        const ref = attr(n, 'ref');
        if (!ref) this.fail('group reference needs ref', n, doc);
        const q = this.qname(ref, n, doc);
        const g = this.lookupGroup(qkey(q));
        if (!g) this.fail(`Unknown group "${ref}"`, n, doc);
        return { ...g, min, max } as Particle;
      }
      default:
        return undefined;
    }
  }

  private lookupGroup(key: string): Particle | undefined {
    const cached = this.groups.get(key);
    if (cached) return cached;
    const raw = this.raw.group.get(key);
    if (!raw) return undefined;
    if (this.building.has('g:' + key)) this.fail(`Circular group reference "${key}"`, raw.node, raw.doc);
    this.building.add('g:' + key);
    const inner = xsChildren(raw.node).find((c) => ['sequence', 'choice', 'all'].includes(c.local));
    if (!inner) this.fail('<xs:group> must contain sequence, choice or all', raw.node, raw.doc);
    const p = this.particle(inner, raw.doc)!;
    p.min = 1;
    p.max = 1;
    this.building.delete('g:' + key);
    this.groups.set(key, p);
    return p;
  }

  private wildcard(n: XmlElement, doc: DocCtx): Wildcard {
    const ns = (attr(n, 'namespace') ?? '##any').trim();
    const process = (attr(n, 'processContents') ?? 'strict') as Wildcard['process'];
    if (ns === '##any') return { mode: 'any', namespaces: [], targetNamespace: doc.tns, process };
    if (ns === '##other') return { mode: 'other', namespaces: [], targetNamespace: doc.tns, process };
    const namespaces = ns
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => (t === '##targetNamespace' ? doc.tns : t === '##local' ? '' : t));
    return { mode: 'list', namespaces, targetNamespace: doc.tns, process };
  }

  // ---------- elements ----------

  private lookupElement(key: string): ElementDecl | undefined {
    const cached = this.elements.get(key);
    if (cached) return cached;
    const raw = this.raw.element.get(key);
    if (!raw) return undefined;
    const { node, doc } = raw;
    const decl: ElementDecl = {
      name: { ns: doc.tns, local: attr(node, 'name')! },
      type: this.anyType,
      global: true,
      nillable: attr(node, 'nillable') === 'true',
      abstract: attr(node, 'abstract') === 'true',
      default: attr(node, 'default'),
      fixed: attr(node, 'fixed'),
      substitutes: [],
      documentation: documentation(node),
    };
    this.elements.set(key, decl);
    const sg = attr(node, 'substitutionGroup');
    if (sg) {
      const head = sg.trim().split(/\s+/)[0];
      const q = this.qname(head, node, doc);
      decl.substitutionGroup = this.lookupElement(qkey(q));
      if (!decl.substitutionGroup) this.fail(`Unknown substitutionGroup head "${head}"`, node, doc);
    }
    decl.type = this.elementType(node, doc, decl);
    return decl;
  }

  private particleElement(n: XmlElement, doc: DocCtx): ElementDecl {
    const ref = attr(n, 'ref');
    if (ref) {
      const q = this.qname(ref, n, doc);
      const d = this.lookupElement(qkey(q));
      if (!d) this.fail(`Unknown element "${ref}"`, n, doc);
      return d;
    }
    const local = attr(n, 'name');
    if (!local) this.fail('<xs:element> needs a name or ref', n, doc);
    const form = attr(n, 'form') ?? (doc.elementQualified ? 'qualified' : 'unqualified');
    const decl: ElementDecl = {
      name: { ns: form === 'qualified' ? doc.tns : '', local },
      type: this.anyType,
      global: false,
      nillable: attr(n, 'nillable') === 'true',
      abstract: false,
      default: attr(n, 'default'),
      fixed: attr(n, 'fixed'),
      substitutes: [],
      documentation: documentation(n),
    };
    decl.type = this.elementType(n, doc, decl);
    return decl;
  }

  private elementType(n: XmlElement, doc: DocCtx, decl: ElementDecl): TypeDef {
    const t = attr(n, 'type');
    if (t) return this.getType(this.qname(t, n, doc), n, doc);
    const ct = this.inline(n, 'complexType');
    if (ct) return this.buildComplex(ct, doc);
    const st = this.inline(n, 'simpleType');
    if (st) return this.buildSimple(st, doc);
    if (decl.substitutionGroup) return decl.substitutionGroup.type;
    return this.anyType;
  }
}

function mergeAttributes(base: AttributeUse[], own: AttrCollection): AttributeUse[] {
  const map = new Map<string, AttributeUse>();
  for (const a of base) map.set(qkey(a.name), a);
  for (const k of own.prohibited) map.delete(k);
  for (const a of own.uses) map.set(qkey(a.name), a);
  return [...map.values()];
}

function isEmptyParticle(p: Particle): boolean {
  if (p.max === 0) return true;
  if (p.kind === 'sequence' || p.kind === 'choice' || p.kind === 'all') return p.items.every(isEmptyParticle);
  return false;
}
