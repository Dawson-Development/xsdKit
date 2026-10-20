import { readText, resolvePath } from '#platform';
import { XmlBuilder } from './builder.js';
import { ElementInfo, describeElement, renderTree } from './describe.js';
import { ElementNode } from './node.js';
import { SampleGenerator, SampleOptions } from './sample.js';
import { SerializeOptions, serialize } from './serializer.js';
import { ValidationResult, Validator, displayName, nodeFromXml } from './validator.js';
import { XmlParseError, parseXml } from './xml/parser.js';
import { LoadOptions, SchemaError, SchemaSet, loadSchemaSet } from './xsd/loader.js';
import { ElementDecl, QName, TypeDef, XML_NS, XSI_NS, XS_NS, qkey, typeName } from './xsd/model.js';
import { getBuiltinSimpleType } from './xsd/simple.js';

export interface ParseSchemaOptions extends LoadOptions {
  /** Directory used to resolve relative xs:include/xs:import locations (default: process.cwd()). */
  baseDir?: string;
}

export interface NameRef {
  ns?: string;
  local: string;
}

/** A compiled XML Schema (one or more XSD documents). */
export class Schema {
  private readonly prefixToNs = new Map<string, string>([
    ['xs', XS_NS],
    ['xsd', XS_NS],
    ['xsi', XSI_NS],
    ['xml', XML_NS],
  ]);

  /** @internal */
  constructor(readonly set: SchemaSet) {
    for (const [ns, p] of set.prefixes) if (!this.prefixToNs.has(p)) this.prefixToNs.set(p, ns);
  }

  /** Loads an XSD file (and everything it includes/imports). */
  static load(file: string, options: LoadOptions = {}): Schema {
    const id = resolvePath(file);
    return new Schema(loadSchemaSet(readText(id), id, options));
  }

  /** Parses XSD text. Relative includes/imports resolve against options.baseDir. */
  static parse(xsd: string, options: ParseSchemaOptions = {}): Schema {
    const id = resolvePath('<inline>.xsd', options.baseDir);
    return new Schema(loadSchemaSet(xsd, id, options));
  }

  /** Target namespace of the main schema document ('' when none). */
  get targetNamespace(): string {
    return this.set.targetNamespaces[0] ?? '';
  }

  /** All schema documents that were loaded. */
  get documents(): string[] {
    return [...this.set.documents];
  }

  /** Names of global elements (candidates for a document root). */
  get elementNames(): string[] {
    return [...this.set.elements.values()].map((d) => this.display(d.name));
  }

  /** Names of global (named) types. */
  get typeNames(): string[] {
    return [...this.set.types.values()].filter((t) => t.name).map((t) => this.display(t.name!));
  }

  /** Registers a prefix that can be used in names passed to the builder, e.g. "po:order". */
  registerPrefix(prefix: string, namespace: string): this {
    this.prefixToNs.set(prefix, namespace);
    return this;
  }

  private display(q: QName): string {
    const dupes = [...this.set.elements.values()].filter((d) => d.name.local === q.local).length > 1;
    if (!dupes || !q.ns) return q.local;
    const p = this.set.prefixes.get(q.ns);
    return p ? `${p}:${q.local}` : `{${q.ns}}${q.local}`;
  }

  /** Parses "local", "prefix:local" or "{namespace}local". */
  parseName(name: string): NameRef {
    const clark = /^\{([^}]*)\}(.+)$/.exec(name);
    if (clark) return { ns: clark[1], local: clark[2] };
    const i = name.indexOf(':');
    if (i < 0) return { local: name };
    const prefix = name.slice(0, i);
    const ns = this.prefixToNs.get(prefix);
    if (ns === undefined) {
      throw new SchemaError(`Unknown namespace prefix "${prefix}" in "${name}". Use registerPrefix() or "{namespace}local".`);
    }
    return { ns, local: name.slice(i + 1) };
  }

  /** Looks up a global element declaration. */
  getElement(name: string): ElementDecl {
    const ref = this.parseName(name);
    const found = [...this.set.elements.values()].filter(
      (d) => d.name.local === ref.local && (ref.ns === undefined || d.name.ns === ref.ns),
    );
    if (found.length === 1) return found[0];
    if (found.length > 1) {
      throw new SchemaError(`Element name "${name}" is ambiguous; use "{namespace}${ref.local}" or a prefix.`);
    }
    const all = this.elementNames;
    throw new SchemaError(`Unknown global element "${name}". Available: ${all.length ? all.join(', ') : '(none)'}`);
  }

  /** Looks up a named type ("xs:int", "AddressType", "{ns}AddressType"...). */
  findType(name: string): TypeDef | undefined {
    const ref = this.parseName(name);
    if (ref.ns === XS_NS) return ref.local === 'anyType' ? this.set.anyType : getBuiltinSimpleType(ref.local);
    if (ref.ns !== undefined) return this.set.types.get(qkey({ ns: ref.ns, local: ref.local }));
    return [...this.set.types.values()].find((t) => t.name?.local === ref.local);
  }

  /** Starts a document with the given global element as root. */
  create(rootElement: string): XmlBuilder;
  create(rootElement: string, build: (root: XmlBuilder) => void): XmlBuilder;
  create(rootElement: string, build?: (root: XmlBuilder) => void): XmlBuilder {
    const decl = this.getElement(rootElement);
    if (decl.abstract) {
      const subs = decl.substitutes.filter((s) => !s.abstract).map((s) => s.name.local);
      throw new SchemaError(`Element "${rootElement}" is abstract${subs.length ? `; use one of: ${subs.join(', ')}` : ''}`);
    }
    const node: ElementNode = { kind: 'element', name: decl.name, attributes: [], children: [], nil: false, decl, type: decl.type };
    const b = new XmlBuilder(this, node, null);
    build?.(b);
    return b;
  }

  /**
   * Builds a document from a plain object. Either `fromObject({ root: {...} })` or `fromObject('root', {...})`.
   * Keys starting with "@" are attributes, "#text" is the text value, arrays repeat elements, null means xsi:nil.
   */
  fromObject(obj: Record<string, unknown>): XmlBuilder;
  fromObject(rootElement: string, value: unknown): XmlBuilder;
  fromObject(a: string | Record<string, unknown>, value?: unknown): XmlBuilder {
    let root: string;
    let content: unknown;
    if (typeof a === 'string') {
      root = a;
      content = value;
    } else {
      const keys = Object.keys(a);
      if (keys.length !== 1) throw new SchemaError(`Expected an object with exactly one root key, got: ${keys.join(', ') || '(none)'}`);
      root = keys[0];
      content = a[root];
    }
    return this.create(root).value(content as never);
  }

  /** Generates a skeleton document for a global element, filled with valid placeholder values. */
  sample(rootElement: string, options: SampleOptions = {}): XmlBuilder {
    const decl = this.getElement(rootElement);
    const node = new SampleGenerator(this.set, options).element(decl);
    if (!node) throw new SchemaError(`Cannot generate a sample for abstract element "${rootElement}"`);
    return new XmlBuilder(this, node, null);
  }

  /** Validates an XML document (string) against the schema. */
  validate(xml: string): ValidationResult {
    let root;
    try {
      root = parseXml(xml).root;
    } catch (e) {
      if (e instanceof XmlParseError) {
        return { valid: false, errors: [{ path: '/', message: `Not well-formed: ${e.reason}`, line: e.line }] };
      }
      throw e;
    }
    return this.validateNode(nodeFromXml(root));
  }

  /** Validates an XML file against the schema. */
  validateFile(file: string): ValidationResult {
    return this.validate(readText(file));
  }

  /** @internal */
  validateNode(node: ElementNode): ValidationResult {
    return new Validator(this.set).validateRoot(node);
  }

  /** @internal */
  serialize(node: ElementNode, options: SerializeOptions = {}): string {
    return serialize(node, this.set.prefixes, options);
  }

  /** Describes the structure (children, attributes, types, occurrences) of a global element. */
  describe(rootElement: string): ElementInfo {
    return describeElement(this.getElement(rootElement));
  }

  /** Renders describe() as a readable text tree. */
  tree(rootElement: string): string {
    return renderTree(this.describe(rootElement));
  }

  /** Short summary of an element's type, e.g. for tooling. */
  typeOf(rootElement: string): string {
    return typeName(this.getElement(rootElement).type);
  }

  /** @internal */
  displayName(q: QName): string {
    return displayName(q);
  }
}

export function loadSchema(file: string, options?: LoadOptions): Schema {
  return Schema.load(file, options);
}

export function parseSchema(xsd: string, options?: ParseSchemaOptions): Schema {
  return Schema.parse(xsd, options);
}
