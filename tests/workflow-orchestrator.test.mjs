import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  WorkflowOrchestrator, IssueLog, PLAN, GATES, PERSISTENT_FILES,
  parseHandoff, mergeReruns, selectFailureCode, loadRoles
} from '../workflow-orchestrator.mjs';

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('parseHandoff extracts the last fenced json handoff, ignoring other json blocks', () => {
  const text = [
    'Here is the envelope:',
    '```json',
    '{ "schema_version": "x", "status": "passed" }',
    '```',
    'And the handoff:',
    '```json',
    '{ "role": "qa_auditor", "stage_status": "passed", "recommended_status_code": null }',
    '```'
  ].join('\n');
  const h = parseHandoff(text);
  assert.equal(h.stage_status, 'passed');
  assert.equal(h.role, 'qa_auditor');
  assert.deepEqual(h.new_issues, []); // normalised
});

test('parseHandoff returns null when no handoff object is present', () => {
  assert.equal(parseHandoff('no json here'), null);
  assert.equal(parseHandoff('```json\n{ "foo": 1 }\n```'), null);
});

test('mergeReruns unions explicit reruns with issue-domain derived reruns, in QA order', () => {
  const modes = mergeReruns(['edge'], [{ domain: 'reconstruction', status: 'open' }]);
  // reconstruction -> background, baseline, edge ; plus explicit edge
  assert.deepEqual(modes, ['background', 'baseline', 'edge']);
});

test('mergeReruns ignores unknown rerun names and domains', () => {
  assert.deepEqual(mergeReruns(['nonsense'], [{ domain: 'unknown' }]), []);
});

test('selectFailureCode prefers the most-severe open issue domain code', () => {
  const issues = [
    { severity: 'minor', domain: 'placement', status: 'open' },
    { severity: 'critical', domain: 'runtime', status: 'open' }
  ];
  assert.equal(selectFailureCode(issues, 'baseline'), 20); // runtime -> 20
});

test('selectFailureCode falls back to the failing stage code', () => {
  assert.equal(selectFailureCode([], 'baseline'), 60);
  assert.equal(selectFailureCode([], 'preflight'), 30);
  assert.equal(selectFailureCode([], null, 99), 99);
});

test('IssueLog: repair marks fixed, only auditor verifies, blocking counts unverified major/critical', () => {
  const log = new IssueLog();
  log.addNew([{ issue_id: 'ISSUE-1', severity: 'major', domain: 'placement' }]);
  assert.equal(log.open().length, 1);
  assert.equal(log.blockingForRelease().length, 1);
  log.markFixed(['ISSUE-1']);
  assert.equal(log.open().length, 0);
  assert.equal(log.blockingForRelease().length, 1, 'fixed-but-unverified still blocks release');
  log.markVerified(['ISSUE-1']);
  assert.equal(log.blockingForRelease().length, 0);
});

// ---------------------------------------------------------------------------
// Scripted controller for end-to-end orchestration
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

// A controller whose replies are derived from the role/mode named in the outgoing
// message. `fail` maps "role/mode" -> number of times to return stage_status "failed"
// before passing. `severity`/`domain` shape the emitted issue.
function scriptedController(recorder, { fail = {}, severity = 'minor', domain = 'placement', writeFiles = true } = {}) {
  const failCounts = { ...fail };
  return () => {
    const reply = (message) => {
      const { role, mode } = roleFromMessage(message);
      const key = mode ? `${role}/${mode}` : role;
      recorder.turns.push(key);
      let stage_status = 'passed';
      let new_issues = [];
      if (failCounts[key] > 0) {
        failCounts[key] -= 1;
        stage_status = 'failed';
        new_issues = [{ issue_id: `ISSUE-${key}`, severity, domain, code: 'X', stage: mode || role, status: 'open' }];
      }
      const handoff = {
        run_id: 'RUN-0001', role, mode, stage_status,
        recommended_status_code: role === 'final_auditor' ? 0 : null,
        evidence: [], new_issues, verified_issues: [], required_reruns: [], next_role: null
      };
      return { text: `notes\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`` };
    };
    return {
      async query({ prompt }) { return reply(prompt); },
      async followUp({ text }) { return reply(text); },
      async downloadLastAssistantEntities({ outDir }) {
        if (!writeFiles) return [];
        const out = [];
        for (const name of PERSISTENT_FILES) {
          const p = path.join(outDir, name);
          await fs.writeFile(p, name);
          out.push({ path: p, name });
        }
        return out;
      },
      async downloadLastAssistantFiles() { return []; }
    };
  };
}

async function tmpOut() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-orch-'));
  return { root, pdf: path.join(root, 'target.pdf'), gen: path.join(root, 'generator.py'), out: path.join(root, 'out') };
}

test('run(): happy path passes every gate and returns status 0 with the 3 persistent files', async () => {
  const t = await tmpOut();
  const recorder = { turns: [] };
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { perTurnTimeoutMs: 1000 } });
  const res = await orch.run({
    pdf: t.pdf, baseGenerator: t.gen, outDir: t.out,
    controller: scriptedController(recorder)()
  });
  assert.equal(res.statusCode, 0);
  assert.equal(res.success, true);
  for (const g of GATES) assert.ok(res.gatesPassed.includes(g), `gate ${g} should pass`);
  assert.deepEqual(res.files.map((f) => f.name).sort(), [...PERSISTENT_FILES].sort());
  // First turn is the preflight contract auditor; the plan is walked in order.
  assert.equal(recorder.turns[0], 'contract_auditor/preflight');
});

test('run(): a recoverable QA gate that fails once is repaired and then passes', async () => {
  const t = await tmpOut();
  const recorder = { turns: [] };
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { perTurnTimeoutMs: 1000, maxRepairRounds: 2 } });
  const res = await orch.run({
    pdf: t.pdf, baseGenerator: t.gen, outDir: t.out,
    controller: scriptedController(recorder, { fail: { 'qa_auditor/baseline': 1 }, severity: 'minor' })()
  });
  assert.equal(res.statusCode, 0);
  assert.equal(res.success, true);
  assert.ok(res.gatesPassed.includes('baseline'));
  // The repair engineer was invoked during recovery.
  assert.ok(recorder.turns.includes('repair_engineer'), 'repair engineer should run');
});

test('run(): a QA gate that never recovers fails with the causal domain code', async () => {
  const t = await tmpOut();
  const recorder = { turns: [] };
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { perTurnTimeoutMs: 1000, maxRepairRounds: 2 } });
  const res = await orch.run({
    pdf: t.pdf, baseGenerator: t.gen, outDir: t.out,
    controller: scriptedController(recorder, { fail: { 'qa_auditor/baseline': 99 }, severity: 'major', domain: 'typography' })()
  });
  assert.equal(res.success, false);
  assert.equal(res.statusCode, 60, 'typography domain -> visual quality 60');
  assert.equal(res.failedStage, 'baseline');
  assert.ok(!res.gatesPassed.includes('baseline'));
});

test('run(): an unparseable handoff aborts with status 99', async () => {
  const t = await tmpOut();
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { perTurnTimeoutMs: 1000, reAskOnBadHandoff: false } });
  const controller = {
    async query() { return { text: 'no handoff at all' }; },
    async followUp() { return { text: 'still nothing' }; },
    async downloadLastAssistantEntities() { return []; },
    async downloadLastAssistantFiles() { return []; }
  };
  const res = await orch.run({ pdf: t.pdf, baseGenerator: t.gen, outDir: t.out, controller });
  assert.equal(res.statusCode, 99);
  assert.equal(res.success, false);
});

test('loadRoles reads the tracked workflow/roles prompts', async () => {
  const roles = await loadRoles(path.join(process.cwd(), 'workflow'));
  assert.ok(roles.shared.includes('SHARED ADAPTATION CONTRACT'));
  assert.ok(roles.qa_auditor.includes('QA AUDITOR'));
  assert.ok(roles.final_auditor.includes('FINAL AUDITOR'));
  assert.equal(Object.keys(roles).length, 9);
});

test('PLAN covers every gate exactly once and separates creation from approval', () => {
  const auditGates = PLAN.filter((s) => s.kind === 'audit' && s.gate).map((s) => s.gate);
  for (const g of GATES) assert.ok(auditGates.includes(g), `PLAN must open gate ${g}`);
  // Every writer step is followed later by an auditor (no gate is opened by a writer).
  assert.ok(PLAN.every((s) => !(s.kind === 'write' && s.gate)));
});
