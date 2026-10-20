import { createIcons, FileCode2, Upload, RotateCcw, Play, Copy, Download, Check, ShieldCheck, GitBranch } from 'lucide';
import { parseSchema, type Schema } from '../dist/index.js';
import order from '../test/fixtures/order.xsd?raw';
import common from '../test/fixtures/common.xsd?raw';
import address from '../test/fixtures/address.xsd?raw';
import './style.css';

const starterFiles = new Map([['order.xsd', order], ['common.xsd', common], ['address.xsd', address]]);
let files = new Map(starterFiles);
let schema: Schema | undefined;
let activeTab = 'sample';
let dirty = false;

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <header class="masthead">
    <div class="brand"><i data-lucide="file-code-2"></i><h1>xsd<span>Kit</span></h1><span class="edition">PLAYGROUND</span></div>
    <div class="header-note"><a class="github-link" href="https://github.com/Dawson-Development/xsdKit" target="_blank" rel="noopener noreferrer" aria-label="GitHub repository" title="GitHub repository"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 .5C5.65.5.5 5.65.5 12c0 5.09 3.3 9.4 7.88 10.93.58.1.79-.25.79-.56 0-.27-.01-.98-.02-1.92-3.2.7-3.88-1.54-3.88-1.54-.53-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.76 2.7 1.25 3.36.96.1-.75.4-1.25.73-1.54-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.06 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.16-1.18 3.16-1.18.63 1.59.23 2.77.12 3.06.74.81 1.18 1.84 1.18 3.1 0 4.43-2.69 5.4-5.26 5.69.41.35.78 1.04.78 2.1 0 1.52-.01 2.75-.01 3.13 0 .31.21.67.8.56A11.5 11.5 0 0 0 23.5 12C23.5 5.65 18.35.5 12 .5Z" /></svg></a><span class="local-dot"></span>Local processing<span class="version">v0.1</span></div>
  </header>
  <main>
    <div class="workspace-heading"><div><p class="eyebrow">XML SCHEMA WORKBENCH</p><h2>From schema to document.</h2></div>
      <div class="workspace-actions">
        <input id="upload" type="file" accept=".xsd,.xml" multiple hidden />
        <button id="upload-button"><i data-lucide="upload"></i>Open XSD</button>
        <button id="reset" class="icon-button" aria-label="Reset example" title="Reset example"><i data-lucide="rotate-ccw"></i></button>
      </div>
    </div>
    <div class="workbench">
      <section class="source-pane" aria-labelledby="source-title">
        <div class="pane-heading"><h3 id="source-title"><span class="step">01</span> Schema</h3><span class="language">XSD</span></div>
        <div class="source-toolbar"><label class="sr-only" for="schema-file">Schema file</label><select id="schema-file"></select>
          <button id="apply" class="primary"><i data-lucide="play"></i>Apply schema</button></div>
        <label class="sr-only" for="xsd">XSD source</label>
        <textarea id="xsd" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"></textarea>
        <div class="pane-footer"><span id="file-count"></span><span id="schema-state" role="status"></span></div>
      </section>
      <section class="output-pane" aria-labelledby="output-title">
        <div class="pane-heading"><h3 id="output-title"><span class="step">02</span> Document</h3>
          <div class="output-actions"><button id="copy" class="icon-button" title="Copy output" aria-label="Copy output"><i data-lucide="copy"></i></button>
          <button id="download" class="icon-button" title="Download output" aria-label="Download output"><i data-lucide="download"></i></button></div>
        </div>
        <div class="root-toolbar"><label for="root">Root element</label><select id="root"></select></div>
        <div class="tabs" role="tablist" aria-label="Output view">
          <button id="tab-sample" role="tab" aria-selected="true" aria-controls="panel-sample" data-tab="sample">Sample XML</button>
          <button id="tab-tree" role="tab" aria-selected="false" aria-controls="panel-tree" tabindex="-1" data-tab="tree"><i data-lucide="git-branch"></i>Schema tree</button>
          <button id="tab-validate" role="tab" aria-selected="false" aria-controls="panel-validate" tabindex="-1" data-tab="validate"><i data-lucide="shield-check"></i>Validate</button>
        </div>
        <div id="panel-sample" role="tabpanel" aria-labelledby="tab-sample">
          <div class="sample-options"><label><input id="optional" type="checkbox" />Optional elements</label><label><input id="comments" type="checkbox" />Type comments</label>
            <label class="depth">Depth <input id="depth" type="number" min="1" max="20" value="8" /></label></div>
          <label class="sr-only" for="sample">Generated XML</label><textarea id="sample" readonly spellcheck="false" wrap="off"></textarea>
          <div class="pane-footer"><span id="sample-state"></span><button id="use-sample" class="text-button">Validate this XML</button></div>
        </div>
        <div id="panel-tree" role="tabpanel" aria-labelledby="tab-tree" hidden><pre id="tree" tabindex="0"></pre></div>
        <div id="panel-validate" role="tabpanel" aria-labelledby="tab-validate" hidden>
          <div class="validate-toolbar"><span>XML document</span><button id="validate" class="primary"><i data-lucide="check"></i>Validate XML</button></div>
          <label class="sr-only" for="xml">XML to validate</label><textarea id="xml" spellcheck="false" autocapitalize="off" wrap="off"></textarea>
          <div id="validation" role="status" class="validation-result"></div>
        </div>
      </section>
    </div>
    <div id="message" role="status" hidden></div>
    <footer><span>xsdKit <span class="footer-divider">/</span> Schema-driven XML</span><span id="schema-summary"></span></footer>
  </main>`;

createIcons({ icons: { FileCode2, Upload, RotateCcw, Play, Copy, Download, Check, ShieldCheck, GitBranch } });

function element<ElementType extends HTMLElement>(id: string): ElementType {
  return document.getElementById(id) as ElementType;
}
const xsd = element<HTMLTextAreaElement>('xsd');
const fileSelect = element<HTMLSelectElement>('schema-file');
const rootSelect = element<HTMLSelectElement>('root');
const sample = element<HTMLTextAreaElement>('sample');
const xml = element<HTMLTextAreaElement>('xml');

function message(text = '', error = false): void {
  const target = element('message');
  target.textContent = text;
  target.hidden = !text;
  target.classList.toggle('error', error);
}

function fail(error: unknown): void {
  message(error instanceof Error ? error.message : String(error), true);
}

function updateControls(): void {
  const unavailable = !schema || dirty;
  for (const id of ['root', 'optional', 'comments', 'depth', 'validate', 'use-sample', 'copy', 'download']) {
    (element(id) as HTMLButtonElement | HTMLInputElement | HTMLSelectElement).disabled = unavailable;
  }
}

function loadFiles(selected = 'order.xsd'): void {
  fileSelect.replaceChildren(...[...files.keys()].map((name) => new Option(name, name)));
  fileSelect.value = selected;
  xsd.value = files.get(selected) ?? '';
  element('file-count').textContent = `${files.size} schema file${files.size === 1 ? '' : 's'}`;
  compile();
}

function compile(): void {
  files.set(fileSelect.value, xsd.value);
  schema = undefined;
  sample.value = '';
  element('tree').textContent = '';
  element('sample-state').textContent = '';
  element('schema-summary').textContent = '';
  element('validation').replaceChildren();
  message();
  try {
    const base = 'https://xsdkit.local/';
    const entry = new URL(fileSelect.value, base);
    const documents = new Map([...files].map(([name, content]) => [new URL(name, base).href, content]));
    schema = parseSchema(xsd.value, {
      baseDir: new URL('.', entry).href,
      resolver(location, baseId) {
        const id = new URL(location, baseId ?? entry.href).href;
        const content = documents.get(id);
        if (content === undefined) throw new Error(`Missing schema: ${location}. Open it together with the entry XSD.`);
        return { id, content };
      },
    });
    const roots = schema.elementNames.filter((name) => !schema!.getElement(name).abstract);
    if (!roots.length) throw new Error('This schema has no concrete global elements.');
    const previous = rootSelect.value;
    rootSelect.replaceChildren(...roots.map((name) => new Option(name, name)));
    rootSelect.value = roots.includes(previous) ? previous : roots[0];
    dirty = false;
    element('schema-state').textContent = 'Schema ready';
    element('schema-summary').textContent = `${schema.documents.length} documents / ${roots.length} roots / ${schema.typeNames.length} types`;
    generate();
  } catch (error) {
    schema = undefined;
    rootSelect.replaceChildren();
    element('schema-state').textContent = 'Schema error';
    fail(error);
  }
  updateControls();
}

function generate(): void {
  if (!schema || dirty) return;
  message();
  sample.value = '';
  element('sample-state').textContent = '';
  try {
    element('tree').textContent = schema.tree(rootSelect.value);
    sample.value = schema.sample(rootSelect.value, {
      optional: element<HTMLInputElement>('optional').checked,
      comments: element<HTMLInputElement>('comments').checked,
      maxDepth: Math.min(20, Math.max(1, Number(element<HTMLInputElement>('depth').value) || 8)),
    }).toXml();
    element('sample-state').textContent = 'Valid XML';
  } catch (error) {
    fail(error);
  }
}

function switchTab(tab: string): void {
  activeTab = tab;
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
    const selected = button.dataset.tab === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
    element(`panel-${button.dataset.tab}`).hidden = !selected;
  }
}

function validate(): void {
  if (!schema || dirty) return;
  try {
    const result = schema.validate(xml.value);
    const target = element('validation');
    target.replaceChildren();
    target.classList.toggle('invalid', !result.valid);
    const heading = document.createElement('strong');
    heading.textContent = result.valid ? 'Valid XML' : `${result.errors.length} validation error${result.errors.length === 1 ? '' : 's'}`;
    target.append(heading);
    for (const error of result.errors) {
      const item = document.createElement('p');
      item.textContent = `${error.path}${error.line ? ` (line ${error.line})` : ''}: ${error.message}`;
      target.append(item);
    }
  } catch (error) {
    fail(error);
  }
}

function output(): string {
  return activeTab === 'tree' ? element('tree').textContent ?? '' : activeTab === 'validate' ? xml.value : sample.value;
}

element('apply').addEventListener('click', compile);
rootSelect.addEventListener('change', generate);
for (const id of ['optional', 'comments', 'depth']) element(id).addEventListener('change', generate);
xsd.addEventListener('input', () => {
  files.set(fileSelect.value, xsd.value);
  dirty = true;
  element('schema-state').textContent = 'Unapplied changes';
  updateControls();
});
fileSelect.addEventListener('change', () => {
  xsd.value = files.get(fileSelect.value) ?? '';
  compile();
});
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tab]')) {
  button.addEventListener('click', () => switchTab(button.dataset.tab!));
  button.addEventListener('keydown', (event) => {
    const tabs = ['sample', 'tree', 'validate'];
    let index = tabs.indexOf(activeTab);
    if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else return;
    event.preventDefault();
    switchTab(tabs[index]);
    element(`tab-${tabs[index]}`).focus();
  });
}
element('validate').addEventListener('click', validate);
xml.addEventListener('input', () => element('validation').replaceChildren());
element('use-sample').addEventListener('click', () => {
  xml.value = sample.value;
  switchTab('validate');
  validate();
});
element('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(output());
    message('Output copied.');
  } catch {
    message('Clipboard unavailable. Select the output and copy it manually.', true);
  }
});
element('download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([output()], { type: activeTab === 'tree' ? 'text/plain' : 'application/xml' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = activeTab === 'tree' ? 'schema-tree.txt' : 'document.xml';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
element('upload-button').addEventListener('click', () => element<HTMLInputElement>('upload').click());
element('upload').addEventListener('change', async () => {
  const input = element<HTMLInputElement>('upload');
  const selected = [...(input.files ?? [])];
  if (!selected.length) return;
  try {
    if (selected.length > 50 || selected.some((file) => file.size > 2 * 1024 * 1024)) {
      throw new Error('Open up to 50 schemas, with a maximum size of 2 MB each.');
    }
    const entries = await Promise.all(selected.map(async (file): Promise<[string, string]> => [file.webkitRelativePath || file.name, await file.text()]));
    if (new Set(entries.map(([name]) => name)).size !== entries.length) throw new Error('Schema filenames must be unique.');
    files = new Map(entries);
    loadFiles(entries[0][0]);
  } catch (error) {
    fail(error);
  }
  input.value = '';
});
element('reset').addEventListener('click', () => {
  files = new Map(starterFiles);
  element<HTMLInputElement>('optional').checked = false;
  element<HTMLInputElement>('comments').checked = false;
  element<HTMLInputElement>('depth').value = '8';
  xml.value = '';
  loadFiles();
  switchTab('sample');
});

loadFiles();