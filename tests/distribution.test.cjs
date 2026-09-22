const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('public userscript starts with bundled styles and no local-file APIs', () => {
  const bundle = fs.readFileSync(path.join(__dirname, '../dist/tilda-monaco.user.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../src/tilda-monaco.css'), 'utf8');
  const metadata = bundle.slice(0, bundle.indexOf('// ==/UserScript=='));
  const updateURL = metadata.match(/^\/\/ @updateURL\s+(\S+)/m)?.[1];
  const downloadURL = metadata.match(/^\/\/ @downloadURL\s+(\S+)/m)?.[1];
  assert.equal(updateURL, downloadURL);
  assert.equal(new URL(downloadURL).hostname, 'raw.githubusercontent.com');
  assert.equal(new URL(downloadURL).pathname, '/namesakehake/tilda-monaco/main/dist/tilda-monaco.user.js');
  assert.doesNotMatch(bundle, /file:\/\/|GM_getResourceText/);
  assert.doesNotMatch(metadata, /@require\b|@resource\b/);

  const styles = [], commands = [];
  const document = {
    body: {},
    head: { append: element => styles.push(element) },
    createElement: () => ({ remove() { this.removed = true; } }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const window = { document, addEventListener() {} };
  window.top = window;
  vm.runInNewContext(bundle, {
    window, unsafeWindow: window, document,
    location: { href: 'https://tilda.ru/page/?pageid=1', origin: 'https://tilda.ru' },
    MutationObserver: class { observe() {} disconnect() {} },
    AbortController, console, setTimeout, clearTimeout,
    GM_registerMenuCommand: (label, callback) => commands.push({ label, callback }),
  });
  assert.equal(styles.length, 1);
  assert.equal(styles[0].textContent, css);
  assert.equal(typeof window.__tildaMonaco.scan, 'function');
  assert.equal(typeof window.__tildaEditorTools.publishProject, 'function');
  assert.equal(commands.length, 3);
  window.__tildaMonaco.dispose();
  assert.equal(styles[0].removed, undefined);
  window.__tildaEditorTools.dispose();
  assert.equal(styles[0].removed, true);
});
