import { ChildNode, ElementNode } from './node.js';
import { XML_NS, XSI_NS } from './xsd/model.js';
import { escapeAttr, escapeText } from './xml/parser.js';

export interface SerializeOptions {
  /** Indent nested elements (default: true). Elements with text content are never re-indented. */
  pretty?: boolean;
  /** Indentation string (default: two spaces). */
  indent?: string;
  /** Emit the <?xml ...?> declaration (default: true). */
  declaration?: boolean;
  /** Preferred prefixes: { prefix: namespaceUri }. Use '' as the key to force a default namespace. */
  prefixes?: Record<string, string>;
  /** Adds xsi:schemaLocation (namespaced root) or xsi:noNamespaceSchemaLocation. */
  schemaLocation?: string;
}

export function serialize(root: ElementNode, schemaPrefixes: Map<string, string>, opts: SerializeOptions = {}): string {
  const pretty = opts.pretty ?? true;
  const indent = opts.indent ?? '  ';
  const user = new Map<string, string>();
  let userDefault: string | undefined;
  for (const [p, ns] of Object.entries(opts.prefixes ?? {})) {
    if (p === '') userDefault = ns;
    else user.set(ns, p);
  }

  const elementNs = new Set<string>();
  const attrNs = new Set<string>();
  let hasUnqualified = false;
  let needsXsi = !!opts.schemaLocation;
  const walk = (n: ElementNode) => {
    elementNs.add(n.name.ns);
    if (n.name.ns === '') hasUnqualified = true;
    for (const a of n.attributes) if (a.name.ns && a.name.ns !== XML_NS) attrNs.add(a.name.ns);
    if (n.nil || n.xsiType) needsXsi = true;
    if (n.xsiType?.ns) attrNs.add(n.xsiType.ns);
    for (const c of n.children) if (c.kind === 'element') walk(c);
  };
  walk(root);
  if (needsXsi) attrNs.add(XSI_NS);

  let defaultNs: string | undefined;
  if (!hasUnqualified) {
    if (userDefault !== undefined) defaultNs = userDefault;
    else if (root.name.ns && !user.has(root.name.ns)) defaultNs = root.name.ns;
  }

  const prefixOf = new Map<string, string>();
  const taken = new Set<string>(['xml', 'xmlns']);
  let counter = 0;
  const assign = (ns: string) => {
    if (prefixOf.has(ns)) return;
    let p = user.get(ns) ?? (ns === XSI_NS ? 'xsi' : schemaPrefixes.get(ns)) ?? `ns${counter++}`;
    while (taken.has(p)) p = `ns${counter++}`;
    taken.add(p);
    prefixOf.set(ns, p);
  };
  for (const ns of elementNs) if (ns && ns !== defaultNs) assign(ns);
  for (const ns of attrNs) assign(ns);

  const elName = (ns: string, local: string) => (!ns || ns === defaultNs ? local : `${prefixOf.get(ns)}:${local}`);
  const attrName = (ns: string, local: string) => (!ns ? local : ns === XML_NS ? `xml:${local}` : `${prefixOf.get(ns)}:${local}`);

  const rootDecls: string[] = [];
  if (defaultNs) rootDecls.push(` xmlns="${escapeAttr(defaultNs)}"`);
  for (const [ns, p] of prefixOf) rootDecls.push(` xmlns:${p}="${escapeAttr(ns)}"`);
  if (opts.schemaLocation) {
    const loc = opts.schemaLocation;
    if (root.name.ns) {
      const value = /\s/.test(loc.trim()) ? loc : `${root.name.ns} ${loc}`;
      rootDecls.push(` xsi:schemaLocation="${escapeAttr(value)}"`);
    } else rootDecls.push(` xsi:noNamespaceSchemaLocation="${escapeAttr(loc)}"`);
  }

  const nl = pretty ? '\n' : '';
  const render = (n: ElementNode, depth: number, indented: boolean, isRoot: boolean): string => {
    const name = elName(n.name.ns, n.name.local);
    let open = `<${name}`;
    if (isRoot) open += rootDecls.join('');
    if (n.xsiType) open += ` ${prefixOf.get(XSI_NS)}:type="${escapeAttr(elName(n.xsiType.ns, n.xsiType.local))}"`;
    if (n.nil) open += ` ${prefixOf.get(XSI_NS)}:nil="true"`;
    for (const a of n.attributes) open += ` ${attrName(a.name.ns, a.name.local)}="${escapeAttr(a.value)}"`;
    const children = n.children.filter((c) => !(c.kind === 'text' && c.value === ''));
    if (!children.length) return open + '/>';
    const hasText = children.some((c) => c.kind === 'text');
    if (!indented || hasText) {
      return `${open}>${children.map((c) => renderChild(c, depth, false)).join('')}</${name}>`;
    }
    const pad = indent.repeat(depth + 1);
    return `${open}>${children.map((c) => nl + pad + renderChild(c, depth + 1, true)).join('')}${nl}${indent.repeat(depth)}</${name}>`;
  };
  const renderChild = (c: ChildNode, depth: number, indented: boolean): string => {
    if (c.kind === 'text') return escapeText(c.value);
    if (c.kind === 'comment') return `<!--${c.value.replace(/--/g, '- -').replace(/-$/, '- ')}-->`;
    return render(c, depth, indented, false);
  };

  const decl = opts.declaration ?? true ? `<?xml version="1.0" encoding="UTF-8"?>${nl}` : '';
  return decl + render(root, 0, pretty, true) + (pretty ? '\n' : '');
}
