const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(require('node:path').join(__dirname, '../src/tilda-monaco.user.js'), 'utf8');
const installer = source.slice(source.indexOf('  // Theme catalogue'), source.indexOf('\n  function tildaMenu('));

function setup(config = {}) {
  const trace = [], notices = [];
  const project = { id: '77', ...config.project };
  const pages = config.pages || [
    { id: '1', folderid: '0' }, { id: '2', folderid: 'active' },
    { id: '3', folderid: 'active' }, { id: '4', folderid: 'archive' },
  ];
  const folders = Object.hasOwn(config, 'folders') ? config.folders
    : [{ id: 'archive', archive: 'y' }, { id: 'active', archive: '' }];
  let version = 1;
  const frame = {
    isConnected: true,
    contentWindow: { editor: { getModel: () => ({ getAlternativeVersionId: () => version }) } },
  };
  const form = config.form ? {
    dataset: { recId: 'record1', ...(config.customSave ? { saveEvent: 'custom' } : {}) },
    classList: { contains: () => false },
    getClientRects: () => [{}],
    querySelector: (selector) => selector === '.tml-frame' ? frame : null,
  } : null;
  const document = {
    body: {}, head: { append() {} }, addEventListener() {},
    createElement: () => ({ remove() {} }),
    querySelector: (selector) => selector === '#mainmenu'
      ? { classList: { contains: () => !!config.hiddenMenu } } : null,
    querySelectorAll: (selector) => selector === '.pe-content-form,.pe-settings-form' && form ? [form] : [],
  };
  const window = {
    document, projectid: '77', pageid: '1', pagepublished: '1', addEventListener() {},
    getCSRF: () => 'test-only-csrf',
    tp__checkOpenedWidgets: () => !!config.widget,
    td__showBubbleNotice: (message) => notices.push(message),
    tp__getProjectUrl: () => ({ url: 'https://example.test' }),
    tp__menu__getProjectsData: async (fresh) => {
      trace.push({ operation: 'metadata', fresh });
      return [{ project, pages, ...(folders === undefined ? {} : { folders }) }];
    },
    tp__fetch: async (request) => {
      trace.push({ operation: 'request', ...request });
      const { comm, fromindex } = request.body;
      if (comm === 'saverecord') return config.saveReply ?? 'OK';
      if (comm === 'saverecordssort') return config.orderReply ?? 'OK';
      if (comm === 'pagepublish') return JSON.stringify({ link: 'https://example.test/page' });
      assert.equal(comm, 'projectpublish');
      if (config.batch) return config.batch(request, window);
      return JSON.stringify({ toindex: fromindex ? 3 : 2, pages: fromindex ? [{}] : [{}, {}] });
    },
    edrec__sendForm: async (action, type) => {
      trace.push({ operation: 'save', action, type });
      if (config.validationFailure) return;
      await window.tp__fetch({ url: '/page/submit/', body: { comm: 'saverecord', recordid: 'record1' } });
      if (config.editDuringSave) version++;
    },
    tp__saveRecordsSort: async () => {
      await window.tp__fetch({ url: '/page/submit/', body: { comm: 'saverecordssort' } });
    },
  };
  window.top = window;
  vm.runInNewContext(installer, {
    window, document, location: { href: 'https://tilda.ru/page/?pageid=1&projectid=77', origin: 'https://tilda.ru' },
    MutationObserver: class { observe() {} disconnect() {} }, AbortController, URLSearchParams, URL,
    console, setTimeout, clearTimeout, getComputedStyle: () => ({ visibility: 'visible' }),
    useStyles: () => () => {},
  });
  return { tools: window.__tildaEditorTools, window, trace, notices,
    batches: () => trace.filter((x) => x.body?.comm === 'projectpublish') };
}

test('saves the open block, excludes archived folders and follows the server cursor', async () => {
  const s = setup({ form: true });
  const result = await s.tools.publishProject();
  assert.equal(result.ok, true);
  assert.equal(result.published, 3);
  assert.deepEqual(s.trace.map((x) => x.operation === 'request' ? x.body.comm : x.operation),
    ['metadata', 'save', 'saverecord', 'saverecordssort', 'projectpublish', 'projectpublish']);
  assert.equal(s.trace[0].fresh, true);
  assert.equal(s.trace[1].action, 'update');
  assert.deepEqual(s.batches().map((x) => x.body.fromindex), [undefined, 2]);
  for (const request of s.batches()) {
    assert.equal(request.url, '/page/publish/');
    assert.equal(request.body.projectid, '77');
    assert.equal(request.body.folderid, undefined);
    assert.equal(request.body.pageid, undefined);
    assert.equal(request.timeout, 30);
    assert.equal(request.body.csrf, 'test-only-csrf');
  }
  assert.equal(s.tools.status().busy, false);
});

for (const [name, config] of Object.entries({
  'save rejected': { form: true, saveReply: 'ERROR' },
  'validation failed without a save request': { form: true, validationFailure: true },
  'code changed during save': { form: true, editDuringSave: true },
  'custom block save handler': { form: true, customSave: true },
  'order save rejected': { orderReply: 'ERROR' },
  'widget open': { widget: true },
  'unknown editor open': { hiddenMenu: true },
  'insufficient project permissions': { project: { shared: 'y', roles: ['pg_e'] } },
  'wrong project metadata': { project: { id: '88' } },
})) {
  test(`does not publish when ${name}`, async () => {
    const s = setup(config);
    assert.equal((await s.tools.publishProject()).ok, false);
    assert.equal(s.batches().length, 0);
    assert.equal(s.tools.status().busy, false);
  });
}

test('allows the same collaborator publishing role as Tilda', async () => {
  const s = setup({ project: { shared: 'y', roles: ['pg_p'] } });
  assert.equal((await s.tools.publishProject()).ok, true);
});

for (const folders of [undefined, null]) {
  test(`publishes a project without folders when the field is ${String(folders)}`, async () => {
    // The live sidebar response for a project without folders omits the field entirely.
    const s = setup({ folders, pages: [{ id: '1', folderid: '0' },
      { id: '2', folderid: '0' }, { id: '3', folderid: '0' }] });
    const result = await s.tools.publishProject();
    assert.equal(result.ok, true);
    assert.equal(result.published, 3);
    assert.equal(s.batches().length, 2);
  });
}

test('rejects a malformed folder list instead of losing archive information', async () => {
  const s = setup({ folders: { archive: 'y' } });
  assert.equal((await s.tools.publishProject()).ok, false);
  assert.equal(s.batches().length, 0);
});

test('does not save or publish an empty project', async () => {
  const s = setup({ pages: [], form: true });
  assert.equal((await s.tools.publishProject()).empty, true);
  assert.equal(s.trace.length, 1);
});

test('stops at a failed batch and reports partial completion without retrying', async () => {
  const s = setup({ batch: (request) => {
    if (request.body.fromindex) throw new Error('Network timeout');
    return { toindex: 2, pages: [{}, {}] };
  } });
  const result = await s.tools.publishProject();
  assert.equal(result.ok, false);
  assert.equal(result.published, 2);
  assert.equal(s.batches().length, 2);
  assert.match(s.notices.at(-1), /после 2 стр/);
});

for (const response of ['not JSON', { error: 'restriction' }, {}, { toindex: 0 }, { toindex: -1 }, { toindex: 1.5 }]) {
  test(`rejects an invalid response ${JSON.stringify(response)}`, async () => {
    const s = setup({ batch: () => response });
    assert.equal((await s.tools.publishProject()).ok, false);
    assert.equal(s.batches().length, 1);
  });
}

test('accepts a last batch cursor past the total like the native publisher', async () => {
  const s = setup({ batch: () => ({ toindex: 100, pages: [{}, {}, {}] }) });
  assert.equal((await s.tools.publishProject()).published, 3);
  assert.equal(s.batches().length, 1);
});

test('blocks duplicate project and page publication while a request is running', async () => {
  let release;
  const s = setup({ batch: () => new Promise((resolve) => { release = resolve; }) });
  const pending = s.tools.publishProject();
  while (!release) await new Promise(setImmediate);
  assert.equal((await s.tools.publishProject()).busy, true);
  assert.equal((await s.tools.publish()).busy, true);
  release({ toindex: 3, pages: [{}, {}, {}] });
  assert.equal((await pending).ok, true);
  assert.equal(s.batches().length, 1);
});

test('aborts an active request on disposal and never starts another batch', async () => {
  let started;
  const s = setup({ batch: (request) => new Promise((resolve, reject) => {
    started = true;
    request.controller.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  }) });
  const pending = s.tools.publishProject();
  while (!started) await new Promise(setImmediate);
  s.tools.dispose();
  assert.equal((await pending).ok, false);
  assert.equal(s.batches().length, 1);
});

test('keeps current-page publishing working and passes its timeout in seconds', async () => {
  const s = setup({ form: true });
  const result = await s.tools.publish();
  assert.equal(result.ok, true);
  assert.equal(result.link, 'https://example.test/page');
  assert.equal(s.trace.find((x) => x.body?.comm === 'pagepublish').timeout, 45);
  assert.equal(s.batches().length, 0);
});
