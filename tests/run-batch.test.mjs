import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { processEntry, runPool } from '../run-batch.mjs';
import { PERSISTENT_FILES, EDGE_CASES, VISUAL_REVIEW_SCHEMA_VERSION } from '../workflow-orchestrator.mjs';

// Realistic package-file contents so the orchestrator's envelope build sees valid JSON.
function persistentFileContent(name) {
  if (name === 'generator_report.json') return JSON.stringify({ status_code: 0, checks: { visual_quality: true } });
  if (name === 'manifest.json') return JSON.stringify({ visual_review_schema_version: VISUAL_REVIEW_SCHEMA_VERSION });
  return '# generator.py';
}
function fullEdgeDecisions() {
  return EDGE_CASES.map((name, i) => ({ case: i + 1, name, status: i >= 15 ? 'expected_failure' : 'passed' }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoles() {
  const roles = { shared: 'SHARED CONTRACT TEXT' };
  for (const r of ['controller', 'contract_auditor', 'template_analyst', 'template_architect',
    'generator_engineer', 'qa_auditor', 'repair_engineer', 'final_auditor']) {
    roles[r] = `ROLE PROMPT for ${r}`;
  }
  return roles;
}

function roleFromMessage(message) {
  const m = String(message).match(/===== ROLE: (\w+)(?: \(mode: (\w+)\))?/);
  return { role: m ? m[1].toLowerCase() : 'unknown', mode: m && m[2] ? m[2] : null };
}

// A controller factory that always passes every gate and emits the 3 persistent files.
// `recorder.calls` collects the attachment basenames seen at each chat's first query.
function passingControllerFactory(recorder, { unparseable = false } = {}) {
  return () => {
    let first = true;
    const reply = (message) => {
      const { role, mode } = roleFromMessage(message);
      const runId = String(message).match(/Active run id: ([A-Za-z0-9_-]+)/)?.[1] || 'RUN-0001';
      if (unparseable) return { text: 'no handoff here' };
      const handoff = {
        run_id: runId, role, mode, stage_status: 'passed',
        recommended_status_code: role === 'final_auditor' || (role === 'controller' && mode === 'finalize') ? 0 : null,
        artifacts: [{ path: `temporary/${role}-${mode || 'default'}.json`, sha256: 'a'.repeat(64) }],
        new_issues: [], verified_issues: [], required_reruns: [], next_role: null
      };
      if (role === 'qa_auditor' && mode === 'edge') handoff.edge_decisions = fullEdgeDecisions();
      return { text: `notes\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`` };
    };
    return {
      async query({ prompt, attachments }) {
        if (first) { recorder.calls.push((attachments || []).map((a) => path.basename(a))); first = false; }
        return reply(prompt);
      },
      async followUp({ text }) { return reply(text); },
      async downloadLastAssistantEntities({ outDir }) {
        const out = [];
        for (const name of PERSISTENT_FILES) {
          const p = path.join(outDir, name);
          await fs.writeFile(p, persistentFileContent(name));
          out.push({ path: p, name });
        }
        return out;
      },
      async downloadLastAssistantFiles() { return []; }
    };
  };
}

const fakeBackend = {
  async createSession() {
    return { page: {}, close: async () => {} };
  }
};

const FAST_WF = { maxRepairRounds: 1, perTurnTimeoutMs: 1000, successCode: 0, maxRetry: 0 };

async function makeTempEntry(name, pdfNames, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'run-batch-'));
  const pdfDir = path.join(root, 'pdfs');
  await fs.mkdir(pdfDir, { recursive: true });
  for (const n of pdfNames) await fs.writeFile(path.join(pdfDir, n), '%PDF-1.4');
  const baseGenerator = path.join(root, 'generator.py');
  await fs.writeFile(baseGenerator, '# base generator');
  return {
    root,
    entry: {
      name, pdfDir, baseGenerator, workflowDir: root, roles: makeRoles(),
      outDir: path.join(root, 'out'), ...extra
    }
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('runPool respects the concurrency limit and preserves order', async () => {
  let active = 0;
  let maxActive = 0;
  const out = await runPool([0, 1, 2, 3, 4], 2, async (n) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return n * 10;
  });
  assert.deepEqual(out, [0, 10, 20, 30, 40]);
  assert.ok(maxActive <= 2, `maxActive was ${maxActive}`);
});

test('processEntry: runs the agentic workflow per PDF and captures the 3 persistent files', async () => {
  const { entry } = await makeTempEntry('e1', ['b.pdf', 'a.pdf']);
  const recorder = { calls: [] };
  const summary = await processEntry({
    entry, backend: fakeBackend, selectors: {}, stateDir: entry.root,
    show: false, timeoutMs: 1000, workflowConfig: FAST_WF,
    makeController: passingControllerFactory(recorder), independentAudit: false
  });

  assert.equal(summary.pdfs.length, 2);
  assert.equal(summary.aborted, false);
  // Sorted order a,b; each chat attaches [pdf, generator.py].
  assert.deepEqual(recorder.calls, [
    ['a.pdf', 'generator.py'],
    ['b.pdf', 'generator.py']
  ]);
  for (const p of summary.pdfs) {
    assert.equal(p.status, 0);
    assert.equal(p.error, null);
    assert.equal(p.files.length, PERSISTENT_FILES.length);
    assert.ok(p.gatesPassed.includes('final'));
  }
  // Per-iteration folders + transcript exist.
  await fs.access(path.join(entry.outDir, '01-a', 'a.response.txt'));
  await fs.access(path.join(entry.outDir, '01-a', 'generator.py'));
  await fs.access(path.join(entry.outDir, '02-b', 'b.issues.json'));
});

test('processEntry: independentAudit opens a separate audit session for release/final', async () => {
  const { entry } = await makeTempEntry('e-audit', ['a.pdf']);
  let sessions = 0;
  const countingBackend = {
    async createSession() { sessions++; return { page: {}, close: async () => {} }; }
  };
  const firstQueries = [];
  const factory = () => {
    let first = true;
    const reply = (message) => {
      const { role, mode } = roleFromMessage(message);
      const runId = String(message).match(/Active run id: ([A-Za-z0-9_-]+)/)?.[1] || 'RUN-0001';
      const handoff = {
        run_id: runId, role, mode, stage_status: 'passed',
        recommended_status_code: role === 'final_auditor' || (role === 'controller' && mode === 'finalize') ? 0 : null,
        artifacts: [{ path: `temporary/${role}-${mode || 'd'}.json`, sha256: 'a'.repeat(64) }],
        new_issues: [], verified_issues: [], required_reruns: [], next_role: null
      };
      if (role === 'qa_auditor' && mode === 'edge') handoff.edge_decisions = fullEdgeDecisions();
      return { text: `notes\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`` };
    };
    return {
      async query({ prompt, attachments, newChat }) {
        if (first) { firstQueries.push({ names: (attachments || []).map((a) => path.basename(a)), newChat }); first = false; }
        return reply(prompt);
      },
      async followUp({ text }) { return reply(text); },
      async downloadLastAssistantEntities({ outDir }) {
        const out = [];
        for (const name of PERSISTENT_FILES) { const p = path.join(outDir, name); await fs.writeFile(p, persistentFileContent(name)); out.push({ path: p, name }); }
        return out;
      },
      async downloadLastAssistantFiles() { return []; }
    };
  };

  const summary = await processEntry({
    entry, backend: countingBackend, selectors: {}, stateDir: entry.root,
    show: false, timeoutMs: 1000, workflowConfig: FAST_WF,
    makeController: factory, independentAudit: true
  });

  assert.equal(summary.pdfs[0].status, 0);
  assert.equal(sessions, 2, 'a maker session plus an isolated audit session');
  const maker = firstQueries.find((q) => q.newChat === true);
  const audit = firstQueries.find((q) => q.newChat === false);
  assert.ok(maker, 'maker first query attaches [pdf, generator.py]');
  assert.deepEqual(maker.names.sort(), ['a.pdf', 'generator.py']);
  assert.ok(audit, 'audit first query uses newChat:false');
  assert.deepEqual(audit.names.sort(), [...PERSISTENT_FILES, 'a.pdf'].sort());
});

test('processEntry: randomOne processes exactly one PDF', async () => {
  const { entry } = await makeTempEntry('e2', ['a.pdf', 'b.pdf', 'c.pdf'], { randomOne: true });
  const recorder = { calls: [] };
  const summary = await processEntry({
    entry, backend: fakeBackend, selectors: {}, stateDir: entry.root,
    show: false, timeoutMs: 1000, workflowConfig: FAST_WF,
    makeController: passingControllerFactory(recorder), independentAudit: false
  });
  assert.equal(recorder.calls.length, 1);
  assert.equal(summary.pdfs.length, 1);
  assert.ok(['a.pdf', 'b.pdf', 'c.pdf'].includes(recorder.calls[0][0]));
});

test('processEntry: randomPerSubdir picks one PDF from each subdirectory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'run-batch-'));
  const parent = path.join(root, 'parent');
  await fs.mkdir(path.join(parent, 'sub_a'), { recursive: true });
  await fs.mkdir(path.join(parent, 'sub_b'), { recursive: true });
  await fs.mkdir(path.join(parent, 'sub_empty'), { recursive: true });
  for (const n of ['a1.pdf', 'a2.pdf']) await fs.writeFile(path.join(parent, 'sub_a', n), '%PDF');
  for (const n of ['b1.pdf', 'b2.pdf']) await fs.writeFile(path.join(parent, 'sub_b', n), '%PDF');
  const baseGenerator = path.join(root, 'generator.py');
  await fs.writeFile(baseGenerator, '# g');

  const entry = {
    name: 'coo', pdfDir: parent, baseGenerator, workflowDir: root, roles: makeRoles(),
    outDir: path.join(root, 'out'), randomPerSubdir: true
  };
  const recorder = { calls: [] };
  const summary = await processEntry({
    entry, backend: fakeBackend, selectors: {}, stateDir: root,
    show: false, timeoutMs: 1000, workflowConfig: FAST_WF,
    makeController: passingControllerFactory(recorder), independentAudit: false
  });

  assert.equal(recorder.calls.length, 2, 'one PDF per non-empty subdir');
  assert.equal(summary.pdfs.length, 2);
  assert.deepEqual(summary.pdfs.map((p) => p.group).sort(), ['sub_a', 'sub_b']);
  await fs.access(path.join(entry.outDir, 'sub_a'));
  await fs.access(path.join(entry.outDir, 'sub_b'));
});

test('processEntry: an unparseable workflow reply is recorded as a failure (status 99)', async () => {
  const { entry } = await makeTempEntry('e3', ['a.pdf']);
  const recorder = { calls: [] };
  const summary = await processEntry({
    entry, backend: fakeBackend, selectors: {}, stateDir: entry.root,
    show: false, timeoutMs: 1000, workflowConfig: FAST_WF,
    makeController: passingControllerFactory(recorder, { unparseable: true })
  });
  assert.equal(summary.pdfs.length, 1);
  assert.equal(summary.pdfs[0].status, 99);
  assert.match(summary.pdfs[0].error, /status_99/);
});

test('processEntry: a thrown controller error is recorded and does not abort the entry', async () => {
  const { entry } = await makeTempEntry('e4', ['a.pdf', 'b.pdf']);
  let n = 0;
  const summary = await processEntry({
    entry, backend: fakeBackend, selectors: {}, stateDir: entry.root,
    show: false, timeoutMs: 1000, workflowConfig: FAST_WF,
    makeController: () => ({
      async query() { n++; if (n === 1) throw new Error('boom'); return { text: '```json\n{"role":"x","stage_status":"passed","recommended_status_code":0}\n```' }; },
      async followUp() { return { text: '```json\n{"role":"final_auditor","stage_status":"passed","recommended_status_code":0}\n```' }; },
      async downloadLastAssistantEntities({ outDir }) {
        const p = path.join(outDir, 'generator.py'); await fs.writeFile(p, 'x');
        return [{ path: p, name: 'generator.py' }];
      },
      async downloadLastAssistantFiles() { return []; }
    })
  });
  assert.equal(summary.pdfs.length, 2);
  assert.equal(summary.aborted, false);
  assert.match(summary.pdfs[0].error, /boom/);
});
