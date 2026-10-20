export const XML_NS = 'http://www.w3.org/XML/1998/namespace';

export interface XmlAttribute {
  qname: string;
  prefix: string;
  local: string;
  ns: string;
  value: string;
}

export interface XmlElement {
  type: 'element';
  qname: string;
  prefix: string;
  local: string;
  ns: string;
  attributes: XmlAttribute[];
  children: XmlNode[];
  /** In-scope namespace bindings (prefix -> URI, '' is the default namespace). */
  namespaces: ReadonlyMap<string, string>;
  line: number;
  column: number;
}

export interface XmlText {
  type: 'text';
  value: string;
  cdata: boolean;
}

export interface XmlComment {
  type: 'comment';
  value: string;
}

export interface XmlProcessingInstruction {
  type: 'pi';
  target: string;
  data: string;
}

export type XmlNode = XmlElement | XmlText | XmlComment | XmlProcessingInstruction;

export interface XmlDocument {
  root: XmlElement;
}

export class XmlParseError extends Error {
  constructor(
    readonly reason: string,
    readonly line: number,
    readonly column: number,
    readonly source?: string,
  ) {
    super(`${source ? source + ': ' : ''}${reason} (line ${line}, column ${column})`);
    this.name = 'XmlParseError';
  }
}

const PREDEFINED: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const NAME_RE = /[\p{L}_:][\p{L}\p{N}\p{M}_:.\-\u00B7]*/uy;

export function parseXml(input: string, source?: string): XmlDocument {
  return new Parser(input, source).parseDocument();
}

class Parser {
  private readonly s: string;
  private pos = 0;
  private readonly lineStarts: number[] = [0];

  constructor(input: string, private readonly source?: string) {
    let s = input.replace(/\r\n?/g, '\n');
    if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
    this.s = s;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
  }

  private loc(pos: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: pos - this.lineStarts[lo] + 1 };
  }

  private error(msg: string, pos = this.pos): never {
    const { line, column } = this.loc(pos);
    throw new XmlParseError(msg, line, column, this.source);
  }

  private at(str: string): boolean {
    return this.s.startsWith(str, this.pos);
  }

  private skipWs(): boolean {
    const start = this.pos;
    while (this.pos < this.s.length) {
      const c = this.s.charCodeAt(this.pos);
      if (c === 32 || c === 9 || c === 10) this.pos++;
      else break;
    }
    return this.pos > start;
  }

  private expect(str: string): void {
    if (!this.at(str)) this.error(`Expected "${str}"`);
    this.pos += str.length;
  }

  private readName(): string {
    NAME_RE.lastIndex = this.pos;
    const m = NAME_RE.exec(this.s);
    if (!m) this.error('Expected a name');
    this.pos += m[0].length;
    return m[0];
  }

  parseDocument(): XmlDocument {
    let root: XmlElement | undefined;
    const rootNs = new Map([['xml', XML_NS]]);
    for (;;) {
      this.skipWs();
      if (this.pos >= this.s.length) break;
      if (this.at('<?')) this.parsePI();
      else if (this.at('<!--')) this.parseComment();
      else if (this.at('<!DOCTYPE')) {
        if (root) this.error('DOCTYPE must precede the root element');
        this.skipDoctype();
      } else if (this.at('<')) {
        if (root) this.error('Only one root element is allowed');
        root = this.parseElement(rootNs);
      } else this.error('Unexpected content outside of the root element');
    }
    if (!root) this.error('Document has no root element');
    return { root };
  }

  private parsePI(): XmlProcessingInstruction {
    this.pos += 2;
    const target = this.readName();
    const end = this.s.indexOf('?>', this.pos);
    if (end < 0) this.error('Unterminated processing instruction');
    const data = this.s.slice(this.pos, end).trim();
    this.pos = end + 2;
    return { type: 'pi', target, data };
  }

  private parseComment(): XmlComment {
    this.pos += 4;
    const end = this.s.indexOf('-->', this.pos);
    if (end < 0) this.error('Unterminated comment');
    const value = this.s.slice(this.pos, end);
    this.pos = end + 3;
    return { type: 'comment', value };
  }

  private skipDoctype(): void {
    this.pos += 9;
    let depth = 0;
    while (this.pos < this.s.length) {
      const c = this.s[this.pos];
      if (c === '[') depth++;
      else if (c === ']') depth--;
      else if (c === '>' && depth === 0) {
        this.pos++;
        return;
      } else if (c === '"' || c === "'") {
        const e = this.s.indexOf(c, this.pos + 1);
        if (e < 0) break;
        this.pos = e;
      }
      this.pos++;
    }
    this.error('Unterminated DOCTYPE');
  }

  private decode(raw: string, at: number): string {
    if (!raw.includes('&')) return raw;
    let out = '';
    let i = 0;
    let j: number;
    while ((j = raw.indexOf('&', i)) >= 0) {
      out += raw.slice(i, j);
      const k = raw.indexOf(';', j);
      if (k < 0) this.error('Unterminated entity reference', at + j);
      const name = raw.slice(j + 1, k);
      if (name.startsWith('#')) {
        const m = /^#(?:x([0-9a-fA-F]+)|([0-9]+))$/.exec(name);
        const cp = m ? (m[1] ? parseInt(m[1], 16) : parseInt(m[2], 10)) : NaN;
        if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff) {
          this.error(`Invalid character reference "&${name};"`, at + j);
        }
        out += String.fromCodePoint(cp);
      } else {
        const ch = PREDEFINED[name];
        if (ch === undefined) this.error(`Unknown entity "&${name};"`, at + j);
        out += ch;
      }
      i = k + 1;
    }
    return out + raw.slice(i);
  }

  private parseElement(parentNs: ReadonlyMap<string, string>): XmlElement {
    const start = this.pos;
    this.pos++;
    const qname = this.readName();
    const rawAttrs: { name: string; value: string; pos: number }[] = [];
    let selfClosing = false;
    for (;;) {
      const hadWs = this.skipWs();
      if (this.at('/>')) {
        this.pos += 2;
        selfClosing = true;
        break;
      }
      if (this.at('>')) {
        this.pos++;
        break;
      }
      if (this.pos >= this.s.length) this.error('Unexpected end of input in start tag');
      if (!hadWs) this.error('Expected whitespace before attribute');
      const apos = this.pos;
      const name = this.readName();
      this.skipWs();
      this.expect('=');
      this.skipWs();
      const q = this.s[this.pos];
      if (q !== '"' && q !== "'") this.error('Expected a quoted attribute value');
      const end = this.s.indexOf(q, this.pos + 1);
      if (end < 0) this.error('Unterminated attribute value');
      const raw = this.s.slice(this.pos + 1, end);
      const lt = raw.indexOf('<');
      if (lt >= 0) this.error("'<' is not allowed in attribute values", this.pos + 1 + lt);
      const value = this.decode(raw.replace(/[\t\n]/g, ' '), this.pos + 1);
      this.pos = end + 1;
      if (rawAttrs.some((a) => a.name === name)) this.error(`Duplicate attribute "${name}"`, apos);
      rawAttrs.push({ name, value, pos: apos });
    }

    let namespaces = parentNs;
    for (const a of rawAttrs) {
      if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) {
        if (namespaces === parentNs) namespaces = new Map(parentNs);
        const p = a.name === 'xmlns' ? '' : a.name.slice(6);
        if (p && !a.value) this.error(`Cannot undeclare namespace prefix "${p}"`, a.pos);
        (namespaces as Map<string, string>).set(p, a.value);
      }
    }

    const resolve = (prefix: string, isElement: boolean, pos: number): string => {
      if (!prefix) return isElement ? namespaces.get('') ?? '' : '';
      const ns = namespaces.get(prefix);
      if (ns === undefined) this.error(`Undeclared namespace prefix "${prefix}"`, pos);
      return ns;
    };

    const [prefix, local] = splitQName(qname);
    const { line, column } = this.loc(start);
    const el: XmlElement = {
      type: 'element',
      qname,
      prefix,
      local,
      ns: resolve(prefix, true, start),
      attributes: [],
      children: [],
      namespaces,
      line,
      column,
    };
    const seen = new Set<string>();
    for (const a of rawAttrs) {
      if (a.name === 'xmlns' || a.name.startsWith('xmlns:')) continue;
      const [p, l] = splitQName(a.name);
      const ns = resolve(p, false, a.pos);
      const key = `{${ns}}${l}`;
      if (seen.has(key)) this.error(`Duplicate attribute "${a.name}"`, a.pos);
      seen.add(key);
      el.attributes.push({ qname: a.name, prefix: p, local: l, ns, value: a.value });
    }

    if (!selfClosing) this.parseContent(el);
    return el;
  }

  private parseContent(el: XmlElement): void {
    for (;;) {
      if (this.pos >= this.s.length) this.error(`Unclosed element <${el.qname}>`);
      if (this.at('</')) {
        const p = this.pos;
        this.pos += 2;
        const n = this.readName();
        if (n !== el.qname) this.error(`Mismatched closing tag: expected </${el.qname}> but found </${n}>`, p);
        this.skipWs();
        this.expect('>');
        return;
      }
      if (this.at('<!--')) el.children.push(this.parseComment());
      else if (this.at('<![CDATA[')) {
        const end = this.s.indexOf(']]>', this.pos + 9);
        if (end < 0) this.error('Unterminated CDATA section');
        el.children.push({ type: 'text', value: this.s.slice(this.pos + 9, end), cdata: true });
        this.pos = end + 3;
      } else if (this.at('<?')) el.children.push(this.parsePI());
      else if (this.s[this.pos] === '<') el.children.push(this.parseElement(el.namespaces));
      else {
        const next = this.s.indexOf('<', this.pos);
        const stop = next < 0 ? this.s.length : next;
        el.children.push({ type: 'text', value: this.decode(this.s.slice(this.pos, stop), this.pos), cdata: false });
        this.pos = stop;
      }
    }
  }
}

export function splitQName(qname: string): [prefix: string, local: string] {
  const i = qname.indexOf(':');
  return i < 0 ? ['', qname] : [qname.slice(0, i), qname.slice(i + 1)];
}

export function escapeText(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

export function escapeAttr(s: string): string {
  return s.replace(/[&<>"\t\n\r]/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case '\t':
        return '&#9;';
      case '\n':
        return '&#10;';
      default:
        return '&#13;';
    }
  });
}
