import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

// Uses the actual pinned browser bundle and production CSS callback.
// Run explicitly: node --test tests/minify-css.integration.mjs (requires CDN access).
const source = fs.readFileSync(new URL('../src/tilda-monaco.user.js', import.meta.url), 'utf8');
const url = source.match(/https:\/\/cdn\.jsdelivr\.net\/npm\/css-tree@[^"\s]+/)[0];
const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
assert.ok(response.ok, `CSS bundle download failed: ${response.status}`);
const cssTree = await import('data:text/javascript;base64,' + Buffer.from(await response.text()).toString('base64'));
const start = source.indexOf('                minifyCSS(text, type) {');
const end = source.indexOf('                minifyJS:', start);
assert.ok(start > 0 && end > start);
const { minifyCSS } = vm.runInNewContext('({' + source.slice(start, end) + '})', { cssTree });

test('preserves nested rules and declarations following them', () => {
  const css = '.card { & > .child { color: red; } color: blue; }';
  assert.equal(minifyCSS(css), '.card{&>.child{color:red}color:blue}');
});

test('preserves unfamiliar nesting through the parser Raw fallback', () => {
  const result = minifyCSS('a { [test] {color:red} color:blue; }');
  assert.equal(result, 'a{[test] {color:red} color:blue;}');
});

test('keeps CSS URLs, calc spacing and custom-property tokens', () => {
  const css = '@import url("./theme.css"); .card { width: calc(100% - 20px); background: url("../image.png"); --tokens: 1  2; --space: ; }';
  assert.equal(minifyCSS(css), '@import url(./theme.css);.card{width:calc(100% - 20px);background:url(../image.png);--tokens: 1  2;--space: }');
});

test('supports inline declarations and media attributes', () => {
  assert.equal(minifyCSS('color: red; padding: 0  10px;', 'inline'), 'color:red;padding:0 10px');
  assert.equal(minifyCSS('screen and (width > 500px)', 'media'), 'screen and (width>500px)');
});

test('keeps layers, scope and declaration order', () => {
  assert.equal(minifyCSS('@layer base { @scope (.card) { :scope { color: red; } } }'),
    '@layer base{@scope (.card){:scope{color:red}}}');
  assert.equal(minifyCSS('a{color:red;@media(width > 500px){color:blue;}color:green;}'),
    'a{color:red;@media (width>500px){color:blue}color:green}');
});

test('does not introduce an HTML closing style tag when decoding CSS strings or URLs', () => {
  for (const css of [String.raw`.x::before{content:"\3c /StYlE>"}`, String.raw`.x{background:url("\3c /style>")}`]) {
    const result = minifyCSS(css);
    assert.doesNotMatch(result, /<\/style/i);
    // Escaping for HTML preserves the parsed CSS value, including its case.
    assert.equal(cssTree.generate(cssTree.parse(result)), cssTree.generate(cssTree.parse(css)));
  }
});
