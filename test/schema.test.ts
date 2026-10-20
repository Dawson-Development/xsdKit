import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SchemaError, compileXsdPattern, loadSchema, parseSchema, parseXml } from '../src/index.js';

const fixture = (f: string) => fileURLToPath(new URL(`../../test/fixtures/${f}`, import.meta.url));

const xsd = (body: string, attrs = '') =>
  parseSchema(`<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema" ${attrs}>${body}</xs:schema>`);

function valueChecker(type: string, extra = '') {
  const s = xsd(`<xs:element name="v"><xs:simpleType><xs:restriction base="${type}">${extra}</xs:restriction></xs:simpleType></xs:element>`);
  return (value: string) => s.validate(`<v>${value}</v>`).valid;
}

describe('built-in types', () => {
  const cases: [string, string[], string[]][] = [
    ['xs:int', ['0', '-2147483648', '+42', ' 7 '], ['2147483648', '1.0', 'abc', '']],
    ['xs:unsignedByte', ['0', '255'], ['-1', '256']],
    ['xs:decimal', ['1', '-1.50', '.5', '5.'], ['1e3', '--1', '.']],
    ['xs:double', ['1e10', '-INF', 'NaN', '.5E-3'], ['inf', '1e']],
    ['xs:boolean', ['true', 'false', '1', '0'], ['yes', 'TRUE']],
    ['xs:date', ['2024-02-29', '2024-01-01Z', '2024-01-01+05:30', '-0044-03-15'], ['2023-02-29', '2024-13-01', '24-01-01']],
    ['xs:dateTime', ['2024-01-01T12:30:00', '2024-01-01T24:00:00Z', '2024-01-01T00:00:00.123-08:00'], ['2024-01-01', '2024-01-01T25:00:00']],
    ['xs:time', ['13:20:00', '13:20:00.5Z'], ['1:20:00']],
    ['xs:duration', ['P1Y2M3DT4H5M6.7S', '-PT1M', 'P0D'], ['P', 'PT', 'P1H']],
    ['xs:gYearMonth', ['2024-05'], ['2024-5']],
    ['xs:gMonthDay', ['--12-25'], ['--02-30']],
    ['xs:hexBinary', ['0aFF', ''], ['ABC', 'zz']],
    ['xs:base64Binary', ['SGVsbG8=', 'AAAA'], ['SGVsbG8', '@@@@']],
    ['xs:NCName', ['abc', '_x-1.2'], ['1abc', 'a:b']],
    ['xs:QName', ['a:b', 'b'], ['a:b:c', ':b']],
    ['xs:language', ['en', 'en-US'], ['toolongprimary', 'en_US']],
    ['xs:token', ['a b'], []],
  ];
  for (const [type, good, bad] of cases) {
    it(type, () => {
      const ok = valueChecker(type);
      for (const g of good) assert.equal(ok(g), true, `${type} should accept "${g}"`);
      for (const b of bad) assert.equal(ok(b), false, `${type} should reject "${b}"`);
    });
  }
});

describe('facets', () => {
  it('length facets, totalDigits, ranges, enumeration by value', () => {
    assert.equal(valueChecker('xs:string', '<xs:minLength value="2"/><xs:maxLength value="3"/>')('ab'), true);
    assert.equal(valueChecker('xs:string', '<xs:minLength value="2"/>')('a'), false);
    assert.equal(valueChecker('xs:string', '<xs:length value="2"/>')('é😀'), true);
    assert.equal(valueChecker('xs:decimal', '<xs:totalDigits value="3"/>')('12.30'), true);
    assert.equal(valueChecker('xs:decimal', '<xs:totalDigits value="3"/>')('12.34'), false);
    assert.equal(valueChecker('xs:decimal', '<xs:enumeration value="1.0"/>')('1'), true);
    assert.equal(valueChecker('xs:date', '<xs:minInclusive value="2024-01-01"/>')('2023-12-31'), false);
    assert.equal(valueChecker('xs:date', '<xs:minInclusive value="2024-01-01"/>')('2024-01-01'), true);
    assert.equal(valueChecker('xs:long', '<xs:maxExclusive value="9223372036854775807"/>')('9223372036854775806'), true);
    assert.equal(valueChecker('xs:long', '<xs:maxExclusive value="9223372036854775807"/>')('9223372036854775807'), false);
  });

  it('whiteSpace handling', () => {
    assert.equal(valueChecker('xs:token', '<xs:enumeration value="a b"/>')('  a \n  b '), true);
    assert.equal(valueChecker('xs:string', '<xs:enumeration value="a b"/>')(' a b'), false);
  });
});

describe('XSD regular expressions', () => {
  const cases: [string, string[], string[]][] = [
    ['[A-Z]{2}-\\d{4}', ['AB-1234'], ['ab-1234', 'AB-123']],
    ['\\i\\c*', ['abc', '_a.b-c'], ['1a', '']],
    ['[a-z-[aeiou]]+', ['xyz'], ['abc']],
    ['\\p{Lu}\\p{Ll}*', ['Hello', 'É'], ['hello']],
    ['\\p{IsBasicLatin}+', ['abc'], ['é']],
    ['a^b$c', ['a^b$c'], ['abc']],
    ['(ab|cd){2}', ['abcd', 'cdcd'], ['ab']],
    ['[\\-+]?\\d+', ['-5', '+5', '5'], ['--5']],
    ['.', ['x'], ['\n', 'xx']],
  ];
  for (const [pattern, good, bad] of cases) {
    it(pattern, () => {
      const p = compileXsdPattern(pattern);
      for (const g of good) assert.equal(p.regex.test(g), true, `/${pattern}/ should match "${g}"`);
      for (const b of bad) assert.equal(p.regex.test(b), false, `/${pattern}/ should not match "${b}"`);
      const s = p.sample();
      assert.ok(s !== undefined && p.regex.test(s), `sample for /${pattern}/`);
    });
  }
});

describe('document validation', () => {
  const schema = loadSchema(fixture('order.xsd'));
  const doc = (body: string, attrs = 'id="o1" orderDate="2024-01-01"') => `<?xml version="1.0"?>
<o:order xmlns:o="urn:example:order" xmlns:a="urn:example:address" ${attrs}>
  <o:customer><o:name>Ann</o:name></o:customer>
  <o:shipTo><a:street>s</a:street><a:city>c</a:city><a:postalCode>12345</a:postalCode></o:shipTo>
  <o:items><o:item><o:sku>AB-0001</o:sku><o:quantity>1</o:quantity><o:price currency="USD">1.00</o:price></o:item></o:items>
  ${body}
</o:order>`;

  it('accepts a valid document', () => {
    const r = schema.validate(doc('<o:invoice/>'));
    assert.deepEqual(r.errors, []);
  });

  it('reports errors with paths and line numbers', () => {
    const r = schema.validate(doc('<o:card><o:number>12</o:number></o:card>', 'id="1bad" status="lost"'));
    const msgs = r.errors.map((e) => `${e.path} @${e.line}: ${e.message}`);
    assert.equal(r.valid, false);
    assert.ok(msgs.some((m) => m.startsWith('/order/@id @2: "1bad" is not a valid')), msgs.join('\n'));
    assert.ok(msgs.some((m) => m.includes('/order/@status') && m.includes('allowed values')), msgs.join('\n'));
    assert.ok(msgs.some((m) => m.includes('Missing required attribute "orderDate"')), msgs.join('\n'));
    assert.ok(msgs.some((m) => m.startsWith('/order/card @6: Element <card> is incomplete; expected <expires>')), msgs.join('\n'));
    assert.ok(msgs.some((m) => m.startsWith('/order/card/number @6') && m.includes('pattern')), msgs.join('\n'));
  });

  it('rejects unknown elements, wrong namespaces and stray text', () => {
    const r1 = schema.validate(doc('<o:invoice/><o:bogus/>'));
    assert.match(r1.errors[0].message, /Unexpected element <bogus>/);
    const r2 = schema.validate(doc('<invoice/>'));
    assert.equal(r2.valid, false);
    const r3 = schema.validate(doc('<o:invoice/>hello'));
    assert.match(r3.errors[0].message, /does not allow text content \(found "hello"\)/);
  });

  it('handles xsi:nil', () => {
    const xsi = 'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" id="o1" orderDate="2024-01-01"';
    assert.equal(schema.validate(doc('<o:invoice xsi:nil="true"/>', xsi)).valid, true);
    assert.equal(schema.validate(doc('<o:invoice xsi:nil="true">x</o:invoice>', xsi)).valid, false);
  });

  it('reports malformed XML', () => {
    const r = schema.validate('<order><a></order>');
    assert.equal(r.valid, false);
    assert.match(r.errors[0].message, /Mismatched closing tag/);
  });
});

describe('schema loading', () => {
  it('loads includes (chameleon) and imports', () => {
    const s = loadSchema(fixture('order.xsd'));
    assert.equal(s.documents.length, 3);
    assert.ok(s.typeNames.includes('SkuType'));
    assert.equal(s.findType('{urn:example:order}SkuType')?.name?.ns, 'urn:example:order');
    assert.ok(s.findType('addr:USAddress'));
  });

  it('reports unresolved references', () => {
    assert.throws(() => xsd('<xs:element name="a" type="Nope"/>'), (e: Error) => e instanceof SchemaError && /Unknown type "Nope"/.test(e.message));
    assert.throws(() => xsd('<xs:element name="a"><xs:complexType><xs:sequence><xs:element ref="b"/></xs:sequence></xs:complexType></xs:element>'), /Unknown element "b"/);
    assert.throws(() => parseSchema('<schema/>'), /not an XML Schema document/);
  });

  it('supports a custom resolver', () => {
    const files: Record<string, string> = {
      '/v/main.xsd': '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:include schemaLocation="t.xsd"/><xs:element name="r" type="T"/></xs:schema>',
      '/v/t.xsd': '<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:simpleType name="T"><xs:restriction base="xs:int"/></xs:simpleType></xs:schema>',
    };
    const s = parseSchema(files['/v/main.xsd'], {
      baseDir: '/v',
      resolver: (loc) => ({ id: `/v/${loc}`, content: files[`/v/${loc}`] }),
    });
    assert.equal(s.validate('<r>5</r>').valid, true);
    assert.equal(s.validate('<r>x</r>').valid, false);
  });

  it('handles recursive types, groups, attribute groups and restriction', () => {
    const s = xsd(`
      <xs:group name="g"><xs:sequence><xs:element name="label" type="xs:string"/></xs:sequence></xs:group>
      <xs:attributeGroup name="ag"><xs:attribute name="code" type="xs:int" use="required"/></xs:attributeGroup>
      <xs:complexType name="Node">
        <xs:sequence><xs:group ref="g"/><xs:element name="node" type="Node" minOccurs="0" maxOccurs="unbounded"/></xs:sequence>
        <xs:attributeGroup ref="ag"/>
        <xs:attribute name="opt" type="xs:string"/>
      </xs:complexType>
      <xs:complexType name="Leaf">
        <xs:complexContent><xs:restriction base="Node">
          <xs:sequence><xs:group ref="g"/></xs:sequence>
          <xs:attribute name="opt" use="prohibited"/>
        </xs:restriction></xs:complexContent>
      </xs:complexType>
      <xs:element name="tree" type="Node"/>`);
    const b = s.create('tree').attr('code', 1).set('label', 'root');
    b.element('node').attr('code', 2).set('label', 'child').element('node').attr('code', 3).set('label', 'grandchild');
    assert.equal(b.validate().valid, true);
    assert.ok(s.tree('tree').includes('(recursive, see above)'));
    const leaf = s.create('tree').element('node').xsiType('Leaf');
    assert.throws(() => leaf.attr('opt', 'x'), /not allowed/);
  });
});

describe('xml parser', () => {
  it('parses namespaces, entities, CDATA and comments', () => {
    const { root } = parseXml('<?xml version="1.0"?><!DOCTYPE r [<!ELEMENT r ANY>]><p:r xmlns:p="u" a="&lt;&#65;&#x42;"><![CDATA[<x>]]><!--c--> &amp; </p:r>');
    assert.equal(root.ns, 'u');
    assert.equal(root.local, 'r');
    assert.equal(root.attributes[0].value, '<AB');
    assert.deepEqual(root.children.map((c) => c.type), ['text', 'comment', 'text']);
  });

  it('reports errors with positions', () => {
    assert.throws(() => parseXml('<a>\n<b x="1" x="2"/></a>'), /Duplicate attribute "x" \(line 2, column 10\)/);
    assert.throws(() => parseXml('<a:b/>'), /Undeclared namespace prefix "a"/);
    assert.throws(() => parseXml('<a>&nbsp;</a>'), /Unknown entity/);
  });
});
