import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { encodeBinary, parentPath, readText, resolvePath } from '../src/platform-browser.js';

describe('browser platform', () => {
  it('resolves schema URLs and relative imports', () => {
    assert.equal(resolvePath('<inline>.xsd'), 'https://xsdkit.local/%3Cinline%3E.xsd');
    assert.equal(resolvePath('child.xsd', 'https://example.test/schemas'), 'https://example.test/schemas/child.xsd');
    assert.equal(resolvePath('../common.xsd', parentPath('https://example.test/schemas/order.xsd')), 'https://example.test/common.xsd');
    assert.throws(() => readText('order.xsd'), /Filesystem access is unavailable/);
  });

  it('encodes binary values identically to Node for every padding length', () => {
    for (const size of [0, 1, 2, 3, 4, 255, 256, 257, 4096]) {
      const bytes = Uint8Array.from({ length: size }, (_, index) => index % 256);
      assert.equal(encodeBinary(bytes, false), Buffer.from(bytes).toString('base64'));
      assert.equal(encodeBinary(bytes, true), Buffer.from(bytes).toString('hex').toUpperCase());
    }
  });
});