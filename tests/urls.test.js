import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  extractHttpUrl,
  extractReferenceUrl,
  extractPageLocator,
  extractPageNumber,
  isGoogleBooksUrl,
  isArchiveUrl,
  isInternalWikiLink,
  parseArchiveOrgUrl,
} from '../core/urls.js';

function referenceWithText(text) {
  const jsdom = new JSDOM(`<!DOCTYPE html><body>
    <a id="ref" href="#cite_note-1">1</a>
    <span id="cite_note-1">${text}</span>
  </body>`);
  return { doc: jsdom.window.document, ref: jsdom.window.document.getElementById('ref') };
}

test('extractPageLocator preserves numeric ranges and extractPageNumber stays backward compatible', () => {
  const { doc, ref } = referenceWithText('Book title, pp. 317–320.');
  assert.deepEqual(extractPageLocator(ref, doc), { kind: 'pages', start: 317, end: 320, text: 'pp. 317–320' });
  assert.equal(extractPageNumber(ref, doc), 317);
});

test('extractPageLocator preserves chapter and section locators for manual PDF mapping', () => {
  const { doc, ref } = referenceWithText('Book title, chap. 2, sec. 5.');
  assert.deepEqual(extractPageLocator(ref, doc), { kind: 'text', text: 'chap. 2, sec. 5.' });
  assert.equal(extractPageNumber(ref, doc), null);
});

test('an unlinked Harvard/sfn short citation retains its locator for a manual PDF', () => {
  const jsdom = new JSDOM(`<!DOCTYPE html><body>
    <a id="ref" href="#cite_note-Popper1998ch._8,_sec._4-8">8</a>
    <ol><li id="cite_note-Popper1998ch._8,_sec._4-8">
      <span class="reference-text"><a href="#Popper1998">Popper 1998</a>, ch. 8, sec. 4.</span>
    </li></ol>
    <cite id="Popper1998" class="citation book">Popper, Karl (1998). <i>Realism and the Aim of Science</i>.</cite>
  </body>`);
  const doc = jsdom.window.document;
  const ref = doc.getElementById('ref');

  assert.equal(extractReferenceUrl(ref, doc), null);
  assert.deepEqual(extractPageLocator(ref, doc), { kind: 'text', text: 'ch. 8, sec. 4.' });
});

test('extractHttpUrl pulls href from a direct <a>', () => {
  // The function calls querySelectorAll on the element, so it needs a container
  // with an <a> tag inside it, not the <a> tag itself
  const jsdom = new JSDOM(`<!DOCTYPE html><body><span id="container"><a href="https://example.com/page">link</a></span></body>`);
  const element = jsdom.window.document.getElementById('container');
  const url = extractHttpUrl(element);
  assert.equal(url, 'https://example.com/page');
});

test('extractHttpUrl prefers a direct PDF over an earlier DOI link', () => {
  // frwiki, Trilemme de Münchhausen, ref. 3: CS1 renders the DOI before
  // "lire en ligne", but the DOI resolves to a Theses.fr landing page while
  // the second URL is the document whose cited page must be extracted.
  const pdfUrl = 'https://theses.hal.science/tel-03419625v1/file/CABOT.pdf';
  const jsdom = new JSDOM(`<!DOCTYPE html><body><span id="container">
    <a href="https://doi.org/10.70675/19d151f4z01f4z41f2zafb9z0c14a3449b53">DOI</a>
    <a href="${pdfUrl}">lire en ligne</a>
  </span></body>`);
  const element = jsdom.window.document.getElementById('container');
  assert.equal(extractHttpUrl(element), pdfUrl);
});

test('extractHttpUrl prefers Internet Archive URLs over live URLs', () => {
  const archiveUrl = 'https://web.archive.org/web/20250515222512/https://example.com/page';
  const jsdom = new JSDOM(`<!DOCTYPE html><body><span id="container">
    <a href="https://example.com/page">live</a>
    <a href="${archiveUrl}">archived</a>
  </span></body>`);
  const element = jsdom.window.document.getElementById('container');
  const url = extractHttpUrl(element);
  assert.equal(url, archiveUrl);
});

test('extractHttpUrl falls back to archive URL when no live URL exists', () => {
  const archiveUrl = 'https://web.archive.org/web/20250515222512/https://example.com/page';
  const jsdom = new JSDOM(`<!DOCTYPE html><body><span id="container">
    <a href="${archiveUrl}">archived</a>
  </span></body>`);
  const element = jsdom.window.document.getElementById('container');
  const url = extractHttpUrl(element);
  assert.equal(url, archiveUrl);
});

test('isGoogleBooksUrl recognizes books.google.com URLs', () => {
  assert.equal(isGoogleBooksUrl('https://books.google.com/books?id=abc'), true);
  assert.equal(isGoogleBooksUrl('https://example.com/'), false);
});

test('extractReferenceUrl pulls the external link out of a citation element', () => {
  const jsdom = new JSDOM(`<!DOCTYPE html><body>
    <a id="ref-1" href="#cite_note-1">1</a>
    <span id="cite_note-1" class="reference">
      <cite class="citation"><a class="external" href="https://example.com/src">src</a></cite>
    </span>
  </body>`);

  const doc = jsdom.window.document;
  const refElement = doc.getElementById('ref-1');
  const url = extractReferenceUrl(refElement, doc);
  assert.equal(url, 'https://example.com/src');
});

test('extractReferenceUrl falls back to globalThis.document when no doc arg is passed', () => {
  const jsdom = new JSDOM(`<!DOCTYPE html><body>
    <a id="ref-1" href="#cite_note-1">1</a>
    <span id="cite_note-1" class="reference">
      <cite><a href="https://example.com/fallback">fallback</a></cite>
    </span>
  </body>`);

  const refElement = jsdom.window.document.getElementById('ref-1');
  const prev = globalThis.document;
  try {
    globalThis.document = jsdom.window.document;
    // Deliberately omit the second argument — simulates the browser path.
    const url = extractReferenceUrl(refElement);
    assert.equal(url, 'https://example.com/fallback');
  } finally {
    if (prev === undefined) delete globalThis.document; else globalThis.document = prev;
  }
});

test('extractReferenceUrl handles Wikipedia REST API relative hrefs like ./Page#cite_note-1', () => {
  // The Wikipedia REST API includes a <base href="//en.wikipedia.org/wiki/">
  // and returns HTML with relative URLs. JSDOM preserves the literal href attribute,
  // so we get hrefs like "./Sky#cite_note-1" instead of pure fragments.
  const jsdom = new JSDOM(`<!DOCTYPE html><body>
    <a id="ref-1" href="./Sky#cite_note-1">1</a>
    <span id="cite_note-1" class="reference">
      <cite class="citation"><a class="external" href="https://example.com/sky-source">Sky research</a></cite>
    </span>
  </body>`);

  const doc = jsdom.window.document;
  const refElement = doc.getElementById('ref-1');
  const url = extractReferenceUrl(refElement, doc);
  assert.equal(url, 'https://example.com/sky-source');
});

test('parseArchiveOrgUrl extracts timestamp and original URL', () => {
  const result = parseArchiveOrgUrl('https://web.archive.org/web/20250515222512/https://example.com/page');
  assert.deepEqual(result, { timestamp: '20250515222512', originalUrl: 'https://example.com/page' });
});

test('parseArchiveOrgUrl handles id_ URLs', () => {
  const result = parseArchiveOrgUrl('https://web.archive.org/web/20250515222512id_/https://example.com/page');
  assert.deepEqual(result, { timestamp: '20250515222512', originalUrl: 'https://example.com/page' });
});

test('parseArchiveOrgUrl returns null for non-archive URLs', () => {
  assert.equal(parseArchiveOrgUrl('https://example.com/page'), null);
  assert.equal(parseArchiveOrgUrl('https://archive.today/abc'), null);
});

test('isArchiveUrl detects all archive hosts', () => {
  assert.equal(isArchiveUrl('https://web.archive.org/web/2025/https://x.com'), true);
  assert.equal(isArchiveUrl('https://archive.today/abc'), true);
  assert.equal(isArchiveUrl('https://archive.is/abc'), true);
  assert.equal(isArchiveUrl('https://example.com'), false);
});

test('extractHttpUrl falls back to live URL when no archive.org link exists', () => {
  const jsdom = new JSDOM(`<!DOCTYPE html><body><span id="container">
    <a href="https://example.com/page">live</a>
  </span></body>`);
  const element = jsdom.window.document.getElementById('container');
  assert.equal(extractHttpUrl(element), 'https://example.com/page');
});

test('isInternalWikiLink flags ISBN article and Special:BookSources wikilinks', () => {
  assert.equal(isInternalWikiLink('https://en.wikipedia.org/wiki/ISBN_(identifier)'), true);
  assert.equal(isInternalWikiLink('https://en.wikipedia.org/wiki/Special:BookSources/9788401230134'), true);
  // Sister projects and localized hosts are internal too.
  assert.equal(isInternalWikiLink('https://de.wikipedia.org/wiki/Spezial:ISBN-Suche/9788401230134'), true);
  assert.equal(isInternalWikiLink('https://en.wiktionary.org/wiki/source'), true);
  // Genuine external sources are not internal wikilinks.
  assert.equal(isInternalWikiLink('https://example.com/page'), false);
  assert.equal(isInternalWikiLink('https://books.google.com/books?id=abc'), false);
  assert.equal(isInternalWikiLink(null), false);
});

test('extractHttpUrl skips ISBN article and Special:BookSources wikilinks', () => {
  // A book-only citation: its only http links are the internal "ISBN" article
  // and the Special:BookSources magic-link target. Neither is a real source.
  const jsdom = new JSDOM(`<!DOCTYPE html><body><span id="container">
    <a href="https://en.wikipedia.org/wiki/ISBN_(identifier)">ISBN</a>
    <a href="https://en.wikipedia.org/wiki/Special:BookSources/9788401230134">9788401230134</a>
  </span></body>`);
  const element = jsdom.window.document.getElementById('container');
  assert.equal(extractHttpUrl(element), null);
});

test('extractHttpUrl returns the real source alongside ISBN wikilinks', () => {
  const jsdom = new JSDOM(`<!DOCTYPE html><body><span id="container">
    <a class="external" href="https://example.com/book-review">review</a>
    <a href="https://en.wikipedia.org/wiki/ISBN_(identifier)">ISBN</a>
    <a href="https://en.wikipedia.org/wiki/Special:BookSources/9788401230134">9788401230134</a>
  </span></body>`);
  const element = jsdom.window.document.getElementById('container');
  assert.equal(extractHttpUrl(element), 'https://example.com/book-review');
});

test('extractReferenceUrl returns null for an ISBN-only book citation', () => {
  const jsdom = new JSDOM(`<!DOCTYPE html><body>
    <a id="ref-1" href="#cite_note-1">1</a>
    <span id="cite_note-1" class="reference">
      <cite class="citation book">Walsh, Michael (1990). El mundo secreto del Opus Dei.
        <a href="https://en.wikipedia.org/wiki/ISBN_(identifier)">ISBN</a>
        <a href="https://en.wikipedia.org/wiki/Special:BookSources/9788401230134">9788401230134</a>
      </cite>
    </span>
  </body>`);
  const doc = jsdom.window.document;
  const refElement = doc.getElementById('ref-1');
  assert.equal(extractReferenceUrl(refElement, doc), null);
});

test('extractHttpUrl uses other archive services only as last resort', () => {
  const jsdom = new JSDOM(`<!DOCTYPE html><body><span id="container">
    <a href="https://archive.today/abc">archive.today</a>
    <a href="https://example.com/page">live</a>
  </span></body>`);
  const element = jsdom.window.document.getElementById('container');
  assert.equal(extractHttpUrl(element), 'https://example.com/page');
});
