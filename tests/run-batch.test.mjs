import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { processEntry, runPool, parseStatusCode } from '../run-batch.mjs';

async function makeTempEntry(name, pdfNames) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'run-batch-'));
  const pdfDir = path.join(root, 'pdfs');
  await fs.mkdir(pdfDir, { recursive: true });
  for (const n of pdfNames) await fs.writeFile(path.join(pdfDir, n), '%PDF-1.4');
  const template = path.join(root, 'template.py');
  await fs.writeFile(template, '# template');
  return {
    root,
    entry: {
      name,
      pdfDir,
      template,
      outDir: path.join(root, 'out'),
      schemaNamePattern: 'schema',
      prompt: 'do the thing'
    }
  };
}

// A fake controller factory: records the attachments seen per iteration, and
// writes dummy downloads. It emits a schema file only on the first iteration
// of an entry (detected by there being just [pdf, template], i.e. length 2).
function recordingControllerFactory(recorder, { failOnQueryPdf = null, emitSchema = true } = {}) {
  return () => {
    let attachmentCount = 0;
    let currentPdf = null;
    return {
      async query({ attachments }) {
        attachmentCount = attachments.length;
        currentPdf = path.basename(attachments[0]);
        recorder.calls.push(attachments.map((a) => path.basename(a)));
        if (failOnQueryPdf && currentPdf === failOnQueryPdf) throw new Error('boom_query');
      },
      async followUp() {
        return { text: 'STATUS_CODE: 0', codeBlocks: [] };
      },
      async downloadLastAssistantEntities() {
        return [];
      },
      async downloadLastAssistantFiles({ outDir }) {
        const files = [{ path: path.join(outDir, 'result.txt'), name: 'result.txt' }];
        await fs.writeFile(files[0].path, 'result');
        if (emitSchema && attachmentCount === 2) {
          const schema = { path: path.join(outDir, 'schema.json'), name: 'schema.json' };
          await fs.writeFile(schema.path, '{}');
          files.push(schema);
        }
        return files;
      }
    };
  };
}

const fakeBackend = {
  async createSession() {
    return { page: {}, close: async () => {} };
  }
};

test('runPool respects the concurrency limit and preserves order', async () => {
  let active = 0;
  let maxActive = 0;
  const items = [0, 1, 2, 3, 4];
  const out = await runPool(items, 2, async (n) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 10;
  });
  assert.deepEqual(out, [0, 10, 20, 30, 40]);
  assert.ok(maxActive <= 2, `maxActive was ${maxActive}`);
});

test('processEntry: sequential PDFs, schema generated first then attached to later iterations', async () => {
  const { entry } = await makeTempEntry('e1', ['b.pdf', 'a.pdf', 'c.pdf']);
  entry.chainSchema = true;
  const recorder = { calls: [] };
  const summary = await processEntry({
    entry,
    backend: fakeBackend,
    selectors: {},
    stateDir: entry.root,
    show: false,
    timeoutMs: 1000,
    makeController: recordingControllerFactory(recorder)
  });

  // Sorted order a,b,c — iteration 1 has [pdf, template]; later add the schema.
  assert.deepEqual(recorder.calls, [
    ['a.pdf', 'template.py'],
    ['b.pdf', 'template.py', 'schema.json'],
    ['c.pdf', 'template.py', 'schema.json']
  ]);

  assert.equal(summary.aborted, false);
  assert.equal(summary.pdfs.length, 3);
  assert.ok(summary.schema && summary.schema.endsWith(`schema.json`));
  // Schema copied to the stable per-entry path.
  await fs.access(path.join(entry.outDir, 'schema.json'));
  // Per-iteration folders exist.
  await fs.access(path.join(entry.outDir, '01-a'));
  await fs.access(path.join(entry.outDir, '03-c'));
});

test('processEntry: first-iteration failure (no schema match) aborts the entry only', async () => {
  const { entry } = await makeTempEntry('e2', ['a.pdf', 'b.pdf']);
  entry.chainSchema = true;
  const recorder = { calls: [] };
  const summary = await processEntry({
    entry,
    backend: fakeBackend,
    selectors: {},
    stateDir: entry.root,
    show: false,
    timeoutMs: 1000,
    makeController: recordingControllerFactory(recorder, { emitSchema: false })
  });

  assert.equal(summary.aborted, true);
  assert.equal(recorder.calls.length, 1, 'second PDF must not be attempted');
  assert.equal(summary.pdfs.length, 1);
  assert.match(summary.pdfs[0].error, /schema_not_found/);
});

test('processEntry: randomOne processes exactly one PDF and never requires a schema', async () => {
  const { entry } = await makeTempEntry('e4', ['a.pdf', 'b.pdf', 'c.pdf']);
  entry.randomOne = true;
  const recorder = { calls: [] };
  const summary = await processEntry({
    entry,
    backend: fakeBackend,
    selectors: {},
    stateDir: entry.root,
    show: false,
    timeoutMs: 1000,
    makeController: recordingControllerFactory(recorder, { emitSchema: false })
  });

  assert.equal(recorder.calls.length, 1, 'exactly one PDF should be processed');
  assert.equal(summary.pdfs.length, 1);
  assert.equal(summary.aborted, false, 'single-PDF entry must not abort for a missing schema');
  assert.equal(summary.pdfs[0].error, null);
  // The chosen PDF is one of the three, attached with just [pdf, template].
  assert.equal(recorder.calls[0].length, 2);
  assert.ok(['a.pdf', 'b.pdf', 'c.pdf'].includes(recorder.calls[0][0]));
});

test('processEntry: a later-iteration failure is recorded but the entry continues', async () => {
  const { entry } = await makeTempEntry('e3', ['a.pdf', 'b.pdf', 'c.pdf']);
  const recorder = { calls: [] };
  const summary = await processEntry({
    entry,
    backend: fakeBackend,
    selectors: {},
    stateDir: entry.root,
    show: false,
    timeoutMs: 1000,
    makeController: recordingControllerFactory(recorder, { failOnQueryPdf: 'b.pdf' })
  });

  assert.equal(summary.aborted, false);
  assert.equal(summary.pdfs.length, 3);
  const failed = summary.pdfs.filter((p) => p.error);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].pdf, 'b.pdf');
  // c.pdf still ran after b.pdf failed.
  assert.ok(recorder.calls.some((c) => c[0] === 'c.pdf'));
});

test('parseStatusCode extracts the last STATUS_CODE', () => {
  assert.equal(parseStatusCode('blah\nSTATUS_CODE: 0'), 0);
  assert.equal(parseStatusCode('STATUS_CODE: 80\nmore\nSTATUS_CODE: 0'), 0);
  assert.equal(parseStatusCode('STATUS_CODE:40'), 40);
  assert.equal(parseStatusCode('no code here'), null);
});

async function makeOnePdfEntry(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'run-batch-'));
  const pdfDir = path.join(root, 'pdfs');
  await fs.mkdir(pdfDir, { recursive: true });
  await fs.writeFile(path.join(pdfDir, 'a.pdf'), '%PDF');
  const template = path.join(root, 'template.py');
  await fs.writeFile(template, '# t');
  return { root, entry: { name, pdfDir, template, outDir: path.join(root, 'out'), schemaNamePattern: 'schema', prompt: 'go' } };
}

function savingController(makeReply, followReply) {
  return () => ({
    async query() { return makeReply(); },
    async followUp() { return followReply(); },
    async downloadLastAssistantEntities({ outDir }) {
      const p = path.join(outDir, 'out.py');
      await fs.writeFile(p, 'x');
      return [{ path: p, name: 'out.py' }];
    },
    async downloadLastAssistantFiles() { return []; }
  });
}

test('processEntry: STATUS_CODE 80 triggers "continue" then succeeds', async () => {
  const { entry } = await makeOnePdfEntry('sc-continue');
  let q = 0; let f = 0;
  const summary = await processEntry({
    entry, backend: fakeBackend, selectors: {}, stateDir: entry.root, show: false, timeoutMs: 1000,
    makeController: savingController(() => { q++; return { text: 'partial\nSTATUS_CODE: 80', codeBlocks: [] }; },
      () => { f++; return { text: 'done\nSTATUS_CODE: 0', codeBlocks: [] }; })
  });
  assert.equal(q, 1, 'one query');
  assert.equal(f, 1, 'one continue was enough (80 -> continue -> 0)');
  assert.equal(summary.pdfs[0].status, 0);
  assert.equal(summary.pdfs[0].error, null);
  assert.equal(summary.pdfs[0].files.length, 1);
});

test('processEntry: a retry-class STATUS_CODE retries in a fresh chat then succeeds', async () => {
  const { entry } = await makeOnePdfEntry('sc-retry');
  let q = 0;
  const summary = await processEntry({
    entry, backend: fakeBackend, selectors: {}, stateDir: entry.root, show: false, timeoutMs: 1000,
    makeController: savingController(() => { q++; return { text: q === 1 ? 'fail\nSTATUS_CODE: 40' : 'ok\nSTATUS_CODE: 0', codeBlocks: [] }; },
      () => ({ text: 'STATUS_CODE: 0', codeBlocks: [] }))
  });
  assert.equal(q, 2, '40 is a retry code -> second attempt succeeds');
  assert.equal(summary.pdfs[0].status, 0);
  assert.equal(summary.pdfs[0].error, null);
});

test('processEntry: a retry code that never clears is recorded as failed', async () => {
  const { entry } = await makeOnePdfEntry('sc-fail');
  const summary = await processEntry({
    entry, backend: fakeBackend, selectors: {}, stateDir: entry.root, show: false, timeoutMs: 1000,
    makeController: savingController(() => ({ text: 'STATUS_CODE: 40', codeBlocks: [] }), () => ({ text: 'STATUS_CODE: 40', codeBlocks: [] }))
  });
  assert.equal(summary.pdfs[0].status, 40);
  assert.match(summary.pdfs[0].error, /status_40/);
});

test('processEntry: randomPerSubdir picks one PDF from each subdirectory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'run-batch-'));
  const parent = path.join(root, 'parent');
  // Two subdirs with multiple PDFs each, plus an empty one (should be skipped).
  await fs.mkdir(path.join(parent, 'sub_a'), { recursive: true });
  await fs.mkdir(path.join(parent, 'sub_b'), { recursive: true });
  await fs.mkdir(path.join(parent, 'sub_empty'), { recursive: true });
  for (const n of ['a1.pdf', 'a2.pdf']) await fs.writeFile(path.join(parent, 'sub_a', n), '%PDF');
  for (const n of ['b1.pdf', 'b2.pdf', 'b3.pdf']) await fs.writeFile(path.join(parent, 'sub_b', n), '%PDF');
  const template = path.join(root, 'template.py');
  await fs.writeFile(template, '# t');

  const entry = {
    name: 'coo',
    pdfDir: parent,
    template,
    outDir: path.join(root, 'out'),
    schemaNamePattern: 'schema',
    randomPerSubdir: true,
    chainSchema: false,
    prompt: 'go'
  };
  const recorder = { calls: [] };
  const summary = await processEntry({
    entry,
    backend: fakeBackend,
    selectors: {},
    stateDir: root,
    show: false,
    timeoutMs: 1000,
    makeController: recordingControllerFactory(recorder, { emitSchema: false })
  });

  // Exactly one PDF per non-empty subdir (2), each attached with just [pdf, template].
  assert.equal(recorder.calls.length, 2);
  assert.equal(summary.pdfs.length, 2);
  assert.equal(summary.aborted, false);
  assert.deepEqual(
    summary.pdfs.map((p) => p.group).sort(),
    ['sub_a', 'sub_b']
  );
  const chosenA = recorder.calls.find((c) => /^a[12]\.pdf$/.test(c[0]));
  const chosenB = recorder.calls.find((c) => /^b[123]\.pdf$/.test(c[0]));
  assert.ok(chosenA && chosenA.length === 2, 'one PDF from sub_a with [pdf, template]');
  assert.ok(chosenB && chosenB.length === 2, 'one PDF from sub_b with [pdf, template]');
  // Output is grouped by subdirectory name.
  await fs.access(path.join(entry.outDir, 'sub_a'));
  await fs.access(path.join(entry.outDir, 'sub_b'));
});
