# xsdkit

Schema-driven XML for Node.js. Load an XSD, then build XML with a fluent API that knows which elements and attributes are allowed and what types their values must have. Includes a validator, a sample/skeleton generator, and a CLI. **Zero runtime dependencies.**

```bash
npm install
npm run build   # -> dist/
npm test
```

## Browser Playground

```bash
npm install
npm run demo:dev
```

Open the local URL printed by Vite. The playground includes editable XSD, sample XML generation, a schema tree, and XML validation. The bundled order example resolves its includes and imports locally. Open multiple XSD files together to use your own schemas; select the entry schema from the file menu. Uploaded files stay in memory in your browser. Filenames must be unique; nested directory uploads and automatic remote fetching are not supported by the playground.

```bash
npm run demo:build       # production site -> demo/dist/
npx playwright install chromium
npm run test:browser     # desktop and mobile browser tests
```

### GitHub Pages

1. Push this repository to GitHub, with `main` or `master` as the default branch.
2. In **Settings > Pages > Build and deployment**, select **GitHub Actions** as the source.
3. Push to the default branch or run **Test and Deploy Playground** in the Actions tab.

The workflow runs the Node and browser tests before publishing. Pull requests run the same checks without deploying. Relative asset URLs support repository Pages paths and custom domains without configuration. The published URL appears in the deployment environment and Pages settings.

### Browser API

Browser-aware bundlers such as Vite select a browser adapter automatically:

```ts
import { parseSchema } from 'xsdkit/browser';

const schema = parseSchema(xsdText);
const xml = schema.sample('order').toXml();
```

For includes/imports, supply a synchronous `resolver` returning `{ id, content }` from preloaded schema strings. In the browser, `baseDir` is a base URL (default `https://xsdkit.local/`), not a filesystem directory. Node-only `loadSchema()`, `Schema.load()`, `validateFile()`, and the default filesystem resolver throw a descriptive error in the browser. The existing Node API is unchanged. Browser use requires a bundler that honors the `browser` condition; this is not a standalone script-tag distribution.

## Quick start

```ts
import { loadSchema } from 'xsdkit';

const schema = loadSchema('schemas/order.xsd'); // follows xs:include / xs:import

const xml = schema
  .create('order')
  .attr('id', 'o1')
  .attr('orderDate', new Date('2024-01-15'))      // Date -> xs:date "2024-01-15"
  .element('customer', (c) => c.set('name', 'Ann').set('email', 'ann@example.com'))
  .element('shipTo', (a) =>
    a.set('street', ['1 Main St', 'Apt 2'])        // arrays repeat the element
     .set('city', 'Springfield')
     .set('postalCode', '12345'))
  .element('items', (items) =>
    items.element('item', (i) =>
      i.set('sku', 'AB-1234').set('quantity', 2).element('price', (p) => p.attr('currency', 'USD').text(9.99))))
  .set('invoice', null)                            // null -> xsi:nil="true"
  .toXml();                                        // validates, then serializes
```

Mistakes are caught as soon as you make them:

```ts
schema.create('order').element('custmer');
// XmlBuildError: <order>: <custmer> is not allowed here. Allowed child elements: customer, shipTo, billTo, ...
schema.create('order').element('items').element('item').set('quantity', 0);
// XmlBuildError: <quantity>: invalid value for type QuantityType: "0" must be >= 1
```

`toXml()` runs full validation (content model, `minOccurs`/`maxOccurs`, required attributes, IDs/IDREFs…) and throws `XsdValidationError` listing every problem. Use `builder.validate()` to get a `{ valid, errors }` result instead, or `toString(opts?)` to serialize without validating.

## Builder API

| Method | Description |
| --- | --- |
| `element(name)` / `ele(name)` | Add a child; returns the **child** builder |
| `element(name, fn)` / `element(name, value)` | Add a child and configure it; returns the **parent** |
| `set(name, value)` | Add a child with a value (array = repeated elements, except for list types) |
| `text(v)` / `txt(v)` | Set/append text content (type-checked for simple content) |
| `attr(name, v)` / `attrs(obj)` | Set attributes (`null` removes) |
| `value(v)` | `null` → nil, plain object → `assign`, otherwise `text` |
| `assign(obj)` | Populate from an object (see JSON format below) |
| `nil()` | Mark `xsi:nil="true"` (element must be nillable) |
| `xsiType(name)` | Switch to a derived type via `xsi:type` |
| `comment(text)` | Add an XML comment |
| `up()` / `root()` / `children(name?)` | Navigate |
| `allowedChildren()` / `allowedAttributes()` | What can go here (required attributes end in `!`) |
| `validate()` / `toXml(opts)` / `toString(opts)` | Validate / serialize |

Children are placed in schema order automatically, so call order doesn't matter (except inside repeating groups and mixed content, where your order is kept).

**Names** can be `local`, `prefix:local` (using prefixes declared in the schema, plus `xs`, `xsi`, `xml`; add more with `schema.registerPrefix`), or Clark notation `{namespace}local`.

**Values** are converted per the target type: `Date` → `xs:date`/`dateTime`/`gYearMonth`/…, `boolean`, `number`, `bigint`, `Uint8Array` → hex/base64, arrays → list types.

### Serialization options

`toXml({ pretty = true, indent = '  ', declaration = true, prefixes: { o: 'urn:...' }, schemaLocation: 'order.xsd', validate = true })`

The root namespace becomes the default namespace when possible; other namespaces use the schema's prefixes and are declared on the root.

## Building from JSON

```ts
schema.fromObject({
  order: {
    '@id': 'o1',                    // attributes start with @
    '@orderDate': '2024-01-15',
    customer: { name: 'Ann' },
    shipTo: { street: ['1 Main St'], city: 'X', postalCode: '12345' },
    items: { item: [{ sku: 'AB-1234', quantity: 1, price: { '@currency': 'USD', '#text': 5 } }] },
    invoice: null,                  // xsi:nil
  },
}).toXml();
```

`#text` (or `$text`) is the text content, `@xsi:type` selects a derived type, `@xsi:nil: true` sets nil. Keys may be in any order.

## Samples and introspection

```ts
schema.sample('order', { optional: true, comments: true }).toXml(); // valid skeleton with placeholder values
schema.tree('order');      // human-readable outline (types, occurrences, facets)
schema.describe('order');  // the same as structured data (ElementInfo)
schema.elementNames;       // global elements
```

Sample values honour enumerations, patterns (a matching string is generated from the regex), numeric bounds and length facets. The returned builder can be edited before serializing.

## Validating existing XML

```ts
const r = schema.validate(xmlString);        // or schema.validateFile('doc.xml')
if (!r.valid) for (const e of r.errors) console.log(e.path, e.line, e.message);
```

## CLI

```
xsdkit info     <schema.xsd>                          list namespaces, global elements and types
xsdkit tree     <schema.xsd> <element>                outline of an element's structure
xsdkit sample   <schema.xsd> <element> [--optional] [--depth N] [--comments]
xsdkit build    <schema.xsd> <data.json> [--root name] [--no-validate]
xsdkit validate <schema.xsd> <doc.xml> [--json]

Common: -o/--out <file>, --compact, --schema-location <uri>
Exit codes: 0 ok, 1 document invalid, 2 error
```

## Loading options

- `loadSchema(file, { resolver })` / `parseSchema(xsdText, { baseDir, resolver })`
- The default resolver reads includes/imports from disk relative to the including file. For remote `schemaLocation`s, pass a `resolver: (location, baseId) => ({ id, content })`.

## Supported XSD features

Global/local elements and attributes, named/anonymous types, `sequence`/`choice`/`all` with occurrence constraints, groups and attribute groups, `xs:any`/`xs:anyAttribute` (strict/lax/skip, namespace constraints), complex/simple content extension and restriction, `mixed`, nillable, abstract elements and types, substitution groups, `xsi:type`, default/fixed values, all built-in types, list/union types, all facets (including XSD regex patterns with `\i`, `\c`, `\p{Is…}` blocks and character class subtraction), ID/IDREF(S), `elementFormDefault`/`attributeFormDefault`/`form`, chameleon includes, and imports.

## Limitations

- `xs:redefine` / `xs:override` are treated as plain includes (redefinitions are ignored).
- Identity constraints (`xs:key`, `xs:keyref`, `xs:unique`) are not enforced.
- XSD 1.1 assertions and conditional type assignment are not supported.
- Remote schemas are not fetched automatically; supply a resolver.
- Durations are compared approximately (months = 30 days) for range facets.
