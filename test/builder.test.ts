import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { XmlBuildError, XsdValidationError, loadSchema, parseSchema } from '../src/index.js';

const fixture = (f: string) => fileURLToPath(new URL(`../../test/fixtures/${f}`, import.meta.url));
const schema = loadSchema(fixture('order.xsd'));

function validOrder() {
  return schema
    .create('order')
    .attr('id', 'o1')
    .attr('orderDate', new Date(Date.UTC(2024, 0, 15)))
    .element('customer', (c) => c.attr('vip', true).set('name', 'Ann').set('email', 'ann@example.com'))
    .element('shipTo', (a) => a.set('street', ['1 Main St', 'Apt 2']).set('city', 'Springfield').set('postalCode', '12345'))
    .element('items', (items) =>
      items
        .element('item', (i) =>
          i.set('sku', 'AB-1234').set('quantity', 2).element('price', (p) => p.attr('currency', 'USD').text(9.99)),
        )
        .element('item', (i) =>
          i.set('sku', 'CD-5678').set('quantity', 1).set('price', { '@currency': 'EUR', '#text': 100 }),
        ),
    )
    .element('card', (c) => c.set('expires', '2027-05').set('number', '1234 5678 9012 3456'));
}

describe('fluent builder', () => {
  it('builds a valid, namespaced document', () => {
    const xml = validOrder().toXml();
    assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
    assert.match(xml, /<order xmlns="urn:example:order" xmlns:addr="urn:example:address" id="o1" orderDate="2024-01-15">/);
    assert.match(xml, /<customer vip="true">/);
    assert.match(xml, /<addr:street>1 Main St<\/addr:street>\s*<addr:street>Apt 2<\/addr:street>/);
    assert.match(xml, /<price currency="USD">9.99<\/price>/);
    // xs:all allows any order
    assert.match(xml, /<card>\s*<expires>2027-05<\/expires>\s*<number>/);
    assert.equal(schema.validate(xml).valid, true);
  });

  it('supports the chained element()/up() style', () => {
    const b = schema.create('order').attrs({ id: 'x', orderDate: '2024-02-02' });
    const xml = b
      .element('customer').element('name').text('Bob').up().up()
      .element('shipTo').set('street', 'S').set('city', 'C').set('postalCode', 'K1A 0B1').up()
      .element('items').element('item').set('sku', 'ZZ-0001').set('quantity', 5).set('price', { '@currency': 'GBP', '#text': '1.50' }).root()
      .set('invoice', null)
      .toXml({ pretty: false, declaration: false });
    assert.ok(xml.includes('<invoice xsi:nil="true"/>'));
    assert.ok(xml.includes('xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'));
    assert.equal(schema.validate(xml).valid, true, JSON.stringify(schema.validate(xml).errors));
  });

  it('builds from plain objects and orders children by the schema', () => {
    const b = schema.fromObject({
      order: {
        '@id': 'o9',
        '@orderDate': '2024-03-01',
        '@status': 'paid',
        card: { number: '1111 2222 3333 4444', expires: '2030-01' },
        items: { item: [{ price: { '@currency': 'USD', '#text': 3 }, quantity: 1, sku: 'AA-0001' }] },
        shipTo: { city: 'Town', street: 'Road', postalCode: '99999-1234' },
        customer: { name: 'Zed' },
        publicNote: 'leave at door',
        tags: ['gift', 'rush'],
      },
    });
    const xml = b.toXml();
    const order = ['customer', 'shipTo', 'items', 'card', 'publicNote', 'tags'].map((n) => xml.indexOf(`<${n}`));
    assert.deepEqual([...order].sort((a, c) => a - c), order);
    assert.match(xml, /<tags>gift rush<\/tags>/);
  });

  it('rejects unknown elements with a helpful message', () => {
    const b = schema.create('order');
    assert.throws(() => b.element('customr'), (e: Error) => {
      assert.ok(e instanceof XmlBuildError);
      assert.match(e.message, /<customr> is not allowed here\. Allowed child elements: customer, shipTo/);
      return true;
    });
  });

  it('rejects invalid values eagerly', () => {
    const item = schema.create('order').element('items').element('item');
    assert.throws(() => item.set('sku', 'bad'), /does not match pattern/);
    assert.throws(() => item.set('quantity', 0), /must be >= 1/);
    assert.throws(() => item.set('quantity', 1000), /must be < 1000/);
    assert.throws(() => item.set('quantity', 1.5), /not a valid/);
    assert.throws(() => item.set('price', { '@currency': 'JPY', '#text': 1 }), /allowed values: "USD", "EUR", "GBP"/);
    assert.throws(() => item.set('price', { '@currency': 'USD', '#text': 1.234 }), /fraction digits/);
    assert.throws(() => schema.create('order').attr('orderDate', 'tomorrow'), /xs:date/);
    assert.throws(() => schema.create('order').attr('version', '2.0'), /fixed value "1.0"/);
    assert.throws(() => schema.create('order').attr('nope', 1), /attribute "nope" is not allowed/);
    assert.throws(() => schema.create('order').text('hi'), /element-only content/);
    assert.throws(() => item.element('sku').element('x'), /simple content/);
    assert.throws(() => schema.create('order').element('customer').nil(), /not nillable/);
  });

  it('reports structural problems on toXml()', () => {
    const b = schema.create('order').attr('id', 'a').element('customer').set('name', 'A').up();
    assert.throws(() => b.toXml(), (e: Error) => {
      assert.ok(e instanceof XsdValidationError);
      assert.ok(e.errors.some((x) => x.message.includes('Missing required attribute "orderDate"')));
      assert.ok(e.errors.some((x) => /incomplete; expected <shipTo>/.test(x.message)));
      return true;
    });
    assert.doesNotThrow(() => b.toXml({ validate: false }));
  });

  it('detects wrong order and too many occurrences', () => {
    const b = validOrder();
    b.set('publicNote', ['a', 'b', 'c', 'd']);
    const r = b.validate();
    assert.equal(r.valid, false);
    assert.match(r.errors[0].message, /Unexpected element <publicNote> \(check element order and maxOccurs\)/);
  });

  it('handles substitution groups and mixed content', () => {
    const b = validOrder();
    b.element('internalNote', (n) => n.attr('author', 'ann').text('Call ').set('b', 'before').text(' noon'));
    assert.throws(() => b.element('note'), /not allowed here/);
    const xml = b.toXml();
    assert.match(xml, /<internalNote author="ann">Call <b>before<\/b> noon<\/internalNote>/);
  });

  it('supports xsi:type with derived types', () => {
    const b = validOrder();
    b.element('billTo', (a) => a.xsiType('addr:USAddress').set('street', 'x').set('city', 'y').set('postalCode', '12345').set('state', 'CA'));
    const xml = b.toXml();
    assert.match(xml, /<billTo xsi:type="addr:USAddress">/);
    assert.equal(schema.validate(xml).valid, true);
    assert.throws(() => schema.create('order').element('billTo').xsiType('ItemType'), /not derived/);
  });

  it('accepts foreign elements in an xs:any wildcard', () => {
    const b = validOrder();
    b.element('extension').element('{urn:vendor}flag').attr('{urn:vendor}on', 'yes').text('1');
    const xml = b.toXml();
    assert.match(xml, /<ns0:flag ns0:on="yes">1<\/ns0:flag>/);
    assert.match(xml, /xmlns:ns0="urn:vendor"/);
    assert.throws(() => validOrder().element('extension').element('{urn:example:order}customer'), /not allowed/);
  });

  it('checks ID uniqueness and IDREF targets', () => {
    const b = validOrder();
    b.children('items')[0].children('item')[0].attr('related', 'missing');
    const r = b.validate();
    assert.equal(r.valid, false);
    assert.match(r.errors[0].message, /IDREF "missing"/);
  });

  it('exposes introspection helpers', () => {
    const b = schema.create('order');
    assert.deepEqual(b.allowedAttributes(), ['id!', 'orderDate!', 'status', 'version']);
    assert.ok(b.allowedChildren().includes('publicNote'));
    assert.ok(!b.allowedChildren().includes('note'));
    assert.equal(b.element('items').element('item').typeName, 'ItemType');
  });

  it('serializes unqualified schemas without namespaces and honours options', () => {
    const s = parseSchema(`
      <xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema">
        <xs:element name="root"><xs:complexType><xs:sequence>
          <xs:element name="v" type="xs:double" maxOccurs="unbounded"/>
          <xs:element name="bin" type="xs:hexBinary" minOccurs="0"/>
        </xs:sequence></xs:complexType></xs:element>
      </xs:schema>`);
    const xml = s.create('root').set('v', [1.5, Infinity, NaN]).set('bin', new Uint8Array([1, 255])).toXml({ schemaLocation: 'r.xsd', indent: '\t' });
    assert.equal(
      xml,
      '<?xml version="1.0" encoding="UTF-8"?>\n<root xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="r.xsd">\n\t<v>1.5</v>\n\t<v>INF</v>\n\t<v>NaN</v>\n\t<bin>01FF</bin>\n</root>\n',
    );
  });
});
