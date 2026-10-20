import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadSchema } from '../src/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = (f: string) => path.join(root, 'test', 'fixtures', f);
const cli = path.join(root, 'build-test', 'src', 'cli.js');
const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

describe('sample generation', () => {
  const schema = loadSchema(fixture('order.xsd'));

  it('produces valid required-only and full samples', () => {
    for (const optional of [false, true]) {
      const b = schema.sample('order', { optional });
      assert.deepEqual(b.validate().errors, [], `optional=${optional}`);
    }
  });

  it('can be edited after generation', () => {
    const b = schema.sample('order');
    b.attr('id', 'real-id');
    b.children('customer')[0].children('name')[0].text('Real Name');
    const xml = b.toXml();
    assert.match(xml, /id="real-id"/);
    assert.match(xml, /<name>Real Name<\/name>/);
  });

  it('adds type comments on request', () => {
    const xml = schema.sample('order', { comments: true }).toString();
    assert.match(xml, /<!-- CustomerType \[1\.\.1\] -->/);
  });
});

describe('cli', () => {
  it('sample / build / validate round trip', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xsdkit-'));
    try {
      const out = path.join(dir, 'sample.xml');
      execFileSync(process.execPath, [cli, 'sample', fixture('order.xsd'), 'order', '--optional', '-o', out], { stdio: 'pipe' });
      assert.equal(run('validate', fixture('order.xsd'), out).status, 0);

      const json = path.join(dir, 'in.json');
      fs.writeFileSync(
        json,
        JSON.stringify({
          order: {
            '@id': 'o1',
            '@orderDate': '2024-01-01',
            customer: { name: 'A' },
            shipTo: { street: 's', city: 'c', postalCode: '12345' },
            items: { item: { sku: 'AB-1234', quantity: 1, price: { '@currency': 'USD', '#text': 5 } } },
            invoice: null,
          },
        }),
      );
      const built = run('build', fixture('order.xsd'), json, '--compact');
      assert.equal(built.status, 0, built.stderr);
      assert.match(built.stdout, /<invoice xsi:nil="true"\/>/);

      fs.writeFileSync(json, JSON.stringify({ order: { '@id': 'o1', customer: { name: 'A' } } }));
      const bad = run('build', fixture('order.xsd'), json);
      assert.equal(bad.status, 2);
      assert.match(bad.stderr, /Missing required attribute "orderDate"/);

      const badXml = path.join(dir, 'bad.xml');
      fs.writeFileSync(badXml, '<order xmlns="urn:example:order" id="x"/>');
      const v = run('validate', fixture('order.xsd'), badXml);
      assert.equal(v.status, 1);
      assert.match(v.stdout, /is NOT valid/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tree and info', () => {
    const t = run('tree', fixture('order.xsd'), 'order');
    assert.equal(t.status, 0);
    assert.match(t.stdout, /item \[1\.\.\*\] : ItemType/);
    const i = run('info', fixture('order.xsd'));
    assert.match(i.stdout, /order : OrderType/);
    assert.equal(run('tree', fixture('order.xsd'), 'nope').status, 2);
  });
});
