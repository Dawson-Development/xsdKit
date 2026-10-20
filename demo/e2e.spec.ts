import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#schema-state')).toHaveText('Schema ready');
});

test('generates valid XML from the bundled schema and its imports', async ({ page }, testInfo) => {
  await expect(page.getByLabel('Generated XML')).toHaveValue(/<order/);
  await expect(page.locator('#sample-state')).toHaveText('Valid XML');
  await expect(page.locator('#file-count')).toHaveText('3 schema files');
  await expect(page.locator('.brand svg')).toBeVisible();
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.width);
  await page.screenshot({ path: testInfo.outputPath('playground.png'), fullPage: true });
});

test('supports sample options, roots, and the schema tree', async ({ page }) => {
  await page.getByLabel('Optional elements').check();
  await page.getByLabel('Type comments').check();
  await expect(page.getByLabel('Generated XML')).toHaveValue(/<!--/);
  await expect(page.getByLabel('Generated XML')).toHaveValue(/billTo/);
  await page.getByRole('tab', { name: 'Schema tree' }).click();
  await expect(page.locator('#tree')).toContainText('customer');
  await page.getByLabel('Root element').selectOption('publicNote');
  await expect(page.locator('#tree')).toContainText('publicNote');
});

test('validates generated and malformed XML with actionable errors', async ({ page }) => {
  await page.getByRole('button', { name: 'Validate this XML' }).click();
  await expect(page.locator('#validation')).toHaveText('Valid XML');
  await page.getByLabel('XML to validate').fill('<order>');
  await page.getByRole('button', { name: 'Validate XML', exact: true }).click();
  await expect(page.locator('#validation')).toContainText('Not well-formed');
  await expect(page.locator('#validation')).toContainText('line 1');
});

test('rejects invalid schemas and recovers after reset', async ({ page }) => {
  await page.getByLabel('XSD source').fill('<broken>');
  await expect(page.getByRole('button', { name: 'Copy output' })).toBeDisabled();
  await page.getByRole('button', { name: 'Apply schema' }).click();
  await expect(page.locator('#schema-state')).toHaveText('Schema error');
  await expect(page.locator('#message')).toBeVisible();
  await page.getByRole('button', { name: 'Reset example' }).click();
  await expect(page.locator('#schema-state')).toHaveText('Schema ready');
  await expect(page.getByLabel('Generated XML')).toHaveValue(/<order/);
});

test('opens local schemas with includes without uploading them', async ({ page }) => {
  const outgoing: string[] = [];
  page.on('request', (request) => { if (request.method() !== 'GET') outgoing.push(request.url()); });
  await page.locator('#upload').setInputFiles([
    { name: 'main.xsd', mimeType: 'application/xml', buffer: Buffer.from('<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:include schemaLocation="types.xsd"/><xs:element name="score" type="Score"/></xs:schema>') },
    { name: 'types.xsd', mimeType: 'application/xml', buffer: Buffer.from('<xs:schema xmlns:xs="http://www.w3.org/2001/XMLSchema"><xs:simpleType name="Score"><xs:restriction base="xs:int"><xs:minInclusive value="10"/></xs:restriction></xs:simpleType></xs:schema>') },
  ]);
  await expect(page.getByLabel('Generated XML')).toHaveValue(/<score>10<\/score>/);
  await page.getByRole('button', { name: 'Validate this XML' }).click();
  await page.getByLabel('XML to validate').fill('<score>2</score>');
  await page.getByRole('button', { name: 'Validate XML', exact: true }).click();
  await expect(page.locator('#validation')).toContainText('/score (line 1)');
  await expect(page.locator('#validation')).toContainText('>= 10');
  expect(outgoing).toEqual([]);
});

test('preserves edited files and supports keyboard tabs and downloads', async ({ page }) => {
  const original = await page.getByLabel('XSD source').inputValue();
  await page.getByLabel('XSD source').fill(original.replace('A customer order.', 'An edited order.'));
  await page.getByLabel('Schema file').selectOption('address.xsd');
  await page.getByLabel('Schema file').selectOption('order.xsd');
  await expect(page.getByLabel('XSD source')).toHaveValue(/An edited order\./);
  await page.getByRole('tab', { name: 'Sample XML' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Schema tree' })).toHaveAttribute('aria-selected', 'true');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download output' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('schema-tree.txt');
});

test('copies the current output to the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const expected = await page.getByLabel('Generated XML').inputValue();
  await page.getByRole('button', { name: 'Copy output' }).click();
  await expect(page.locator('#message')).toHaveText('Output copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
});