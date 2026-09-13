const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/tilda-monaco.user.js'), 'utf8');
const installer = source.slice(source.indexOf('      // Minify HTML on demand;'),
  source.indexOf('      // Reuse Monaco\'s HTML tokenization'));

function setup(input = '<p>Привет</p><!-- comment -->') {
  let text = input, revision = 1, readonly = false, live = true, action, timerId = 0;
  const workers = [], released = [], notices = [], edits = [], trace = [], disposables = [];
  const timers = new Map();
  const busy = { value: false, get() { return this.value; },
    set(value) { this.value = value; }, reset() { this.value = false; } };
  const model = { getValue: () => text, getVersionId: () => revision,
    getFullModelRange: () => ({ startLineNumber: 1, endLineNumber: 1 }) };
  let activeModel = model;
  const editor = {
    createContextKey: () => busy,
    getModel: () => activeModel,
    getOption: () => readonly,
    pushUndoStop: () => trace.push('undo-stop'),
    executeEdits: (name, changes) => {
      edits.push({ name, changes }); trace.push('edit');
      text = changes[0].text; revision++; return true;
    },
    focus: () => trace.push('focus'),
    addAction: (value) => { action = value; return { dispose() {} }; },
  };
  vm.runInNewContext(installer, {
    editor, model, disposables, disposed: false, TextEncoder,
    monaco: { editor: { EditorOption: { readOnly: 'readOnly' } }, Selection: class {} },
    bridge: { alive: () => live, notice: (message, error = false) => notices.push({ message, error }) },
    createWorker: () => {
      const worker = { sent: [], postMessage(message) { this.sent.push(message); } };
      workers.push(worker); return worker;
    },
    releaseWorker: (worker) => { if (worker) released.push(worker); },
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: (id) => timers.delete(id),
  });
  return {
    action, busy, workers, released, notices, edits, trace, timers,
    text: () => text,
    change: (value) => { text = value; revision++; },
    makeReadonly: () => { readonly = true; },
    replaceModel: () => { activeModel = {}; },
    detach: () => { live = false; },
    reply: (data) => {
      const worker = workers.at(-1);
      worker.onmessage({ data: { id: worker.sent.at(-1).id, ...data } });
    },
    dispose: () => disposables.forEach(item => item.dispose()),
  };
}

test('registers minification without loading a worker until requested', async () => {
  const s = setup();
  assert.equal(s.action.id, 'tml.minifyHTML');
  assert.equal(s.workers.length, 0);
  const pending = s.action.run();
  assert.equal(s.workers.length, 1);
  assert.equal(s.busy.get(), true);
  s.reply({ text: '<p>Привет</p>' });
  await pending;
  assert.equal(s.busy.get(), false);
  assert.equal(s.timers.size, 0);
});

test('applies one native edit between undo stops and reports UTF-8 bytes', async () => {
  const input = '<p>Привет</p><!-- comment -->', output = '<p>Привет</p>';
  const s = setup(input);
  const pending = s.action.run();
  s.reply({ text: output });
  await pending;
  assert.equal(s.edits.length, 1);
  assert.equal(s.edits[0].name, 'tml.minifyHTML');
  assert.equal(s.text(), output);
  assert.deepEqual(s.trace, ['undo-stop', 'edit', 'undo-stop', 'focus']);
  assert.ok(s.notices.at(-1).message.includes(`${Buffer.byteLength(input)} → ${Buffer.byteLength(output)} байт`));
});

for (const [name, mutate] of [
  ['typing', s => s.change('<p>New content</p>')],
  ['typing followed by undo', s => { const old = s.text(); s.change('temporary'); s.change(old); }],
  ['a different model', s => s.replaceModel()],
  ['readonly mode', s => s.makeReadonly()],
  ['a detached editor', s => s.detach()],
]) {
  test(`does not apply a stale result after ${name}`, async () => {
    const s = setup();
    const pending = s.action.run();
    mutate(s);
    const current = s.text();
    s.reply({ text: '<p>Привет</p>' });
    await pending;
    assert.equal(s.edits.length, 0);
    assert.equal(s.text(), current);
    assert.equal(s.busy.get(), false);
  });
}

test('ignores duplicate runs while processing', async () => {
  const s = setup();
  const pending = s.action.run();
  await s.action.run();
  assert.equal(s.workers[0].sent.length, 1);
  s.reply({ text: '<p>Привет</p>' });
  await pending;
  assert.equal(s.edits.length, 1);
});

test('does not rewrite code when there is no size reduction', async () => {
  const s = setup('<p>Text</p>');
  const pending = s.action.run();
  s.reply({ text: '<p>Text</p>' });
  await pending;
  assert.equal(s.edits.length, 0);
  assert.equal(s.trace.length, 0);
});

test('preserves code on an error and creates a new worker for retry', async () => {
  const s = setup(), original = s.text();
  const first = s.action.run();
  s.reply({ error: 'Unable to load module' });
  await first;
  assert.equal(s.text(), original);
  assert.equal(s.edits.length, 0);
  assert.equal(s.released.length, 1);
  assert.equal(s.notices.at(-1).error, true);
  const retry = s.action.run();
  assert.equal(s.workers.length, 2);
  s.reply({ text: '<p>Привет</p>' });
  await retry;
  assert.equal(s.edits.length, 1);
});

test('terminates a timed-out worker without changing code', async () => {
  const s = setup(), original = s.text();
  const pending = s.action.run();
  [...s.timers.values()][0]();
  await pending;
  assert.equal(s.text(), original);
  assert.equal(s.edits.length, 0);
  assert.equal(s.released.length, 1);
  assert.equal(s.busy.get(), false);
  assert.equal(s.timers.size, 0);
});

test('disposal cancels a pending request without late edits or error notices', async () => {
  const s = setup();
  const pending = s.action.run();
  s.dispose();
  await pending;
  assert.equal(s.edits.length, 0);
  assert.equal(s.released.length, 1);
  assert.equal(s.timers.size, 0);
  assert.equal(s.notices.filter(item => item.error).length, 0);
  assert.equal(s.busy.get(), false);
});

test('empty and readonly editors never start a worker', async () => {
  for (const s of [setup(''), setup('   '), setup()]) {
    if (s.text().trim()) s.makeReadonly();
    await s.action.run();
    assert.equal(s.workers.length, 0);
  }
});
