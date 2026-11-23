import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const MAIN_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'main.js');

// Regression test for a bug where overriding a source (pasting text, or
// uploading a PDF) silently did nothing: loadManualSourceText() referenced
// MAX_MANUAL_SOURCE_CHARS, but a later cleanup deleted the module-level
// `const MAX_MANUAL_SOURCE_CHARS = ...` while leaving the references behind.
// That threw a ReferenceError as soon as any non-empty text was loaded — before
// activeSource was ever updated — and the failure was swallowed by a catch
// block that only console.error()s, so nothing appeared in the UI. The override
// panel (and the freshly-extracted PDF text sitting in its textarea) stayed
// on screen untouched, looking exactly like the upload had been ignored.
//
// main.js is a browser userscript in an IIFE that expects `mw`/`OO.ui`, so it
// can't be imported directly. Lift the module-level constant and the class
// methods under test out of the source and run them against a jsdom document
// holding the same element ids createUI() emits (same technique as
// ui_state.test.js).
function harness(state = {}) {
  const src = fs.readFileSync(MAIN_JS, 'utf8');

  const constMatch = src.match(/const MAX_MANUAL_SOURCE_CHARS = \d+;/);
  assert.ok(constMatch, 'MAX_MANUAL_SOURCE_CHARS must be defined at module scope in main.js');

  const slice = (startMarker, endMarker) => {
    const start = src.indexOf(startMarker);
    const end = src.indexOf(endMarker, start);
    assert.ok(start !== -1 && end > start, `could not locate ${JSON.stringify(startMarker)}..${JSON.stringify(endMarker)} in main.js`);
    return src.slice(start, end);
  };

  const loadManualSourceText = slice('        loadManualSourceText() {', '        cancelManualSourceText() {');
  const clearResult = slice('        clearResult() {', '        renderClaimGroupIndicator(refElement) {');

  const ids = [
    'verifier-source-text', 'verifier-verdict', 'verifier-comments', 'verifier-verdict-next',
    'verifier-action-container', 'verifier-claim-group-indicator',
  ];
  const dom = new JSDOM(`<!DOCTYPE html><body>${ids.map((id) => `<div id="${id}"></div>`).join('')}</body>`);

  const Harness = new Function('document', `
    ${constMatch[0]}
    class Harness {
      constructor(state) {
        Object.assign(this, state);
        this.statusLog = [];
      }
      t(en) { return en; }
      updateStatus(message, isError = false) { this.statusLog.push({ message, isError }); }
      // Stubbed: exercised by other tests, irrelevant to the
      // MAX_MANUAL_SOURCE_CHARS / stale-result regression under test here.
      hideSourceTextInput() {}
      updateButtonVisibility() {}
      renderUiState() {}
${loadManualSourceText}
${clearResult}
    }
    return Harness;
  `)(dom.window.document);

  const defaults = { hasResult: false, activeSource: null };
  const instance = new Harness({ ...defaults, ...state });
  return { instance, doc: dom.window.document, maxChars: Number(constMatch[0].match(/\d+/)[0]) };
}

test('loading manual source text does not throw ReferenceError', () => {
  const { instance } = harness();
  instance.sourceTextInput = { getValue: () => 'The measured extinction rate was 100 to 1,000 times the background rate.' };

  assert.doesNotThrow(() => instance.loadManualSourceText());
});

test('loading manual source text sets activeSource to the new text', () => {
  const { instance, doc } = harness();
  instance.sourceTextInput = { getValue: () => 'Real extracted PDF content about extinction rates.' };

  instance.loadManualSourceText();

  assert.match(instance.activeSource, /Real extracted PDF content about extinction rates\./);
  assert.match(doc.getElementById('verifier-source-text').innerHTML, /Manual Source Text/);
});

test('an overlong paste is trimmed to MAX_MANUAL_SOURCE_CHARS', () => {
  const { instance, maxChars } = harness();
  const longText = 'x'.repeat(maxChars + 500);
  instance.sourceTextInput = { getValue: () => longText };

  instance.loadManualSourceText();

  const loaded = instance.activeSource.replace('Manual source text:\n\n', '');
  assert.equal(loaded.length, maxChars);
});

test('overriding the source clears a stale verdict from a previous fetch', () => {
  const { instance, doc } = harness({ hasResult: true });
  doc.getElementById('verifier-verdict').textContent = 'SOURCE UNAVAILABLE';
  doc.getElementById('verifier-comments').textContent = 'Only a JavaScript-disabled notice, no article content.';
  instance.sourceTextInput = { getValue: () => 'The real article text extracted from the uploaded PDF.' };

  instance.loadManualSourceText();

  assert.equal(instance.hasResult, false, 'the stale verdict must not survive a source override');
  assert.equal(doc.getElementById('verifier-verdict').textContent, '');
  assert.equal(doc.getElementById('verifier-comments').textContent, '');
});

test('a blocked source offers the browser download and existing PDF upload path', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  assert.match(
    src,
    /if \(this\.sourceFetchWasForbidden\(fetchResult\)\) \{\s*this\.showBlockedSourceInput\(refUrl\);\s*return;/,
    'the 403 fetch branch must open the guided manual-source path',
  );
  const start = src.indexOf('        showBlockedSourceInput(url) {');
  const end = src.indexOf('        hideSourceTextInput() {', start);
  assert.ok(start !== -1 && end > start, 'could not locate showBlockedSourceInput');
  const method = src.slice(start, end);
  const dom = new JSDOM('<div id="verifier-source-text"></div>');

  const Harness = new Function('document', `
    class Harness {
      constructor() { this.calls = []; }
      t(en) { return en; }
      escapeHtml(value) {
        return String(value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');
      }
      showSourceTextInput(forOverride, message) { this.calls.push({ kind: 'input', forOverride, message }); }
      updateStatus(message, isError) { this.calls.push({ kind: 'status', message, isError }); }
${method}
    }
    return Harness;
  `)(dom.window.document);

  const instance = new Harness();
  assert.equal(instance.sourceFetchWasForbidden({ status: 403, error: 'Forbidden' }), true);
  assert.equal(instance.sourceFetchWasForbidden({ status: 200, error: 'Source returned 403' }), true);
  assert.equal(instance.sourceFetchWasForbidden({ status: 200, error: 'Source returned HTTP 403' }), true);
  assert.equal(instance.sourceFetchWasForbidden({ status: 404, error: 'Source returned HTTP 404' }), false);
  const url = 'https://example.test/source.pdf?x=1&y=2';
  instance.showBlockedSourceInput(url);

  const link = dom.window.document.querySelector('#verifier-source-text a');
  assert.equal(link.href, url);
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
  assert.equal(link.className, 'verifier-source-download-link');
  assert.match(link.textContent, /Open source to download/);
  assert.equal(instance.calls[0].kind, 'input', 'the existing upload panel must be opened');
  assert.equal(instance.calls[0].forOverride, false);
  assert.deepEqual(instance.calls.at(-1), {
    kind: 'status',
    message: 'The site refused automated access (HTTP 403). Open the source in your browser, download it, then upload the PDF below.',
    isError: true,
  });
});

test('an unlinked source opens the PDF upload path and displays its retained locator', () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  assert.match(
    src,
    /if \(!refUrl\) \{\s*this\.showUnlinkedSourceInput\(pageLocator\);\s*return;/,
    'the no-URL branch must skip fetching and open the digital-copy path',
  );
  const start = src.indexOf('        showUnlinkedSourceInput(locator) {');
  const end = src.indexOf('        // A 403 often means', start);
  assert.ok(start !== -1 && end > start, 'could not locate showUnlinkedSourceInput');
  const method = src.slice(start, end);

  const Harness = new Function(`
    class Harness {
      constructor() { this.calls = []; }
      t(en, values = {}) { return en.replace('{locator}', values.locator || ''); }
      showSourceTextInput(forOverride, message) { this.calls.push({ kind: 'input', forOverride, message }); }
      updateStatus(message) { this.calls.push({ kind: 'status', message }); }
${method}
    }
    return Harness;
  `)();

  const instance = new Harness();
  instance.showUnlinkedSourceInput({ kind: 'text', text: 'ch. 8, sec. 4.' });

  assert.equal(instance.calls[0].kind, 'input');
  assert.equal(instance.calls[0].forOverride, false);
  assert.match(instance.calls[0].message, /digital copy \(PDF\)/);
  assert.match(instance.calls[0].message, /ch\. 8, sec\. 4\./);
  assert.equal(instance.calls[1].kind, 'status');
});

test('PDF upload maps printed ranges and asks for physical pages when needed', async () => {
  const src = fs.readFileSync(MAIN_JS, 'utf8');
  assert.match(src, /this\.activeSourceLocator = pageLocator;/, 'the clicked citation locator must be retained');
  assert.match(src, /this\.extractPdfText\(file, this\.activeSourceLocator\)/, 'PDF upload must pass the retained locator');

  const start = src.indexOf('        requestPdfPageSelection(message, defaultValue = \'\') {');
  const end = src.indexOf('        // Wire an uploaded PDF', start);
  assert.ok(start !== -1 && end > start, 'could not locate PDF locator methods');
  const methods = src.slice(start, end);
  const requested = [];
  const labels = Array(400).fill(null);
  labels[9] = '317';
  labels[10] = '318';
  labels[11] = '319';
  const pdf = {
    numPages: 400,
    async getPageLabels() { return labels; },
    async getPage(number) {
      requested.push(number);
      return { async getTextContent() { return { items: [{ str: `Text on page ${number}` }] }; } };
    },
  };

  const Harness = new Function(`
    const MAX_PDF_PAGE_SELECTION = 50;
    class Harness {
      constructor(pdf) { this.pdf = pdf; }
      ensurePdfJs() { return Promise.resolve({ getDocument: () => ({ promise: Promise.resolve(this.pdf) }) }); }
      t(en, vars = {}) { return en.replace(/\\{(\\w+)\\}/g, (_, key) => vars[key] ?? ''); }
${methods}
    }
    return Harness;
  `)();
  const instance = new Harness(pdf);
  const file = { arrayBuffer: async () => new ArrayBuffer(8) };

  const printed = { kind: 'pages', start: 317, end: 319, text: 'pp. 317-319' };
  assert.equal(
    await instance.extractPdfText(file, printed),
    'Text on page 10\n\nText on page 11\n\nText on page 12',
  );
  assert.deepEqual(requested, [10, 11, 12], 'printed labels must map to physical PDF pages');

  requested.length = 0;
  instance.requestPdfPageSelection = () => '20-21';
  const textual = { kind: 'text', text: 'chap. 2, sec. 5' };
  assert.equal(
    await instance.extractPdfText(file, textual),
    'Text on page 20\n\nText on page 21',
  );
  assert.deepEqual(requested, [20, 21], 'a textual locator must use the pages supplied by the editor');

  assert.throws(
    () => instance.parsePdfPageSelection('401', 400),
    /cited page 401 is not present.*400 pages/i,
  );
});
