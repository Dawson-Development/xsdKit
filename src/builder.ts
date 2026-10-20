import { ElementNode, childElements } from './node.js';
import type { Schema } from './schema.js';
import { SerializeOptions } from './serializer.js';
import { ValidationResult, XsdValidationError, contentDecls, displayName } from './validator.js';
import {
  AttributeUse,
  ElementDecl,
  QName,
  SimpleType,
  TypeDef,
  XSI_NS,
  describeWildcard,
  isDerivedFrom,
  qkey,
  typeName,
  wildcardAllows,
} from './xsd/model.js';
import { checkSimple, formatValue, normalizeFor, varietyOf } from './xsd/simple.js';

export class XmlBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'XmlBuildError';
  }
}

export interface ToXmlOptions extends SerializeOptions {
  /** Validate the whole document against the schema before serializing (default: true). */
  validate?: boolean;
}

/** A value accepted by the builder: scalars are converted using the schema type, objects build child content. */
export type XmlValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | Uint8Array
  | null
  | undefined
  | XmlValue[]
  | { [key: string]: XmlValue };

interface ResolvedChild {
  name: QName;
  decl?: ElementDecl;
  type: TypeDef;
}

function isPlainObject(v: unknown): v is Record<string, XmlValue> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date) &&
    !(v instanceof Uint8Array) &&
    !(v instanceof Set)
  );
}

function simpleTypeOf(t: TypeDef): SimpleType | undefined {
  return t.kind === 'simple' ? t : t.content === 'simple' ? t.simpleType : undefined;
}

/**
 * Schema-aware fluent builder for a single element. Every name and value is checked against
 * the XSD as you go; structure (order, occurrences, required attributes) is checked by
 * validate() / toXml().
 */
export class XmlBuilder {
  /** @internal */
  constructor(
    readonly schema: Schema,
    readonly node: ElementNode,
    private readonly parent: XmlBuilder | null,
  ) {}

  /** Local name of this element. */
  get name(): string {
    return this.node.name.local;
  }

  /** Namespace URI of this element ('' when unqualified). */
  get namespace(): string {
    return this.node.name.ns;
  }

  /** Name of the element's (effective) schema type. */
  get typeName(): string {
    return typeName(this.type);
  }

  private get type(): TypeDef {
    return this.node.type ?? this.schema.set.anyType;
  }

  private fail(msg: string): never {
    throw new XmlBuildError(`<${this.name}>: ${msg}`);
  }

  // ---------- children ----------

  /** Adds a child element and returns the child builder (call .up() to come back). */
  element(name: string): XmlBuilder;
  /** Adds a child element, configures it with the callback, and returns this builder. */
  element(name: string, build: (child: XmlBuilder) => void): this;
  /** Adds a child element with a value (scalar, object or null for xsi:nil) and returns this builder. */
  element(name: string, value: XmlValue): this;
  element(name: string, arg?: ((child: XmlBuilder) => void) | XmlValue): XmlBuilder {
    const child = this.appendChild(this.resolveChild(name));
    if (typeof arg === 'function') {
      arg(child);
      return this;
    }
    if (arg !== undefined) {
      child.value(arg);
      return this;
    }
    return child;
  }

  /** Alias of element(). */
  ele(name: string): XmlBuilder;
  ele(name: string, build: (child: XmlBuilder) => void): this;
  ele(name: string, value: XmlValue): this;
  ele(name: string, arg?: ((child: XmlBuilder) => void) | XmlValue): XmlBuilder {
    return this.element(name, arg as XmlValue);
  }

  /**
   * Adds child element(s) with a value and returns this builder.
   * Arrays create repeated elements (except for xs:list typed elements, which get one space-separated value).
   */
  set(name: string, value: XmlValue): this {
    if (value === undefined) return this;
    const resolved = this.resolveChild(name);
    if (Array.isArray(value)) {
      const st = simpleTypeOf(resolved.type);
      const isList = st && varietyOf(st) === 'list' && !value.some((v) => Array.isArray(v) || isPlainObject(v));
      if (!isList) {
        for (const v of value) this.appendChild(resolved).value(v);
        return this;
      }
    }
    this.appendChild(resolved).value(value);
    return this;
  }

  /** Sets this element's content from a JS value: null => xsi:nil, object => assign(), otherwise text(). */
  value(v: XmlValue): this {
    if (v === undefined) return this;
    if (v === null) return this.nil();
    if (isPlainObject(v)) return this.assign(v);
    return this.text(v);
  }

  /**
   * Populates attributes and children from an object:
   * `{ '@attr': 1, '#text': 'x', child: 'value', repeated: [1, 2], nested: { ... } }`.
   * Children are emitted in schema order regardless of key order.
   */
  assign(obj: Record<string, XmlValue>): this {
    const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
    const typeEntry = entries.find(([k]) => k === '@xsi:type');
    if (typeEntry) this.xsiType(String(typeEntry[1]));
    const nilEntry = entries.find(([k]) => k === '@xsi:nil');
    if (nilEntry && (nilEntry[1] === true || nilEntry[1] === 'true')) return this.nil();
    for (const [k, v] of entries) {
      if (k.startsWith('@') && k !== '@xsi:type' && k !== '@xsi:nil') this.attr(k.slice(1), v);
    }
    for (const [k, v] of entries) if (k === '#text' || k === '$text') this.text(v);
    const order = new Map<string, number>();
    contentDecls(this.type.kind === 'complex' ? this.type.particle : undefined).decls.forEach((d, i) => {
      if (!order.has(d.name.local)) order.set(d.name.local, i);
    });
    const rank = (k: string) => order.get(k.includes(':') ? k.slice(k.indexOf(':') + 1) : k.replace(/^\{[^}]*\}/, '')) ?? Infinity;
    const kids = entries.filter(([k]) => !k.startsWith('@') && k !== '#text' && k !== '$text');
    kids.sort((a, b) => rank(a[0]) - rank(b[0]));
    for (const [k, v] of kids) this.set(k, v);
    return this;
  }

  private resolveChild(name: string): ResolvedChild {
    const t = this.type;
    if (this.node.nil) this.fail('cannot add children to a nil element');
    if (t.kind === 'simple' || t.content === 'simple') {
      this.fail(`has simple content (${typeName(simpleTypeOf(t))}); use .text() instead of adding <${name}>`);
    }
    if (t.content === 'empty') this.fail(`must be empty; it cannot contain <${name}>`);
    const ref = this.schema.parseName(name);
    const { decls, wildcards } = contentDecls(t.particle);
    const matches = decls.filter((d) => d.name.local === ref.local && (ref.ns === undefined || d.name.ns === ref.ns));
    if (matches.length === 1) return { name: matches[0].name, decl: matches[0], type: matches[0].type };
    if (matches.length > 1) {
      this.fail(`"${name}" is ambiguous; qualify it with a namespace, e.g. "{${matches[0].name.ns}}${ref.local}"`);
    }
    if (wildcards.length) {
      const globals = [...this.schema.set.elements.values()].filter(
        (d) =>
          !d.abstract &&
          d.name.local === ref.local &&
          (ref.ns === undefined || d.name.ns === ref.ns) &&
          wildcards.some((w) => wildcardAllows(w, d.name.ns)),
      );
      if (globals.length === 1) return { name: globals[0].name, decl: globals[0], type: globals[0].type };
      const ns = ref.ns ?? '';
      const wc = wildcards.find((w) => wildcardAllows(w, ns));
      if (wc && wc.process !== 'strict' && globals.length === 0) {
        return { name: { ns, local: ref.local }, type: this.schema.set.anyType };
      }
    }
    const allowed = this.allowedChildren();
    this.fail(`<${name}> is not allowed here. Allowed child elements: ${allowed.length ? allowed.join(', ') : '(none)'}`);
  }

  private appendChild(r: ResolvedChild): XmlBuilder {
    const node: ElementNode = {
      kind: 'element',
      name: r.name,
      attributes: [],
      children: [],
      nil: false,
      decl: r.decl,
      type: r.type,
    };
    this.insertChild(node);
    return new XmlBuilder(this.schema, node, this);
  }

  /**
   * Places a new child at its schema position so the fluent API is order-independent.
   * Falls back to appending when the content model is mixed or order is ambiguous (repeating groups).
   */
  private insertChild(node: ElementNode): void {
    const t = this.type;
    const kids = this.node.children;
    if (t.kind !== 'complex' || t.mixed) return void kids.push(node);
    const cd = contentDecls(t.particle);
    if (!cd.orderable) return void kids.push(node);
    const rankOf = (n: ElementNode) => cd.rank.get(qkey(n.name)) ?? cd.wildcardRank;
    const r = rankOf(node);
    const at = kids.findIndex((c) => c.kind === 'element' && rankOf(c) > r);
    if (at < 0) kids.push(node);
    else kids.splice(at, 0, node);
  }

  // ---------- content ----------

  /** Sets the text value. For simple content the value is converted and checked against the type. */
  text(value: XmlValue): this {
    if (value === undefined) return this;
    if (this.node.nil) this.fail('cannot set text on a nil element');
    const t = this.type;
    const st = simpleTypeOf(t);
    if (st) {
      let s: string;
      try {
        s = formatValue(st, value);
      } catch (e) {
        this.fail(`cannot convert value: ${(e as Error).message}`);
      }
      const e = checkSimple(st, s);
      if (e) this.fail(`invalid value for type ${typeName(st)}: ${e}`);
      const fixed = this.node.decl?.fixed;
      if (fixed !== undefined && normalizeFor(st, s) !== normalizeFor(st, fixed)) this.fail(`value must be "${fixed}" (fixed)`);
      this.node.children = this.node.children.filter((c) => c.kind !== 'text');
      this.node.children.push({ kind: 'text', value: s });
      return this;
    }
    if (t.kind === 'complex' && t.mixed) {
      const s = value instanceof Date ? value.toISOString() : String(value);
      this.node.children.push({ kind: 'text', value: s });
      return this;
    }
    this.fail(
      t.kind === 'complex' && t.content === 'empty'
        ? 'must be empty; text is not allowed'
        : 'has element-only content; text is not allowed (use .element() or .set() to add children)',
    );
  }

  /** Alias of text(). */
  txt(value: XmlValue): this {
    return this.text(value);
  }

  /** Sets an attribute. The value is converted and checked against the attribute's type. null/undefined removes it. */
  attr(name: string, value: XmlValue): this {
    if (name === 'xsi:nil') return value === true || value === 'true' ? this.nil() : this;
    if (name === 'xsi:type') return this.xsiType(String(value));
    const ref = this.schema.parseName(name);
    const t = this.type;
    const uses = t.kind === 'complex' ? t.attributes : [];
    const candidates = uses.filter((u) => u.name.local === ref.local && (ref.ns === undefined || u.name.ns === ref.ns));
    let use: AttributeUse | undefined = candidates[0];
    let qname: QName | undefined = use?.name;
    if (candidates.length > 1) this.fail(`attribute "${name}" is ambiguous; qualify it with a namespace`);
    if (!use) {
      const any = t.kind === 'complex' ? t.anyAttribute : undefined;
      const ns = ref.ns ?? '';
      if (any && wildcardAllows(any, ns)) {
        qname = { ns, local: ref.local };
        use = this.schema.set.attributes.get(qkey(qname));
        if (!use && any.process === 'strict') this.fail(`no global declaration for wildcard attribute "${name}"`);
      } else {
        const allowed = this.allowedAttributes();
        this.fail(
          `attribute "${name}" is not allowed. ${allowed.length ? `Allowed attributes: ${allowed.join(', ')}` : 'This element has no attributes.'}` +
            (any ? ` Attributes from ${describeWildcard(any)} are also accepted (use "{namespace}name").` : ''),
        );
      }
    }
    this.node.attributes = this.node.attributes.filter((a) => !(a.name.ns === qname!.ns && a.name.local === qname!.local));
    if (value === null || value === undefined) return this;
    let s: string;
    if (use) {
      try {
        s = formatValue(use.type, value);
      } catch (e) {
        this.fail(`cannot convert value for attribute "${name}": ${(e as Error).message}`);
      }
      const e = checkSimple(use.type, s);
      if (e) this.fail(`invalid value for attribute "${name}" (${typeName(use.type)}): ${e}`);
      if (use.fixed !== undefined && normalizeFor(use.type, s) !== normalizeFor(use.type, use.fixed)) {
        this.fail(`attribute "${name}" must have the fixed value "${use.fixed}"`);
      }
    } else s = value instanceof Date ? value.toISOString() : String(value);
    this.node.attributes.push({ name: qname!, value: s });
    return this;
  }

  /** Sets several attributes at once. */
  attrs(values: Record<string, XmlValue>): this {
    for (const [k, v] of Object.entries(values)) this.attr(k, v);
    return this;
  }

  /** Marks the element as xsi:nil="true" (the element must be declared nillable). */
  nil(): this {
    if (!this.node.decl?.nillable) this.fail('is not nillable');
    if (this.node.children.some((c) => c.kind !== 'comment')) this.fail('cannot be nil because it already has content');
    this.node.nil = true;
    return this;
  }

  /** Selects a derived type with xsi:type. Subsequent children/attributes are resolved against that type. */
  xsiType(name: string): this {
    const t = this.schema.findType(name);
    if (!t || !t.name) this.fail(`unknown type "${name}"`);
    const declared = this.node.decl?.type ?? this.schema.set.anyType;
    if (!isDerivedFrom(t, declared)) this.fail(`type "${name}" is not derived from "${typeName(declared)}"`);
    this.node.xsiType = t.name;
    this.node.type = t;
    return this;
  }

  /** Adds an XML comment. */
  comment(text: string): this {
    this.node.children.push({ kind: 'comment', value: text });
    return this;
  }

  // ---------- navigation ----------

  /** Returns the parent element's builder. */
  up(): XmlBuilder {
    if (!this.parent) throw new XmlBuildError(`<${this.name}> is the root element; there is no parent`);
    return this.parent;
  }

  /** Returns the root element's builder. */
  root(): XmlBuilder {
    let b: XmlBuilder = this;
    while (b.parent) b = b.parent;
    return b;
  }

  /** Returns builders for existing child elements, optionally filtered by local name. */
  children(name?: string): XmlBuilder[] {
    return childElements(this.node)
      .filter((c) => name === undefined || c.name.local === name)
      .map((c) => new XmlBuilder(this.schema, c, this));
  }

  // ---------- introspection ----------

  /** Names of the child elements the schema allows here. */
  allowedChildren(): string[] {
    const t = this.type;
    if (t.kind !== 'complex') return [];
    const { decls, wildcards } = contentDecls(t.particle);
    return [...decls.map((d) => displayName(d.name)), ...wildcards.map((w) => `*(${describeWildcard(w)})`)];
  }

  /** Names of the attributes the schema allows here (required ones are suffixed with "!"). */
  allowedAttributes(): string[] {
    const t = this.type;
    if (t.kind !== 'complex') return [];
    return t.attributes.map((a) => displayName(a.name) + (a.required ? '!' : ''));
  }

  // ---------- output ----------

  /** Validates the whole document (from the root). */
  validate(): ValidationResult {
    return this.schema.validateNode(this.root().node);
  }

  /** Serializes the whole document (from the root). Throws XsdValidationError when invalid, unless validate: false. */
  toXml(options: ToXmlOptions = {}): string {
    const root = this.root().node;
    if (options.validate !== false) {
      const r = this.schema.validateNode(root);
      if (!r.valid) throw new XsdValidationError(r.errors);
    }
    return this.schema.serialize(root, options);
  }

  /** Serializes without validation. */
  toString(options: SerializeOptions = {}): string {
    return this.toXml({ ...options, validate: false });
  }
}
