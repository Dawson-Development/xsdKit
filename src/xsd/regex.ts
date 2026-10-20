/**
 * Translates XML Schema regular expressions (XSD Part 2, Appendix F) into
 * JavaScript RegExp objects and can generate a sample string matching one.
 */

interface Branch {
  pieces: Piece[];
}

interface Piece {
  atom: Atom;
  min: number;
  max: number;
}

type Atom =
  | { t: 'char'; cp: number }
  | { t: 'class'; js: string; candidates: number[] }
  | { t: 'group'; branches: Branch[] };

const BLOCKS: Record<string, [number, number]> = {
  BasicLatin: [0x0000, 0x007f],
  'Latin-1Supplement': [0x0080, 0x00ff],
  'LatinExtended-A': [0x0100, 0x017f],
  'LatinExtended-B': [0x0180, 0x024f],
  IPAExtensions: [0x0250, 0x02af],
  SpacingModifierLetters: [0x02b0, 0x02ff],
  CombiningDiacriticalMarks: [0x0300, 0x036f],
  Greek: [0x0370, 0x03ff],
  GreekandCoptic: [0x0370, 0x03ff],
  Cyrillic: [0x0400, 0x04ff],
  Armenian: [0x0530, 0x058f],
  Hebrew: [0x0590, 0x05ff],
  Arabic: [0x0600, 0x06ff],
  Devanagari: [0x0900, 0x097f],
  Thai: [0x0e00, 0x0e7f],
  Hangul: [0xac00, 0xd7af],
  HangulSyllables: [0xac00, 0xd7af],
  GeneralPunctuation: [0x2000, 0x206f],
  CurrencySymbols: [0x20a0, 0x20cf],
  LetterlikeSymbols: [0x2100, 0x214f],
  NumberForms: [0x2150, 0x218f],
  Arrows: [0x2190, 0x21ff],
  MathematicalOperators: [0x2200, 0x22ff],
  BoxDrawing: [0x2500, 0x257f],
  CJKSymbolsandPunctuation: [0x3000, 0x303f],
  Hiragana: [0x3040, 0x309f],
  Katakana: [0x30a0, 0x30ff],
  CJKUnifiedIdeographs: [0x4e00, 0x9fff],
  PrivateUse: [0xe000, 0xf8ff],
  AlphabeticPresentationForms: [0xfb00, 0xfb4f],
  HalfwidthandFullwidthForms: [0xff00, 0xffef],
  Specials: [0xfff0, 0xffff],
};

const CATEGORIES = new Set(
  'L Lu Ll Lt Lm Lo M Mn Mc Me N Nd Nl No P Pc Pd Ps Pe Pi Pf Po Z Zs Zl Zp S Sm Sc Sk So C Cc Cf Co Cn'.split(' '),
);

const u = (cp: number) => `\\u{${cp.toString(16)}}`;
const lit = (cp: number) => (/[A-Za-z0-9]/.test(String.fromCodePoint(cp)) ? String.fromCodePoint(cp) : u(cp));

const SINGLE_ESCAPES: Record<string, number> = {
  n: 10,
  r: 13,
  t: 9,
};
const ESCAPABLE = '\\|.?*+(){}-[]^$';

const NAME_START = `[\\p{L}${u(0x5f)}${u(0x3a)}]`;
const NAME_CHAR = `[\\p{L}\\p{N}\\p{Mn}\\p{Mc}${u(0x2e)}${u(0x5f)}${u(0x3a)}${u(0x2d)}${u(0xb7)}]`;
const SPACE = `[${u(0x20)}${u(0x9)}${u(0xa)}${u(0xd)}]`;

export class XsdRegexError extends Error {
  constructor(pattern: string, reason: string) {
    super(`Invalid XSD pattern "${pattern}": ${reason}`);
    this.name = 'XsdRegexError';
  }
}

class RegexParser {
  private cps: number[];
  private i = 0;

  constructor(private readonly src: string) {
    this.cps = Array.from(src, (c) => c.codePointAt(0)!);
  }

  private fail(reason: string): never {
    throw new XsdRegexError(this.src, reason);
  }

  private peek(off = 0): string | undefined {
    const cp = this.cps[this.i + off];
    return cp === undefined ? undefined : String.fromCodePoint(cp);
  }

  parse(): Branch[] {
    const b = this.branches();
    if (this.i < this.cps.length) this.fail(`unexpected "${this.peek()}"`);
    return b;
  }

  private branches(): Branch[] {
    const out: Branch[] = [this.branch()];
    while (this.peek() === '|') {
      this.i++;
      out.push(this.branch());
    }
    return out;
  }

  private branch(): Branch {
    const pieces: Piece[] = [];
    for (;;) {
      const c = this.peek();
      if (c === undefined || c === '|' || c === ')') break;
      const atom = this.atom();
      const [min, max] = this.quantifier();
      pieces.push({ atom, min, max });
    }
    return { pieces };
  }

  private quantifier(): [number, number] {
    const c = this.peek();
    if (c === '?') return this.i++, [0, 1];
    if (c === '*') return this.i++, [0, Infinity];
    if (c === '+') return this.i++, [1, Infinity];
    if (c === '{') {
      const rest = String.fromCodePoint(...this.cps.slice(this.i));
      const m = /^\{(\d+)(,(\d*))?\}/.exec(rest);
      if (!m) this.fail('malformed quantifier');
      this.i += m[0].length;
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      if (max < min) this.fail('quantifier max is less than min');
      return [min, max];
    }
    return [1, 1];
  }

  private atom(): Atom {
    const c = this.peek()!;
    if (c === '(') {
      this.i++;
      const branches = this.branches();
      if (this.peek() !== ')') this.fail('missing ")"');
      this.i++;
      return { t: 'group', branches };
    }
    if (c === '[') return this.charClass();
    if (c === '.') {
      this.i++;
      return { t: 'class', js: `[^${u(10)}${u(13)}]`, candidates: [0x61] };
    }
    if (c === '\\') return this.escape(false) as Atom;
    if ('?*+{'.includes(c)) this.fail(`unexpected quantifier "${c}"`);
    this.i++;
    return { t: 'char', cp: c.codePointAt(0)! };
  }

  /** Parses an escape starting at "\". Returns a char atom or a class atom. */
  private escape(inClass: boolean): Atom {
    this.i++;
    const c = this.peek();
    if (c === undefined) this.fail('trailing backslash');
    this.i++;
    if (c in SINGLE_ESCAPES) return { t: 'char', cp: SINGLE_ESCAPES[c] };
    if (ESCAPABLE.includes(c)) return { t: 'char', cp: c.codePointAt(0)! };
    const cls = (js: string, cand: string) => ({ t: 'class' as const, js, candidates: [cand.codePointAt(0)!] });
    switch (c) {
      case 's':
        return cls(SPACE, ' ');
      case 'S':
        return cls(`[^${SPACE.slice(1, -1)}]`, 'a');
      case 'd':
        return cls('\\p{Nd}', '0');
      case 'D':
        return cls('\\P{Nd}', 'a');
      case 'w':
        return cls('[^\\p{P}\\p{Z}\\p{C}]', 'a');
      case 'W':
        return cls('[\\p{P}\\p{Z}\\p{C}]', '-');
      case 'i':
        return cls(NAME_START, 'a');
      case 'I':
        return cls(`[^${NAME_START.slice(1, -1)}]`, '0');
      case 'c':
        return cls(NAME_CHAR, 'a');
      case 'C':
        return cls(`[^${NAME_CHAR.slice(1, -1)}]`, ' ');
      case 'p':
      case 'P': {
        if (this.peek() !== '{') this.fail(`expected "{" after \\${c}`);
        const close = this.cps.indexOf('}'.codePointAt(0)!, this.i);
        if (close < 0) this.fail('unterminated \\p{...}');
        const name = String.fromCodePoint(...this.cps.slice(this.i + 1, close));
        this.i = close + 1;
        const neg = c === 'P';
        if (name.startsWith('Is')) {
          const block = BLOCKS[name.slice(2)];
          if (!block) this.fail(`unsupported Unicode block "${name}"`);
          return cls(`[${neg ? '^' : ''}${u(block[0])}-${u(block[1])}]`, String.fromCodePoint(neg ? 0x61 : block[0]));
        }
        if (!CATEGORIES.has(name)) this.fail(`unknown character category "${name}"`);
        const cand = name.startsWith('L') ? (name === 'Lu' ? 'A' : 'a') : name.startsWith('N') ? '0' : name.startsWith('Z') ? ' ' : '-';
        return cls(`\\${c}{${name}}`, neg ? 'a' : cand);
      }
      default:
        if (inClass && c === ',') return { t: 'char', cp: 0x2c };
        this.fail(`unknown escape "\\${c}"`);
    }
  }

  private charClass(): Atom {
    this.i++;
    let neg = false;
    if (this.peek() === '^') {
      neg = true;
      this.i++;
    }
    const parts: string[] = [];
    const candidates: number[] = [];
    let subtraction: string | undefined;
    let first = true;
    for (;;) {
      const c = this.peek();
      if (c === undefined) this.fail('unterminated character class');
      if (c === ']' && !first) {
        this.i++;
        break;
      }
      if (c === '-' && this.peek(1) === '[') {
        this.i++;
        subtraction = (this.charClass() as { js: string }).js;
        if (this.peek() !== ']') this.fail('character class subtraction must be last');
        this.i++;
        break;
      }
      first = false;
      const start = this.classChar();
      if (start.t === 'class') {
        parts.push(start.js);
        candidates.push(...start.candidates);
        continue;
      }
      if (this.peek() === '-' && this.peek(1) !== ']' && this.peek(1) !== '[' && this.peek(1) !== undefined) {
        this.i++;
        const end = this.classChar();
        if (end.t !== 'char') this.fail('invalid range');
        if (end.cp < start.cp) this.fail('range out of order');
        parts.push(`${u(start.cp)}-${u(end.cp)}`);
        candidates.push(start.cp);
      } else {
        parts.push(u(start.cp));
        candidates.push(start.cp);
      }
    }
    if (parts.length === 0) this.fail('empty character class');
    const base = `[${neg ? '^' : ''}${parts.join('')}]`;
    if (subtraction) return { t: 'class', js: `[${base}--${subtraction}]`, candidates: neg ? [] : candidates };
    return { t: 'class', js: base, candidates: neg ? [] : candidates };
  }

  private classChar(): Extract<Atom, { t: 'char' | 'class' }> {
    const c = this.peek()!;
    if (c === '\\') return this.escape(true) as Extract<Atom, { t: 'char' | 'class' }>;
    if (c === '[') this.fail('unescaped "[" in character class');
    this.i++;
    return { t: 'char', cp: c.codePointAt(0)! };
  }
}

function emitBranches(branches: Branch[]): string {
  return branches.map((b) => b.pieces.map(emitPiece).join('')).join('|');
}

function emitPiece(p: Piece): string {
  const atom = p.atom.t === 'char' ? lit(p.atom.cp) : p.atom.t === 'class' ? p.atom.js : `(?:${emitBranches(p.atom.branches)})`;
  if (p.min === 1 && p.max === 1) return atom;
  if (p.min === 0 && p.max === 1) return atom + '?';
  if (p.min === 0 && p.max === Infinity) return atom + '*';
  if (p.min === 1 && p.max === Infinity) return atom + '+';
  if (p.max === Infinity) return `${atom}{${p.min},}`;
  return p.min === p.max ? `${atom}{${p.min}}` : `${atom}{${p.min},${p.max}}`;
}

export interface CompiledPattern {
  source: string;
  regex: RegExp;
  sample(): string | undefined;
}

const cache = new Map<string, CompiledPattern>();

export function compileXsdPattern(source: string): CompiledPattern {
  const hit = cache.get(source);
  if (hit) return hit;
  const branches = new RegexParser(source).parse();
  let regex: RegExp;
  try {
    regex = new RegExp(`^(?:${emitBranches(branches)})$`, 'v');
  } catch (e) {
    throw new XsdRegexError(source, (e as Error).message);
  }
  const compiled: CompiledPattern = {
    source,
    regex,
    sample() {
      const s = generate(branches);
      return s !== undefined && regex.test(s) ? s : undefined;
    },
  };
  cache.set(source, compiled);
  return compiled;
}

const POOL = 'aA0x1Z_-. z9b@:/';

function pickClassChar(atom: { js: string; candidates: number[] }): string | undefined {
  const re = new RegExp(`^${atom.js}$`, 'v');
  for (const cp of atom.candidates) {
    const ch = String.fromCodePoint(cp);
    if (re.test(ch)) return ch;
  }
  for (const ch of POOL) if (re.test(ch)) return ch;
  for (let cp = 0x21; cp < 0x3000; cp++) {
    const ch = String.fromCodePoint(cp);
    if (re.test(ch)) return ch;
  }
  return undefined;
}

function generate(branches: Branch[]): string | undefined {
  for (const b of branches) {
    let out = '';
    let ok = true;
    for (const p of b.pieces) {
      const count = p.min;
      let piece: string | undefined;
      if (p.atom.t === 'char') piece = String.fromCodePoint(p.atom.cp);
      else if (p.atom.t === 'class') piece = pickClassChar(p.atom);
      else piece = generate(p.atom.branches);
      if (piece === undefined) {
        if (count === 0) continue;
        ok = false;
        break;
      }
      out += piece.repeat(count);
    }
    if (ok) return out;
  }
  return undefined;
}
