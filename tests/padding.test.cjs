const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/tilda-monaco.user.js'), 'utf8');
const installer = source.slice(source.indexOf('  // Theme catalogue'), source.indexOf('\n  function tildaMenu('));
const fields = ['margintop', 'marginbottom', 'margintop_res_480', 'marginbottom_res_480'];

// Native field definitions observed in Tilda. Mobile fields start hidden and
// share a split row; these relationships must survive changing the input type.
const options = Object.freeze([
  Object.freeze({ v: '', RU: 'Не задан', EN: 'None' }),
  ...['0px', '15px', '30px', '210px'].map(v => Object.freeze({ v, EN: v })),
]);
const definitions = Object.freeze({
  margintop: Object.freeze({ type: 'sb', label: { RU: 'Отступ сверху' }, mobile: 'margintop_res_480', options }),
  marginbottom: Object.freeze({ type: 'sb', split: 'margintop', mobile: 'marginbottom_res_480', options }),
  margintop_res_480: Object.freeze({ type: 'sb', desktop: 'margintop', display: 'none', options }),
  marginbottom_res_480: Object.freeze({ type: 'sb', desktop: 'marginbottom', display: 'none', split: 'margintop_res_480', options }),
  align: Object.freeze({ type: 'sb', options: [{ v: 'left' }, { v: 'center' }] }),
});

function setup(getter = (field) => definitions[field], overrides = {}) {
  const document = {
    body: {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
    ...overrides.document,
  };
  const window = Object.assign(new EventTarget(), {
    document, edrec__drawUI__getFieldObj: getter,
    edrec__validation__getFunction: () => () => '',
  }, overrides.window);
  window.top = window;
  const context = vm.createContext({
    window, document, location: { href: 'https://tilda.ru/page/?pageid=1', origin: 'https://tilda.ru' },
    MutationObserver: class { observe() {} disconnect() {} }, AbortController,
    console, setTimeout, clearTimeout, URL, useStyles: () => () => {},
    ...overrides.globals,
  });
  const install = () => vm.runInContext(installer, context);
  install();
  return { window, install, original: getter, tools: () => window.__tildaEditorTools };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

// Small UI fixture: state transitions, native-save independence, and side effects
// are tested here. Actual HTML parsing and the native panel are checked in Tilda.
function panelSetup(config = {}) {
  const requests = [], saves = [], notices = [], copies = [], opened = [], roots = [], order = [], parsed = [];
  const nativeSave = async (...args) => { saves.push(args); return 'saved'; };
  class Node extends EventTarget {
    constructor(tag) { super(); this.tag = tag; this.children = []; this.isConnected = false; this.textContent = ''; }
    setAttribute() {}
    connect(value) { this.isConnected = value; this.children.forEach(child => child.connect(value)); }
    append(...children) { this.children.push(...children); children.forEach(child => child.connect(this.isConnected)); }
    remove() { this.connect(false); }
  }
  const row = { after(root) { roots.push(root); root.connect(true); } };
  let form = config.noForm ? null : { querySelector: () => ({ closest: () => row }) };
  const s = setup(undefined, {
    document: {
      visibilityState: 'visible',
      querySelector: selector => selector === '.pe-settings-form' ? form : null,
      createElement(tag) {
        if (tag === 'textarea') return { set innerHTML(value) {
          this.textContent = value.replace(/&(amp|lt|gt|quot|#039);/g,
            (_, key) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#039': "'" })[key]);
        } };
        if (tag === 'template') return {
          set innerHTML(value) { parsed.push(value); },
          content: { querySelector(selector) {
            assert.equal(selector, 'script#tml-mobile-padding-runtime-v1');
            return config.installed ? {} : null;
          } },
        };
        return new Node(tag);
      },
    },
    window: {
      pageid: '1', projectid: '77', edrec__sendForm: nativeSave,
      td__showBubbleNotice: (text, duration) => notices.push({ text, duration }),
      navigator: { clipboard: { writeText: async text => {
        order.push('copy');
        if (config.copyError) throw new Error('Denied');
        if (config.copyWait) await config.copyWait;
        copies.push(text);
      } } },
      tp__fetch: async request => {
        requests.push(request);
        assert.equal(request.url, '/projects/get/getheadcode/');
        assert.equal(request.body.comm, 'getheadcode');
        assert.equal('pageid' in request.body, false);
        assert.equal('headcode' in request.body, false);
        if (config.request) return config.request(request);
        if (config.readError) throw new Error('Forbidden');
        const head = config.head ?? '<script>window.existing = "&amp;";</script>\r\n';
        return { project: { id: config.wrongProject ? 'other' : request.body.projectid,
          headcode: head.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') } };
      },
    },
    globals: { GM_openInTab: (url, options) => {
      order.push('open');
      if (config.openError) throw new Error('No grant');
      opened.push({ url, options });
    } },
  });
  const ui = () => { const [status, action, recheck] = roots.at(-1).children; return { status, action, recheck }; };
  const click = async button => { button.dispatchEvent(new Event('click', { cancelable: true })); await tick(); };
  return { ...s, config, requests, saves, notices, copies, opened, roots, order, parsed, nativeSave, ui, click,
    replaceForm() { form = { querySelector: () => ({ closest: () => row }) }; s.tools().scan(); },
    closeForm() { form = null; s.tools().scan(); },
  };
}

test('uses native pixel inputs for all four fields and keeps mobile visibility and split relationships', () => {
  const s = setup();
  for (const field of fields) {
    const before = definitions[field];
    const after = s.window.edrec__drawUI__getFieldObj(field);
    assert.equal(after.type, 'in_int');
    assert.equal(after.range, '0,'); // Nonnegative pixels, no fixed upper bound.
    for (const key of ['label', 'mobile', 'desktop', 'display', 'split'])
      assert.equal(after[key], before[key]);
    assert.deepEqual(Array.from(after.variants), ['0px', '15px', '30px', '210px']);
    assert.equal(after.ph.RU, 'Не задан');
    assert.equal(after.ph.EN, 'None');
    assert.equal(before.type, 'sb');
    assert.equal(before.options, options);
  }
  s.tools().dispose();
});

test('passes unrelated fields and changed native field types through unchanged', () => {
  const nativeInput = { type: 'in_float_px', range: '0,900' };
  const s = setup(field => field === 'margintop' ? nativeInput : definitions[field]);
  assert.equal(s.window.edrec__drawUI__getFieldObj('margintop'), nativeInput);
  assert.equal(s.window.edrec__drawUI__getFieldObj('align'), definitions.align);
  assert.equal(s.window.edrec__drawUI__getFieldObj('unknown'), undefined);
  s.tools().dispose();
});

test('retains native selects if the validation API is unavailable', () => {
  const s = setup(undefined, { window: { edrec__validation__getFunction: undefined } });
  assert.equal(s.window.edrec__drawUI__getFieldObj, s.original);
  s.tools().dispose();
});

test('uses native integer validation and appends px without changing an input mid-typing', () => {
  let numeric = '37', received;
  const original = (input, options) => { received = { input, options }; return () => numeric; };
  const s = setup(undefined, { window: { edrec__validation__getFunction: original } });
  const input = { name: 'margintop_res_480', value: '37.5' };
  const preview = s.window.edrec__validation__getFunction(input, { uiType: 'in_int', range: '0,', doNotModifyValue: true });
  assert.equal(preview(), '37px');
  assert.equal(input.value, '37.5');
  assert.equal(received.options.doNotModifyValue, true);
  assert.equal(received.options.range, '0,');
  const commit = s.window.edrec__validation__getFunction(input, { uiType: 'in_int', range: '0,' });
  assert.equal(commit(), '37px');
  assert.equal(input.value, '37px');
  numeric = '0';
  assert.equal(commit(), '0px');
  numeric = '';
  assert.equal(commit(), '');
  assert.equal(input.value, '');
  s.tools().dispose();
  assert.equal(s.window.edrec__validation__getFunction, original);
});

test('preserves the native getter receiver and all arguments', () => {
  let call;
  const s = setup(function (...args) { call = { receiver: this, args }; return definitions[args[0]]; });
  const receiver = {};
  s.window.edrec__drawUI__getFieldObj.call(receiver, 'marginbottom_res_480', '131', 'extra');
  assert.equal(call.receiver, receiver);
  assert.deepEqual(call.args, ['marginbottom_res_480', '131', 'extra']);
  s.tools().dispose();
});

test('hooks a late native getter before panel fields are drawn and does not stack hooks', () => {
  const s = setup(null);
  const original = field => definitions[field];
  s.window.edrec__drawUI__getFieldObj = original;
  s.window.dispatchEvent(new Event('edrec:record-panel-open'));
  const wrapped = s.window.edrec__drawUI__getFieldObj;
  assert.equal(wrapped('margintop').type, 'in_int');
  s.window.dispatchEvent(new Event('edrec:record-panel-open'));
  s.tools().scan();
  assert.equal(s.window.edrec__drawUI__getFieldObj, wrapped);
  s.tools().dispose();
  assert.equal(s.window.edrec__drawUI__getFieldObj, original);
  s.window.dispatchEvent(new Event('edrec:record-panel-open'));
  assert.equal(s.window.edrec__drawUI__getFieldObj, original);
});

test('disposal restores the native getter and makes retained hooks inactive', () => {
  const s = setup();
  const wrapped = s.window.edrec__drawUI__getFieldObj;
  s.tools().dispose();
  assert.equal(s.window.edrec__drawUI__getFieldObj, s.original);
  assert.equal(wrapped('margintop'), definitions.margintop);
});

test('disposal preserves a later wrapper belonging to another extension', () => {
  const s = setup();
  const wrapped = s.window.edrec__drawUI__getFieldObj;
  const later = (...args) => wrapped(...args);
  s.window.edrec__drawUI__getFieldObj = later;
  s.tools().dispose();
  assert.equal(s.window.edrec__drawUI__getFieldObj, later);
  assert.equal(later('margintop_res_480'), definitions.margintop_res_480);
});

test('reinstalling tools replaces the old hook and remains fully disposable', () => {
  const s = setup();
  const first = s.window.edrec__drawUI__getFieldObj;
  s.install();
  assert.notEqual(s.window.edrec__drawUI__getFieldObj, first);
  assert.equal(first('margintop'), definitions.margintop);
  assert.equal(s.window.edrec__drawUI__getFieldObj('margintop').type, 'in_int');
  s.tools().dispose();
  assert.equal(s.window.edrec__drawUI__getFieldObj, s.original);
});

test('reads HEAD once and reuses the result across scans and block settings panels', async () => {
  const s = panelSetup();
  await tick();
  assert.equal(s.requests.length, 1);
  assert.match(s.ui().status.textContent, /нужен код/);
  assert.equal(s.ui().action.textContent, 'Скопировать код и открыть HEAD');
  s.tools().scan();
  s.tools().scan();
  s.replaceForm();
  await tick();
  assert.equal(s.requests.length, 1);
  assert.equal(s.roots[0].isConnected, false);
  assert.equal(s.roots.at(-1).isConnected, true);
  assert.equal(s.window.edrec__sendForm, s.nativeSave);
  assert.equal(await s.window.edrec__sendForm('save', 'settings'), 'saved');
  assert.equal(s.requests.length, 1);
  s.tools().dispose();
});

test('never reads HEAD without an open settings panel', () => {
  const s = panelSetup({ noForm: true });
  s.tools().scan();
  assert.equal(s.requests.length, 0);
  s.tools().dispose();
});

test('copies the annotated standalone code before opening the correct global HEAD in a new tab', async () => {
  const s = panelSetup();
  await tick();
  await s.click(s.ui().action);
  assert.deepEqual(s.order, ['copy', 'open']);
  assert.equal(s.opened[0].url, 'https://tilda.ru/projects/editheadcode/?projectid=77');
  assert.equal(s.opened[0].options.active, true);
  assert.equal(s.copies.length, 1);
  assert.match(s.copies[0], /^<!-- Tilda Monaco: мобильные отступы для экранов до 480 px -->\n/);
  assert.match(s.copies[0], /<\/script>$/);
  assert.match(s.notices[0].text, /Вставьте его в конец HEAD сайта/);
  assert.equal(s.notices[0].duration, 12000);
  assert.equal(s.requests.length, 1); // Copying never saves HEAD or block settings.
  assert.equal(s.saves.length, 0);
  s.tools().dispose();

  const marker = '<script id="tml-mobile-padding-runtime-v1">';
  const runtime = s.copies[0].slice(s.copies[0].indexOf(marker) + marker.length, s.copies[0].lastIndexOf('</script>'));
  const appended = [];
  let ready;
  let records = [{ classList: ['t-rec', 't-rec_pt-res-480_0', 't-rec_pb-res-480_210'] },
    { classList: ['t-rec', 't-rec_pt-res-480_16', 't-rec_pb-res-480_240', 't-rec_pt-res-480_1;bad'] }];
  const doc = {
    readyState: 'loading', head: { append: style => appended.push(style) },
    addEventListener(event, callback) { assert.equal(event, 'DOMContentLoaded'); ready = callback; },
    querySelector: () => appended[0] ?? null,
    querySelectorAll: () => records, createElement: () => ({}),
  };
  const run = () => vm.runInNewContext(runtime, { document: doc });
  run();
  assert.equal(appended.length, 0);
  ready();
  assert.match(appended[0].textContent, /max-width:480px/);
  assert.match(appended[0].textContent, /padding-top:16px!important/);
  assert.match(appended[0].textContent, /padding-bottom:240px!important/);
  assert.doesNotMatch(appended[0].textContent, /480_0|480_210|bad/);
  doc.readyState = 'complete';
  run();
  assert.equal(appended.length, 1);
  records = [];
  run();
  assert.equal(appended[0].textContent, '');
});

test('an installed helper opens HEAD without overwriting the clipboard or offering a duplicate', async () => {
  const s = panelSetup({ installed: true });
  await tick();
  assert.match(s.ui().status.textContent, /уже есть/);
  assert.equal(s.ui().action.textContent, 'Открыть HEAD сайта');
  await s.click(s.ui().action);
  assert.equal(s.copies.length, 0);
  assert.equal(s.opened.length, 1);
  assert.equal(s.requests.length, 1);
  s.tools().dispose();
});

for (const reason of ['readError', 'wrongProject']) {
  test(`HEAD check failure is advisory and never blocks native saving: ${reason}`, async () => {
    const s = panelSetup({ [reason]: true });
    await tick();
    assert.match(s.ui().status.textContent, /Не удалось проверить/);
    assert.equal(s.ui().action.disabled, false);
    assert.equal(s.window.edrec__sendForm, s.nativeSave);
    assert.equal(await s.window.edrec__sendForm('save', 'settings'), 'saved');
    assert.equal(s.saves.length, 1);
    assert.equal(s.requests.length, 1);
    s.tools().dispose();
  });
}

test('does not navigate when copying is denied and lets the user retry', async () => {
  const s = panelSetup({ copyError: true });
  await tick();
  await s.click(s.ui().action);
  assert.equal(s.opened.length, 0);
  assert.match(s.notices.at(-1).text, /Не удалось скопировать/);
  assert.equal(s.ui().action.disabled, false);
  s.config.copyError = false;
  await s.click(s.ui().action);
  assert.equal(s.opened.length, 1);
  s.tools().dispose();
});

test('keeps the copied code and explains the manual route if opening a tab fails', async () => {
  const s = panelSetup({ openError: true });
  await tick();
  await s.click(s.ui().action);
  assert.equal(s.copies.length, 1);
  assert.equal(s.opened.length, 0);
  assert.match(s.notices.at(-1).text, /Код скопирован.*Настройки сайта/);
  s.tools().dispose();
});

test('rechecks on returns after opening HEAD and on request, without polling', async () => {
  const s = panelSetup();
  await tick();
  s.window.dispatchEvent(new Event('focus'));
  assert.equal(s.requests.length, 1);
  await s.click(s.ui().action);
  s.config.installed = true;
  s.window.dispatchEvent(new Event('focus'));
  await tick();
  assert.equal(s.requests.length, 2);
  assert.match(s.ui().status.textContent, /уже есть/);
  s.config.installed = false;
  s.window.dispatchEvent(new Event('focus'));
  await tick();
  assert.equal(s.requests.length, 3);
  assert.match(s.ui().status.textContent, /нужен код/);
  await s.click(s.ui().recheck);
  assert.equal(s.requests.length, 4);
  assert.match(s.ui().status.textContent, /нужен код/);
  s.tools().dispose();
});

test('does not share a cached HEAD result between projects', async () => {
  const s = panelSetup({ installed: true });
  await tick();
  s.config.installed = false;
  s.window.projectid = '88';
  s.tools().scan();
  await tick();
  assert.deepEqual(s.requests.map(r => r.body.projectid), ['77', '88']);
  assert.match(s.ui().status.textContent, /нужен код/);
  await s.click(s.ui().action);
  assert.match(s.opened[0].url, /projectid=88$/);
  s.tools().dispose();
});

test('deduplicates pending copies and never navigates after the panel is closed', async () => {
  let finish;
  const s = panelSetup({ copyWait: new Promise(resolve => { finish = resolve; }) });
  await tick();
  await s.click(s.ui().action);
  await s.click(s.ui().action);
  assert.equal(s.order.length, 1);
  s.closeForm();
  finish();
  await tick();
  assert.equal(s.copies.length, 1);
  assert.equal(s.opened.length, 0);
  s.tools().dispose();
});

test('aborts a pending HEAD read on disposal without affecting native saving', async () => {
  const s = panelSetup({ request: request => new Promise((resolve, reject) => {
    request.controller.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  }) });
  assert.equal(s.requests.length, 1);
  assert.equal(s.ui().action.disabled, true);
  assert.equal(await s.window.edrec__sendForm('save', 'settings'), 'saved');
  s.tools().dispose();
  await tick();
  assert.equal(s.requests[0].controller.signal.aborted, true);
  assert.equal(s.roots[0].isConnected, false);
  assert.equal(s.notices.length, 0);
});
