#!/usr/bin/env node
import * as fs from 'node:fs';
import { XmlBuildError } from './builder.js';
import { Schema } from './schema.js';
import { XsdValidationError } from './validator.js';
import { SchemaError } from './xsd/loader.js';

const HELP = `xsdkit - build, generate and validate XML from XSD schemas

Usage:
  xsdkit info     <schema.xsd>                       List global elements, types and namespaces
  xsdkit tree     <schema.xsd> <element>             Show the structure of an element
  xsdkit sample   <schema.xsd> <element> [options]   Generate a skeleton XML document
  xsdkit build    <schema.xsd> <input.json> [options] Build XML from JSON and validate it
  xsdkit validate <schema.xsd> <document.xml>        Validate an XML document

Options:
  -o, --out <file>        Write output to a file instead of stdout
  --root <element>        (build) Root element, when the JSON is not { "<root>": {...} }
  --optional              (sample) Include optional elements and attributes
  --depth <n>             (sample) Max depth for optional content (default 8)
  --comments              (sample) Annotate elements with type and occurrence comments
  --no-validate           (build) Skip validation
  --compact               Do not pretty-print
  --schema-location <loc> Add xsi:schemaLocation / xsi:noNamespaceSchemaLocation
  --json                  (tree, validate) Output JSON
  -h, --help              Show this help

JSON input format (build):
  { "order": { "@id": 42, "customer": "Ann", "item": [ { "@sku": "A1", "qty": 2 } ], "note": null } }
  "@name" = attribute, "#text" = text value, arrays = repeated elements, null = xsi:nil
`;

interface Args {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  const withValue = new Set(['out', 'root', 'depth', 'schema-location']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') flags.set('out', argv[++i]);
    else if (a === '-h') flags.set('help', true);
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags.set(k, v);
      else if (withValue.has(k)) flags.set(k, argv[++i]);
      else flags.set(k, true);
    } else positional.push(a);
  }
  return { positional, flags };
}

function output(text: string, args: Args): void {
  const out = args.flags.get('out');
  if (typeof out === 'string') {
    fs.writeFileSync(out, text);
    process.stderr.write(`Wrote ${out}\n`);
  } else process.stdout.write(text.endsWith('\n') ? text : text + '\n');
}

function need(args: Args, n: number, usage: string): string[] {
  if (args.positional.length < n + 1) throw new UsageError(`Usage: xsdkit ${usage}`);
  return args.positional.slice(1, n + 1);
}

class UsageError extends Error {}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  const cmd = args.positional[0];
  if (!cmd || args.flags.has('help')) {
    process.stdout.write(HELP);
    return cmd ? 0 : 1;
  }
  const serializeOpts = {
    pretty: !args.flags.has('compact'),
    schemaLocation: args.flags.get('schema-location') as string | undefined,
  };

  switch (cmd) {
    case 'info': {
      const [file] = need(args, 1, 'info <schema.xsd>');
      const schema = Schema.load(file);
      const lines = [
        `Documents:\n${schema.documents.map((d) => `  ${d}`).join('\n')}`,
        `Target namespaces:\n${schema.set.targetNamespaces.map((n) => `  ${n}`).join('\n') || '  (none)'}`,
        `Global elements:\n${schema.elementNames.map((n) => `  ${n} : ${schema.typeOf(n)}`).join('\n') || '  (none)'}`,
        `Named types:\n${schema.typeNames.map((n) => `  ${n}`).join('\n') || '  (none)'}`,
      ];
      output(lines.join('\n\n'), args);
      return 0;
    }
    case 'tree': {
      const [file, el] = need(args, 2, 'tree <schema.xsd> <element>');
      const schema = Schema.load(file);
      output(args.flags.has('json') ? JSON.stringify(schema.describe(el), null, 2) : schema.tree(el), args);
      return 0;
    }
    case 'sample': {
      const [file, el] = need(args, 2, 'sample <schema.xsd> <element>');
      const schema = Schema.load(file);
      const depth = args.flags.get('depth');
      const b = schema.sample(el, {
        optional: args.flags.has('optional'),
        comments: args.flags.has('comments'),
        maxDepth: typeof depth === 'string' ? Number(depth) : undefined,
      });
      const result = b.validate();
      output(b.toXml({ ...serializeOpts, validate: false }), args);
      if (!result.valid) {
        process.stderr.write(
          `warning: the generated sample needs manual edits:\n${result.errors.map((e) => `  - ${e.path}: ${e.message}`).join('\n')}\n`,
        );
      }
      return 0;
    }
    case 'build': {
      const [file, input] = need(args, 2, 'build <schema.xsd> <input.json>');
      const schema = Schema.load(file);
      const data = JSON.parse(fs.readFileSync(input, 'utf8'));
      const root = args.flags.get('root');
      const b = typeof root === 'string' ? schema.fromObject(root, data) : schema.fromObject(data);
      output(b.toXml({ ...serializeOpts, validate: !args.flags.has('no-validate') }), args);
      return 0;
    }
    case 'validate': {
      const [file, doc] = need(args, 2, 'validate <schema.xsd> <document.xml>');
      const schema = Schema.load(file);
      const r = schema.validateFile(doc);
      if (args.flags.has('json')) output(JSON.stringify(r, null, 2), args);
      else if (r.valid) output(`${doc} is valid`, args);
      else {
        output(
          `${doc} is NOT valid (${r.errors.length} error${r.errors.length === 1 ? '' : 's'}):\n` +
            r.errors.map((e) => `  - ${e.path}${e.line ? ` (line ${e.line})` : ''}: ${e.message}`).join('\n'),
          args,
        );
      }
      return r.valid ? 0 : 1;
    }
    default:
      throw new UsageError(`Unknown command "${cmd}". Run "xsdkit --help".`);
  }
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  if (e instanceof UsageError || e instanceof SchemaError || e instanceof XmlBuildError || e instanceof XsdValidationError) {
    process.stderr.write(`error: ${e.message}\n`);
    process.exitCode = 2;
  } else if (e instanceof SyntaxError || (e as NodeJS.ErrnoException).code === 'ENOENT') {
    process.stderr.write(`error: ${(e as Error).message}\n`);
    process.exitCode = 2;
  } else throw e;
}
