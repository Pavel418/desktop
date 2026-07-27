import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  WorkflowOrchestrator, IssueLog, PLAN, GATES, PERSISTENT_FILES,
  parseHandoff, handoffResponseState, handoffValidationError, mergeReruns, selectFailureCode, issueRecordsFromHandoff, loadRoles,
  EDGE_CASES, VISUAL_REVIEW_SCHEMA_VERSION, sha256File, clampRerunsToGate, humanizeDuration
} from '../workflow-orchestrator.mjs';

test('humanizeDuration renders ms, seconds, minutes, and hours compactly', () => {
  assert.equal(humanizeDuration(540), '540ms');
  assert.equal(humanizeDuration(8000), '8s');
  assert.equal(humanizeDuration(487157), '8m 07s');
  assert.equal(humanizeDuration(3600000), '1h 00m');
  assert.equal(humanizeDuration(-5), '0ms');
});

// Realistic package-file contents so the orchestrator's envelope build (report cross-check +
// manifest schema check) sees valid JSON, mirroring what generator.py actually writes.
function persistentFileContent(name) {
  if (name === 'generator_report.json') {
    return JSON.stringify({ status_code: 0, checks: { visual_quality: true } });
  }
  if (name === 'manifest.json') {
    return JSON.stringify({ visual_review_schema_version: VISUAL_REVIEW_SCHEMA_VERSION });
  }
  return '# generator.py';
}

// A full 17-entry edge_decisions array (cases 16/17 are the expected failures).
function fullEdgeDecisions() {
  return EDGE_CASES.map((name, i) => ({
    case: i + 1,
    name,
    status: i >= 15 ? 'expected_failure' : 'passed',
    code: i === 15 ? 10 : i === 16 ? 40 : null
  }));
}

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

// Regression: a naive non-greedy brace regex (`\{[\s\S]*?\}`) truncates at the FIRST
// closing brace after a match, which cuts a real handoff off mid-way through its own
// nested `evidence` array. This is the exact shape a live run produced: narrative prose,
// then a properly fenced ```json handoff whose `evidence` is an array of {check, result,
// details} objects, with an apostrophe inside one "details" string.
const REAL_WORLD_HANDOFF_TEXT = [
  'Preflight passed. Failed checks: none.',
  "The template edit boundary is present, with the stable runtime beginning after the end marker.",
  '',
  '```json',
  JSON.stringify({
    run_id: 'RUN-0001',
    role: 'contract_auditor',
    mode: 'preflight',
    stage_status: 'passed',
    recommended_status_code: null,
    evidence: [
      { check: 'syntax_and_import', result: 'passed', details: 'generator.py parsed and imported cleanly.' },
      { check: 'target_pdf_raster', result: 'passed', details: "It's rendered at 200 DPI as a 1700x2200 RGB image." }
    ],
    new_issues: [],
    verified_issues: [],
    required_reruns: [],
    next_role: 'generator_engineer'
  }, null, 2),
  '```',
  ''
].join('\n');

test('parseHandoff: real-world shape with narrative prose + nested evidence array parses correctly', () => {
  const h = parseHandoff(REAL_WORLD_HANDOFF_TEXT);
  assert.ok(h, 'handoff should parse');
  assert.equal(h.stage_status, 'passed');
  assert.equal(h.next_role, 'generator_engineer');
  assert.equal(h.evidence.length, 2);
  assert.equal(h.evidence[1].details, "It's rendered at 200 DPI as a 1700x2200 RGB image.");
});

test('parseHandoff: works with a bare ``` fence (no "json" language tag)', () => {
  const text = REAL_WORLD_HANDOFF_TEXT.replace('```json', '```');
  const h = parseHandoff(text);
  assert.ok(h, 'handoff should parse without a json tag');
  assert.equal(h.stage_status, 'passed');
  assert.equal(h.evidence.length, 2);
});

test('parseHandoff: works with no fence at all (raw JSON after prose)', () => {
  const text = REAL_WORLD_HANDOFF_TEXT.replace(/```json\n/, '').replace(/\n```\n?$/, '\n');
  const h = parseHandoff(text);
  assert.ok(h, 'handoff should parse without any fence');
  assert.equal(h.stage_status, 'passed');
});

test('parseHandoff: tolerates a trailing comma before a closing bracket', () => {
  const text = [
    '```json',
    '{ "role": "qa_auditor", "stage_status": "passed", "evidence": [1, 2,], "new_issues": [], }',
    '```'
  ].join('\n');
  const h = parseHandoff(text);
  assert.ok(h, 'handoff should parse despite the trailing commas');
  assert.equal(h.stage_status, 'passed');
});

test('parseHandoff: skips an unrelated decoy JSON blob (e.g. a pasted report.json) before the real handoff', () => {
  const text = [
    'Here is the report I generated:',
    '```json',
    '{"scope": "sample_generation", "status_code": 0, "checks": {}}',
    '```',
    'And here is my handoff:',
    REAL_WORLD_HANDOFF_TEXT
  ].join('\n');
  const h = parseHandoff(text);
  assert.ok(h, 'handoff should parse past the decoy blob');
  assert.equal(h.stage_status, 'passed');
  assert.equal(h.role, 'contract_auditor');
});

test('handoffResponseState keeps waiting on the exact truncated live-run fragments', () => {
  assert.equal(handoffResponseState('JSON\n{'), 'incomplete');
  assert.equal(handoffResponseState('JSON\n{\n  "run_id": "RUN-0001_'), 'incomplete');
  assert.equal(handoffResponseState([
    'JSON',
    '{',
    '  "run_id": "RUN-0001",',
    '  "role": "controller",',
    '  "mode": "start",',
    '  "stage_status": "passed",',
    '  "artifacts": []'
  ].join('\n')), 'incomplete', 'parser repair must not be mistaken for stream completion');
});

test('handoffResponseState separates completed envelopes from ordinary prose', () => {
  assert.equal(handoffResponseState(JSON.stringify({
    run_id: 'RUN-0001', role: 'controller', mode: 'start', stage_status: 'passed', artifacts: []
  })), 'complete');
  assert.equal(handoffResponseState('I could not complete the requested operation.'), 'unknown');
});

test('parseHandoff: normalizes a decorative gate mode on a mode-less role', () => {
  const h = parseHandoff(JSON.stringify({
    run_id: 'run-0001', role: 'Repair Engineer', mode: 'preflight', stage_status: 'READY FOR REVIEW',
    artifacts: [{ path: '/mnt/data/plan.json', sha256: 'a'.repeat(64) }]
  }), { runId: 'RUN-0001', role: 'repair_engineer', mode: null, kind: 'audit' });
  assert.equal(h.run_id, 'RUN-0001');
  assert.equal(h.role, 'repair_engineer');
  assert.equal(h.mode, null);
  assert.equal(h.stage_status, 'ready_for_review');
});

test('parseHandoff: maps writer fixed_issues to the fixed-transition field only for writers', () => {
  const raw = JSON.stringify({
    run_id: 'RUN-0001', role: 'generator_engineer', mode: 'repair', stage_status: 'complete',
    artifacts: [{ path: '/mnt/data/generator.py', sha256: 'b'.repeat(64) }],
    fixed_issues: ['ISSUE-1']
  });
  const writer = parseHandoff(raw, { runId: 'RUN-0001', role: 'generator_engineer', mode: 'repair', kind: 'write' });
  const auditor = parseHandoff(raw, { runId: 'RUN-0001', role: 'generator_engineer', mode: 'repair', kind: 'audit' });
  assert.deepEqual(writer.verified_issues, ['ISSUE-1']);
  assert.deepEqual(auditor.verified_issues, []);
  assert.equal(writer.stage_status, 'passed');
});

test('parseHandoff: accepts JSON5/Python-like syntax without evaluating code', () => {
  const text = `\`\`\`json
  {
    run_id: 'RUN-0001', // emitted by GPT
    role: 'qa-auditor',
    mode: 'baseline',
    stage_status: 'success',
    recommended_status_code: None,
    artifacts: [{path: '/mnt/data/report.json', sha_256: '${'c'.repeat(64)}',}],
    new_issues: [],
  }
  \`\`\``;
  const h = parseHandoff(text, { runId: 'RUN-0001', role: 'qa_auditor', mode: 'baseline', kind: 'audit' });
  assert.ok(h);
  assert.equal(h.stage_status, 'passed');
  assert.equal(h.recommended_status_code, null);
  assert.equal(h.artifacts[0].sha256, 'c'.repeat(64));
});

test('parseHandoff: unwraps handoff objects and arrays', () => {
  const handoff = {
    runId: 'RUN-0001', agentRole: 'contract auditor', stageMode: 'release', stageStatus: 'completed',
    artifactEvidence: { filePath: '/mnt/data/report.json', digest: 'd'.repeat(64) },
    requiredReruns: 'regression'
  };
  const wrapped = parseHandoff(JSON.stringify({ output: { sharedHandoff: handoff } }), {
    runId: 'RUN-0001', role: 'contract_auditor', mode: 'release', kind: 'audit'
  });
  const arrayWrapped = parseHandoff(JSON.stringify([{ note: 'ignore' }, handoff]), {
    runId: 'RUN-0001', role: 'contract_auditor', mode: 'release', kind: 'audit'
  });
  for (const h of [wrapped, arrayWrapped]) {
    assert.ok(h);
    assert.equal(h.role, 'contract_auditor');
    assert.deepEqual(h.required_reruns, ['regression']);
    assert.equal(h.artifacts[0].path, '/mnt/data/report.json');
  }
});

test('parseHandoff: repairs escaped JSON and an incomplete final fence/container', () => {
  const escaped = String.raw`{\"run_id\":\"RUN-0001\",\"role\":\"controller\",\"mode\":\"start\",\"stage_status\":\"passed\",\"artifacts\":[]}`;
  assert.equal(parseHandoff(escaped)?.role, 'controller');

  const incomplete = [
    '```json',
    '{"run_id":"RUN-0001","role":"controller","mode":"start","stage_status":"passed","artifacts":[]'
  ].join('\n');
  const repaired = parseHandoff(incomplete, { runId: 'RUN-0001', role: 'controller', mode: 'start', kind: 'control' });
  assert.ok(repaired);
  assert.equal(repaired.stage_status, 'passed');
});

test('parseHandoff: chooses the expected identity when a later JSON object is a decoy', () => {
  const correct = {
    run_id: 'RUN-0001', role: 'qa_auditor', mode: 'edge', stage_status: 'passed', artifacts: []
  };
  const decoy = {
    run_id: 'RUN-OTHER', role: 'generator_engineer', mode: 'repair', stage_status: 'failed', artifacts: []
  };
  const h = parseHandoff(`${JSON.stringify(correct)}\n${JSON.stringify(decoy)}`, {
    runId: 'RUN-0001', role: 'qa_auditor', mode: 'edge', kind: 'audit'
  });
  assert.equal(h.run_id, 'RUN-0001');
  assert.equal(h.role, 'qa_auditor');
});

test('parseHandoff: does not rewrite a genuinely wrong run or role', () => {
  const h = parseHandoff(JSON.stringify({
    run_id: 'RUN-WRONG', role: 'generator_engineer', mode: 'baseline', stage_status: 'passed', artifacts: []
  }), { runId: 'RUN-0001', role: 'qa_auditor', mode: 'baseline', kind: 'audit' });
  assert.equal(h.run_id, 'RUN-WRONG');
  assert.equal(h.role, 'generator_engineer');
});

test('parseHandoff: accepts a constrained YAML-style handoff', () => {
  const text = [
    '```yaml',
    'run_id: RUN-0001',
    'role: qa auditor',
    'mode: regression',
    'stage_status: passed',
    'recommended_status_code: null',
    'artifacts:',
    '  - path: /mnt/data/regression.json',
    `    sha256: ${'e'.repeat(64)}`,
    'new_issues: []',
    'verified_issues:',
    '  - ISSUE-1',
    'required_reruns: []',
    '```'
  ].join('\n');
  const h = parseHandoff(text, { runId: 'RUN-0001', role: 'qa_auditor', mode: 'regression', kind: 'audit' });
  assert.ok(h);
  assert.equal(h.role, 'qa_auditor');
  assert.equal(h.artifacts[0].sha256, 'e'.repeat(64));
  assert.deepEqual(h.verified_issues, ['ISSUE-1']);
});

test('clampRerunsToGate drops stages downstream of the current gate', () => {
  // A geometry issue maps to template..edge; during the TEMPLATE gate only template may re-run.
  assert.deepEqual(clampRerunsToGate(['template', 'background', 'baseline', 'edge'], 'template'), ['template']);
  // During the baseline gate, template..baseline are in scope but edge/regression are not.
  assert.deepEqual(clampRerunsToGate(['template', 'baseline', 'edge', 'regression'], 'baseline'), ['template', 'baseline']);
  // At regression (last QA gate) the clamp is a no-op.
  assert.deepEqual(clampRerunsToGate(['template', 'edge', 'regression'], 'regression'), ['template', 'edge', 'regression']);
});

test('mergeReruns unions explicit reruns with issue-domain derived reruns, in QA order', () => {
  const modes = mergeReruns(['edge'], [{ domain: 'reconstruction', status: 'open' }]);
  // reconstruction -> background, baseline, fidelity, edge ; plus explicit edge
  assert.deepEqual(modes, ['background', 'baseline', 'fidelity', 'edge']);
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
  assert.equal(selectFailureCode([], 'release'), 70);
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

test('issueRecordsFromHandoff merges compact issue IDs with complete issue records', () => {
  const records = issueRecordsFromHandoff({
    new_issues: ['ISSUE-1'],
    issues: [{ issue_id: 'ISSUE-1', severity: 'critical', domain: 'runtime', evidence: 'exact defect' }]
  });
  assert.deepEqual(records, [
    { issue_id: 'ISSUE-1', severity: 'critical', domain: 'runtime', evidence: 'exact defect' }
  ]);
});

test('handoff validation rejects undocumented issue IDs and accepts complete issue records', () => {
  const base = {
    run_id: 'RUN-0001',
    role: 'contract_auditor',
    mode: 'preflight',
    stage_status: 'failed',
    recommended_status_code: 30,
    artifacts: [{ path: '/mnt/data/preflight.json', sha256: 'a'.repeat(64) }],
    verified_issues: [],
    required_reruns: ['preflight'],
    next_role: 'controller'
  };
  const step = { role: 'contract_auditor', mode: 'preflight', kind: 'audit' };
  const undocumented = parseHandoff(JSON.stringify({ ...base, new_issues: ['ISSUE-1'] }), {
    runId: 'RUN-0001', ...step
  });
  assert.match(handoffValidationError(undocumented, step, 'RUN-0001'), /complete object/);

  const complete = parseHandoff(JSON.stringify({
    ...base,
    new_issues: [{
      issue_id: 'ISSUE-1', severity: 'major', domain: 'annotation', code: 'LABEL_SCHEMA',
      stage: 'preflight', artifact: '/mnt/data/preflight.json', evidence: 'Exact schema mismatch.',
      owner: 'generator_engineer', required_reruns: ['preflight'], status: 'open'
    }]
  }), { runId: 'RUN-0001', ...step });
  assert.equal(handoffValidationError(complete, step, 'RUN-0001'), null);
});

test('IssueLog accepts v3 handoffs that reference new issues by ID', () => {
  const log = new IssueLog();
  log.addNew(['ISSUE-STRING-1']);
  assert.equal(log.snapshot()[0].issue_id, 'ISSUE-STRING-1');
  assert.equal(log.snapshot()[0].status, 'open');
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

function assignedIssueRecords(message) {
  const match = String(message).match(/Assigned open issues to address:\s*```json\s*([\s\S]*?)```/);
  if (!match) return [];
  try {
    const records = JSON.parse(match[1]);
    return Array.isArray(records)
      ? records
          .filter((record) => record && String(record.issue_id || ''))
          .map((record) => ({ issue_id: String(record.issue_id), owner: String(record.owner || '') }))
      : [];
  } catch {
    return [];
  }
}

function assignedIssueIds(message) {
  return assignedIssueRecords(message).map((r) => r.issue_id).filter(Boolean);
}

// A controller whose replies are derived from the role/mode named in the outgoing
// message. `fail` maps "role/mode" -> number of times to return stage_status "failed"
// before passing. `severity`/`domain` shape the emitted issue. `owner` overrides the
// domain-derived issue owner (used to exercise cross-gate ownership routing).
function scriptedController(recorder, { fail = {}, severity = 'minor', domain = 'placement', owner = null, strictOwnership = false, writeFiles = true } = {}) {
  const failCounts = { ...fail };
  return () => {
    const reply = (message) => {
      const { role, mode } = roleFromMessage(message);
      const assigned = assignedIssueIds(message);
      const assignedRecords = assignedIssueRecords(message);
      const runId = String(message).match(/Active run id: ([A-Za-z0-9_-]+)/)?.[1] || 'RUN-0001';
      const key = mode ? `${role}/${mode}` : role;
      recorder.turns.push(key);
      let stage_status = 'passed';
      let new_issues = [];
      if (failCounts[key] > 0) {
        failCounts[key] -= 1;
        stage_status = 'failed';
        new_issues = [{
          issue_id: `ISSUE-${key}`,
          severity,
          domain,
          code: 'X',
          stage: mode || role,
          artifact: `/mnt/data/${key}.json`,
          evidence: `Scripted evidence for ${key}`,
          owner: owner || (domain === 'geometry' || domain === 'semantics' ? 'template_architect' : 'generator_engineer'),
          required_reruns: [mode || role],
          status: 'open'
        }];
      }
      const isWriter = (role === 'generator_engineer' && mode === 'repair') || role === 'template_architect';
      const isAuditor = role === 'qa_auditor' || role === 'contract_auditor';
      let verified_issues;
      if (strictOwnership) {
        // Faithful writer→auditor separation: a writer fixes only the assigned issues it OWNS
        // and parks them for verification; an independent auditor later verifies whatever is
        // parked. This lets the stateless scripted controller model major-issue recovery (which
        // otherwise depends on chat history) and, crucially, leaves an architect-owned issue
        // unresolved if only the generator engineer is ever scheduled to repair it.
        recorder.pendingVerify = recorder.pendingVerify || [];
        if (stage_status === 'passed' && isWriter) {
          const ownedIds = assignedRecords.filter((r) => r.owner === role).map((r) => r.issue_id);
          for (const id of ownedIds) if (!recorder.pendingVerify.includes(id)) recorder.pendingVerify.push(id);
          verified_issues = ownedIds;
        } else if (stage_status === 'passed' && isAuditor) {
          verified_issues = recorder.pendingVerify.splice(0);
        } else {
          verified_issues = [];
        }
      } else {
        const mayResolveAssigned = isWriter || role === 'qa_auditor' || role === 'contract_auditor';
        verified_issues = stage_status === 'passed' && mayResolveAssigned ? assigned : [];
      }
      const handoff = {
        run_id: runId, role, mode, stage_status,
        recommended_status_code: role === 'final_auditor' || (role === 'controller' && mode === 'finalize') ? 0 : null,
        artifacts: [{ path: `temporary/${key}.json`, sha256: 'a'.repeat(64) }],
        new_issues,
        verified_issues,
        required_reruns: [], next_role: null
      };
      if (role === 'qa_auditor' && mode === 'edge' && stage_status === 'passed') {
        handoff.edge_decisions = fullEdgeDecisions();
      }
      return { text: `notes\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`` };
    };
    const respond = (message, responseState) => {
      const result = reply(message);
      if (typeof responseState === 'function') {
        recorder.responseStates = recorder.responseStates || [];
        recorder.responseStates.push(responseState(result.text));
      }
      return result;
    };
    return {
      async query({ prompt, responseState }) { return respond(prompt, responseState); },
      async followUp({ text, responseState }) { return respond(text, responseState); },
      async downloadLastAssistantEntities({ outDir }) {
        recorder.downloads = (recorder.downloads || 0) + 1;
        if (!writeFiles) return [];
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

async function tmpOut() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wf-orch-'));
  const pdf = path.join(root, 'target.pdf');
  const gen = path.join(root, 'generator.py');
  // The orchestrator's base-generator identity gate reads and hashes the generator file, so it
  // must exist on disk. Write small stand-ins for both attachments.
  await fs.writeFile(pdf, '%PDF-1.4 test\n');
  await fs.writeFile(gen, '# GPT TEMPLATE EDIT ZONE\n# END GPT TEMPLATE EDIT ZONE\n');
  return { root, pdf, gen, out: path.join(root, 'out') };
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
  // The Controller opens the run; the plan is walked in order.
  assert.equal(recorder.turns[0], 'controller/start');
  assert.equal(recorder.turns.at(-1), 'controller/finalize');
  assert.ok(recorder.responseStates.length > 0);
  assert.ok(recorder.responseStates.every((state) => state === 'complete'));
});

// Build a makeAuditController factory backed by a scripted controller, capturing the
// release turn's attachments/newChat and counting followUps, session creations, and closes.
function auditFactory(auditRecorder, opts = {}) {
  auditRecorder.turns = auditRecorder.turns || [];
  auditRecorder.queryCalls = [];
  auditRecorder.extras = [];
  auditRecorder.followUps = 0;
  auditRecorder.made = 0;
  auditRecorder.closed = 0;
  const base = scriptedController(auditRecorder, opts)();
  const controller = {
    async query(args) {
      auditRecorder.queryCalls.push({ attachments: args.attachments || [], newChat: args.newChat });
      auditRecorder.extras.push(String(args.prompt || ''));
      return base.query(args);
    },
    async followUp(args) {
      auditRecorder.followUps += 1;
      return base.followUp(args);
    }
  };
  return async () => {
    auditRecorder.made += 1;
    return { controller, close: async () => { auditRecorder.closed += 1; } };
  };
}

test('run(): release and final run in a fresh isolated audit session', async () => {
  const t = await tmpOut();
  const maker = { turns: [] };
  const audit = {};
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { perTurnTimeoutMs: 1000 } });
  const res = await orch.run({
    pdf: t.pdf, baseGenerator: t.gen, outDir: t.out,
    controller: scriptedController(maker)(),
    makeAuditController: auditFactory(audit)
  });
  assert.equal(res.statusCode, 0);
  assert.equal(res.success, true);
  for (const g of GATES) assert.ok(res.gatesPassed.includes(g), `gate ${g} should pass`);

  // The two release-decision roles ran ONLY in the audit session, not on the maker.
  assert.ok(audit.turns.includes('contract_auditor/release'), 'release audit runs in the audit session');
  assert.ok(audit.turns.includes('final_auditor'), 'final audit runs in the audit session');
  assert.ok(!maker.turns.includes('contract_auditor/release'), 'release must not run on the maker');
  assert.ok(!maker.turns.includes('final_auditor'), 'final must not run on the maker');
  // The maker chat still starts and finalizes the run.
  assert.equal(maker.turns[0], 'controller/start');
  assert.equal(maker.turns.at(-1), 'controller/finalize');

  // Exactly one audit session, opened once and closed once.
  assert.equal(audit.made, 1);
  assert.equal(audit.closed, 1);

  // The release turn opened the fresh chat with a single query: the 3 persistent files + PDF,
  // and NOT a "New chat" click (which would destroy the already-fresh temporary tab).
  assert.equal(audit.queryCalls.length, 1);
  assert.equal(audit.queryCalls[0].newChat, false);
  const names = audit.queryCalls[0].attachments.map((p) => path.basename(p)).sort();
  assert.deepEqual(names, [...PERSISTENT_FILES, path.basename(t.pdf)].sort());
  // Final was a follow-up in that same audit chat.
  assert.equal(audit.followUps, 1);
});

test('run(): a rejecting release audit fails closed and still closes the audit session', async () => {
  const t = await tmpOut();
  const maker = { turns: [] };
  const audit = {};
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { perTurnTimeoutMs: 1000 } });
  const res = await orch.run({
    pdf: t.pdf, baseGenerator: t.gen, outDir: t.out,
    controller: scriptedController(maker)(),
    // Reject the release audit every time; release/final are non-recoverable.
    makeAuditController: auditFactory(audit, { fail: { 'contract_auditor/release': 99 }, severity: 'critical', domain: 'packaging' })
  });
  assert.notEqual(res.statusCode, 0);
  assert.equal(res.success, false);
  assert.ok(!res.gatesPassed.includes('final'), 'final gate must not pass when release is rejected');
  assert.ok(!audit.turns.includes('final_auditor'), 'final should not run after release rejection');
  // The isolated tab is closed even on the failure path.
  assert.equal(audit.made, 1);
  assert.equal(audit.closed, 1);
});

// ---- Visual-review envelope (issue #3) ----

function qaReview(gate, edgeDecisions = null) {
  return {
    gate, role: 'qa_auditor', mode: gate, status: 'passed', round: 0,
    artifacts: [{ path: `temporary/${gate}.json`, sha256: 'a'.repeat(64), source: 'model_claimed' }],
    verified_issues: [], edge_decisions: edgeDecisions || []
  };
}
function sixGateReviews(edgeDecisions) {
  return ['template', 'background', 'baseline', 'fidelity', 'edge', 'regression']
    .map((g) => qaReview(g, g === 'edge' ? edgeDecisions : null));
}
async function writePackage(outDir) {
  await fs.mkdir(outDir, { recursive: true });
  const files = [];
  for (const name of PERSISTENT_FILES) {
    const p = path.join(outDir, name);
    await fs.writeFile(p, persistentFileContent(name));
    files.push({ path: p, name });
  }
  return files;
}
function envState(reviews) {
  return { issues: new IssueLog(), reviews, envelope: null, ctx: { runId: 'RUN-0001', pdfName: 'target.pdf' } };
}

test('envelope: valid reviews build an envelope with orchestrator-verified package hashes', async () => {
  const t = await tmpOut();
  const files = await writePackage(t.out);
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { enforceEdgeDecisions: true } });
  const { envelope, error } = await orch._buildAndValidateEnvelope(envState(sixGateReviews(fullEdgeDecisions())), files, t.out);
  assert.equal(error, undefined);
  assert.equal(Object.keys(envelope.gates).length, 6);
  assert.equal(envelope.edge_decisions.length, 17);
  assert.equal(envelope.package_artifacts.length, 3);
  for (const a of envelope.package_artifacts) {
    assert.equal(a.source, 'orchestrator_verified');
    const onDisk = await sha256File(path.join(t.out, a.path));
    assert.equal(a.sha256, onDisk, `real sha256 recorded for ${a.path}`);
  }
});

test('envelope: fewer than 17 edge decisions fails closed (code 60) when enforced', async () => {
  const t = await tmpOut();
  const files = await writePackage(t.out);
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { enforceEdgeDecisions: true } });
  const short = fullEdgeDecisions().slice(0, 16);
  const { envelope, error } = await orch._buildAndValidateEnvelope(envState(sixGateReviews(short)), files, t.out);
  assert.equal(envelope, undefined);
  assert.equal(error.code, 60);
});

test('envelope: a writer-authored review fails closed as self-approval (code 30)', async () => {
  const t = await tmpOut();
  const files = await writePackage(t.out);
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { enforceEdgeDecisions: true } });
  const reviews = sixGateReviews(fullEdgeDecisions());
  reviews.find((r) => r.gate === 'baseline').role = 'generator_engineer'; // writer cannot approve
  const { error } = await orch._buildAndValidateEnvelope(envState(reviews), files, t.out);
  assert.equal(error.code, 30);
});

test('envelope: a report without checks.visual_quality fails closed (code 70)', async () => {
  const t = await tmpOut();
  const files = await writePackage(t.out);
  // Overwrite the report so visual_quality is not true.
  await fs.writeFile(path.join(t.out, 'generator_report.json'), JSON.stringify({ status_code: 0, checks: {} }));
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { enforceEdgeDecisions: true } });
  const { error } = await orch._buildAndValidateEnvelope(envState(sixGateReviews(fullEdgeDecisions())), files, t.out);
  assert.equal(error.code, 70);
});

test('run(): happy path builds the envelope and returns it', async () => {
  const t = await tmpOut();
  const recorder = { turns: [] };
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { perTurnTimeoutMs: 1000, enforceEdgeDecisions: true } });
  const res = await orch.run({ pdf: t.pdf, baseGenerator: t.gen, outDir: t.out, controller: scriptedController(recorder)() });
  assert.equal(res.statusCode, 0);
  assert.ok(res.envelope, 'run() returns the built envelope');
  assert.equal(res.envelope.edge_decisions.length, 17);
  assert.equal(res.envelope.package_artifacts.length, 3);
  assert.equal(res.reviews.length, 6);
});

test('run(): the isolated release audit receives the structured envelope evidence', async () => {
  const t = await tmpOut();
  const maker = { turns: [] };
  const audit = {};
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { perTurnTimeoutMs: 1000, enforceEdgeDecisions: true } });
  const res = await orch.run({
    pdf: t.pdf, baseGenerator: t.gen, outDir: t.out,
    controller: scriptedController(maker)(),
    makeAuditController: auditFactory(audit)
  });
  assert.equal(res.statusCode, 0);
  assert.ok(audit.extras.length >= 1, 'release turn carried an evidence block');
  const evidence = audit.extras.join('\n');
  assert.match(evidence, /ORCHESTRATOR-VERIFIED PACKAGE HASHES/);
  assert.match(evidence, /17 PER-EDGE DECISIONS/);
  assert.doesNotMatch(evidence, /NOT FOUND/); // the old writer-scrape placeholders are gone
});

test('orchestrator envelope constants mirror generator.py without conflating the machine-review schema', async () => {
  const gen = await fs.readFile(new URL('../workflow/generator.py', import.meta.url), 'utf8');
  const versionMatch = gen.match(/ORCHESTRATOR_VISUAL_REVIEW_SCHEMA_VERSION\s*=\s*"([^"]+)"/);
  assert.ok(versionMatch, 'generator.py declares ORCHESTRATOR_VISUAL_REVIEW_SCHEMA_VERSION');
  assert.equal(versionMatch[1], VISUAL_REVIEW_SCHEMA_VERSION);
  const machineMatch = gen.match(/MACHINE_VISUAL_REVIEW_SCHEMA_VERSION\s*=\s*"([^"]+)"/);
  assert.ok(machineMatch, 'generator.py declares MACHINE_VISUAL_REVIEW_SCHEMA_VERSION');
  assert.notEqual(machineMatch[1], VISUAL_REVIEW_SCHEMA_VERSION);
  const block = gen.match(/EDGE_CASE_NAMES\s*=\s*\(([\s\S]*?)\)/);
  assert.ok(block, 'generator.py declares EDGE_CASE_NAMES');
  const names = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, EDGE_CASES, 'orchestrator EDGE_CASES must match generator.py EDGE_CASE_NAMES');
});

test('_normaliseHandoff canonicalizes edge_decisions aliases and backfills case from name', () => {
  const raw = {
    run_id: 'RUN-0001', role: 'qa_auditor', mode: 'edge', stage_status: 'passed',
    artifacts: [{ path: 'x', sha256: 'a'.repeat(64) }],
    edge_cases: [
      { name: 'low_dpi', decision: 'pass' },              // status alias + name→case backfill
      { case: 16, name: 'expected_max_chars_failure', result: 'xfail' }
    ]
  };
  const h = parseHandoff(`\`\`\`json\n${JSON.stringify(raw)}\n\`\`\``, { runId: 'RUN-0001', role: 'qa_auditor', mode: 'edge', kind: 'audit' });
  assert.ok(h);
  assert.equal(h.edge_decisions[0].case, 12);            // low_dpi is case 12
  assert.equal(h.edge_decisions[0].status, 'passed');
  assert.equal(h.edge_decisions[1].status, 'expected_failure');
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
  assert.ok(recorder.turns.includes('generator_engineer/repair'), 'generator writer should apply the repair plan');
});

test('run(): package download recovery requests missing attachments and then succeeds', async () => {
  const t = await tmpOut();
  const recorder = { turns: [], downloads: 0 };
  const controller = scriptedController(recorder, { writeFiles: false })();
  const regularFollowUp = controller.followUp.bind(controller);
  let attachmentsExposed = false;
  controller.followUp = async ({ text, ...rest }) => {
    if (String(text).includes('package artifacts were not all exposed')) {
      attachmentsExposed = true;
      return { text: 'Attached generator.py, manifest.json, and generator_report.json.' };
    }
    return regularFollowUp({ text, ...rest });
  };
  controller.downloadLastAssistantEntities = async ({ outDir }) => {
    recorder.downloads += 1;
    if (!attachmentsExposed) return [];
    const files = [];
    for (const name of PERSISTENT_FILES) {
      const file = path.join(outDir, name);
      await fs.writeFile(file, persistentFileContent(name));
      files.push({ path: file, name });
    }
    return files;
  };
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { perTurnTimeoutMs: 1000 } });
  const res = await orch.run({ pdf: t.pdf, baseGenerator: t.gen, outDir: t.out, controller });
  assert.equal(res.success, true);
  assert.equal(res.statusCode, 0);
  assert.equal(recorder.downloads, 2, 'initial capture plus one recovery capture');
  assert.ok(res.transcript.some((turn) => turn.mode === 'package_download'));
});

test('run(): missing package downloads fail closed with status 70', async () => {
  const t = await tmpOut();
  const recorder = { turns: [], downloads: 0 };
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { perTurnTimeoutMs: 1000 } });
  const res = await orch.run({
    pdf: t.pdf, baseGenerator: t.gen, outDir: t.out,
    controller: scriptedController(recorder, { writeFiles: false })()
  });
  assert.equal(res.success, false);
  assert.equal(res.statusCode, 70);
  assert.equal(res.failedStage, 'package');
  assert.equal(recorder.downloads, 3, 'initial capture plus two recovery captures');
  assert.ok(!recorder.turns.includes('contract_auditor/release'));
});

test('run(): staged package publishing replaces stale persistent outputs with exact names', async () => {
  const t = await tmpOut();
  await fs.mkdir(t.out, { recursive: true });
  for (const name of PERSISTENT_FILES) await fs.writeFile(path.join(t.out, name), 'stale');
  const recorder = { turns: [], downloads: 0 };
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { perTurnTimeoutMs: 1000 } });
  const res = await orch.run({
    pdf: t.pdf, baseGenerator: t.gen, outDir: t.out,
    controller: scriptedController(recorder)()
  });
  assert.equal(res.success, true);
  for (const name of PERSISTENT_FILES) {
    // Stale content is replaced by the freshly downloaded package file (no longer 'stale').
    assert.equal(await fs.readFile(path.join(t.out, name), 'utf8'), persistentFileContent(name));
  }
});

test('run(): a base generator hash mismatch fails fast with status 20 and no model turns', async () => {
  const t = await tmpOut();
  const recorder = { turns: [] };
  const orch = new WorkflowOrchestrator({
    roles: makeRoles(),
    config: { perTurnTimeoutMs: 1000, expectedGeneratorSha256: 'f'.repeat(64) }
  });
  const res = await orch.run({
    pdf: t.pdf, baseGenerator: t.gen, outDir: t.out,
    controller: scriptedController(recorder)()
  });
  assert.equal(res.success, false);
  assert.equal(res.statusCode, 20);
  assert.equal(res.failedStage, 'generator_identity');
  assert.equal(recorder.turns.length, 0, 'no model turns run when the base generator fails the identity gate');
});

test('run(): a matching base generator hash pin lets the run proceed', async () => {
  const t = await tmpOut();
  const recorder = { turns: [] };
  const goodSha = await sha256File(t.gen);
  const orch = new WorkflowOrchestrator({
    roles: makeRoles(),
    config: { perTurnTimeoutMs: 1000, expectedGeneratorSha256: goodSha }
  });
  const res = await orch.run({
    pdf: t.pdf, baseGenerator: t.gen, outDir: t.out,
    controller: scriptedController(recorder)()
  });
  assert.equal(res.success, true);
  assert.equal(recorder.turns[0], 'controller/start');
});

test('run(): template geometry repair is applied by Template Architect', async () => {
  const t = await tmpOut();
  const recorder = { turns: [] };
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { perTurnTimeoutMs: 1000, maxRepairRounds: 2 } });
  const res = await orch.run({
    pdf: t.pdf, baseGenerator: t.gen, outDir: t.out,
    controller: scriptedController(recorder, { fail: { 'qa_auditor/template': 1 }, severity: 'minor', domain: 'geometry' })()
  });
  assert.equal(res.success, true);
  assert.ok(recorder.turns.filter((turn) => turn === 'template_architect').length >= 2);
  assert.ok(recorder.turns.includes('repair_engineer'));
});

test('run(): an architect-owned issue at a non-template gate routes repair to the Template Architect', async () => {
  // Regression: a reconstruction-domain issue owned by the template_architect can surface at
  // the background gate (e.g. a reconstruction mask that must be widened in template_spec.json).
  // Writer routing must honor the issue `owner`, not infer it from the gate — otherwise the
  // architect is never scheduled, the generator engineer returns `blocked`, and the whole repair
  // aborts on round 1. The architect must be invoked during the background repair and the gate
  // must recover.
  const t = await tmpOut();
  const recorder = { turns: [] };
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { perTurnTimeoutMs: 1000, maxRepairRounds: 2 } });
  const res = await orch.run({
    pdf: t.pdf, baseGenerator: t.gen, outDir: t.out,
    controller: scriptedController(recorder, {
      fail: { 'qa_auditor/background': 1 }, severity: 'major', domain: 'reconstruction',
      owner: 'template_architect', strictOwnership: true
    })()
  });
  assert.equal(res.success, true);
  assert.ok(res.gatesPassed.includes('background'));
  // The background repair must have run the Template Architect as a writer (it appears again
  // after the initial creation-stage architect turn), proving ownership routed across the gate.
  assert.ok(recorder.turns.filter((turn) => turn === 'template_architect').length >= 2,
    'template architect should be scheduled to repair its own issue during the background gate');
  assert.ok(recorder.turns.includes('repair_engineer'));
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

test('run(): a failed creation stage stops before its auditor', async () => {
  const t = await tmpOut();
  const recorder = { turns: [] };
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { perTurnTimeoutMs: 1000 } });
  const res = await orch.run({
    pdf: t.pdf, baseGenerator: t.gen, outDir: t.out,
    // Fails every attempt including its self-repair budget (1 initial + maxSelfRepairs), so the
    // fail-closed guarantee is tested THROUGH self-repair rather than in its absence: however many
    // attempts a writer gets, an auditor must never receive a failed artifact.
    controller: scriptedController(recorder, { fail: { 'generator_engineer/background': 3 }, domain: 'reconstruction' })()
  });
  assert.equal(res.success, false);
  assert.equal(res.statusCode, 60);
  assert.equal(res.failedStage, 'background');
  assert.equal(recorder.turns.filter((x) => x === 'generator_engineer/background').length, 3,
    'the writer got its self-repair attempts');
  assert.ok(!recorder.turns.includes('qa_auditor/background'));
  assert.equal(recorder.downloads || 0, 0, 'an early failure must not invoke the downloader');
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

// ChatGPT's own error card ("Something went wrong while processing your request.") is a provider
// transient. Wrap a scripted controller so the first `failCount` turns answer with that card.
function serverErrorController(recorder, failCount, opts = {}) {
  const base = scriptedController(recorder, opts)();
  recorder.messages = [];
  recorder.errorReplies = 0;
  let remaining = failCount;
  const errorReply = () => {
    remaining -= 1;
    recorder.errorReplies += 1;
    return {
      text: 'Something went wrong while processing your request.\n\nRetry',
      meta: { hasError: true, completionReason: 'terminal_error' }
    };
  };
  return {
    ...base,
    async query(args) {
      recorder.messages.push(args.prompt);
      if (remaining > 0) return errorReply();
      return base.query(args);
    },
    async followUp(args) {
      recorder.messages.push(args.text);
      if (remaining > 0) return errorReply();
      return base.followUp(args);
    }
  };
}

// Builds a controller where the template gate fails once, the architect repairs it while reporting
// `writerReportsFix ? [id] : []`, and every later template audit passes WITHOUT echoing any id.
// Both writer behaviours were observed live and neither may deadlock the gate.
function terseAuditController(recorder, { writerReportsFix }) {
  let templateAudits = 0;
  const reply = (message) => {
    const { role, mode } = roleFromMessage(message);
    const runId = String(message).match(/Active run id: ([A-Za-z0-9_-]+)/)?.[1] || 'RUN-0001';
    recorder.turns.push(mode ? `${role}/${mode}` : role);
    const handoff = {
      run_id: runId, role, mode, stage_status: 'passed',
      recommended_status_code: role === 'final_auditor' || (role === 'controller' && mode === 'finalize') ? 0 : null,
      artifacts: [{ path: `temporary/${role}.json`, sha256: 'a'.repeat(64) }],
      new_issues: [], verified_issues: [], required_reruns: [], next_role: null
    };
    if (role === 'qa_auditor' && mode === 'template') {
      templateAudits += 1;
      if (templateAudits === 1) {
        handoff.stage_status = 'failed';
        handoff.new_issues = [{
          issue_id: 'ISSUE-0001', severity: 'major', domain: 'geometry', code: 'BBOX',
          stage: 'template', artifact: 'a.png', field: null, table: null, cell: null,
          bbox: [0, 0, 1, 1], evidence: 'clipped glyphs', owner: 'template_architect',
          required_reruns: ['template'], status: 'open'
        }];
      }
    }
    if (role === 'template_architect' && templateAudits >= 1) {
      handoff.stage_status = 'ready_for_review';
      if (writerReportsFix) handoff.verified_issues = ['ISSUE-0001'];
    }
    if (role === 'qa_auditor' && mode === 'edge') handoff.edge_decisions = fullEdgeDecisions();
    return { text: `notes\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`` };
  };
  return {
    async query({ prompt }) { return reply(prompt); },
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
}

test('run(): a writer blocked by a deficient upstream artifact sends it back and resumes', async () => {
  // Observed live: the analyst left 24 static-text lines as placeholder descriptions, the architect
  // correctly refused to invent them and returned blocked with required_reruns naming the inventory.
  // The repair loop only covers audit failures, so the run used to end at status 80 with the fix
  // (re-transcribe) known but never attempted.
  const t = await tmpOut();
  const recorder = { turns: [] };
  let analystTurns = 0;
  let architectTurns = 0;
  const reply = (message) => {
    const { role, mode } = roleFromMessage(message);
    const runId = String(message).match(/Active run id: ([A-Za-z0-9_-]+)/)?.[1] || 'RUN-0001';
    recorder.turns.push(mode ? `${role}/${mode}` : role);
    const handoff = {
      run_id: runId, role, mode, stage_status: 'passed',
      recommended_status_code: role === 'final_auditor' || (role === 'controller' && mode === 'finalize') ? 0 : null,
      artifacts: [{ path: `temporary/${role}.json`, sha256: 'a'.repeat(64) }],
      new_issues: [], verified_issues: [], required_reruns: [], next_role: null
    };
    if (role === 'template_analyst') analystTurns += 1;
    if (role === 'template_architect') {
      architectTurns += 1;
      // Blocked the FIRST time only: the second analyst pass supplies the missing transcriptions.
      if (architectTurns === 1) {
        handoff.stage_status = 'blocked';
        handoff.recommended_status_code = 80;
        handoff.next_role = 'template_analyst';
        handoff.required_reruns = ['scan_inventory_static_text_transcription'];
        handoff.new_issues = [{
          issue_id: 'ISSUE-0001', severity: 'critical', domain: 'semantics',
          code: 'EXACT_STATIC_TEXT_NOT_ESTABLISHED', stage: 'template_specification',
          artifact: 'scan_inventory.json', field: null, table: 'coo_form', cell: null,
          bbox: [0, 0, 1, 1], evidence: '24 placeholder transcriptions', owner: 'template_architect',
          required_reruns: ['scan_inventory_static_text_transcription'], status: 'blocked'
        }];
      } else {
        handoff.stage_status = 'ready_for_review';
        handoff.verified_issues = ['ISSUE-0001'];
      }
    }
    if (role === 'qa_auditor' && mode === 'edge') handoff.edge_decisions = fullEdgeDecisions();
    return { text: `notes\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`` };
  };
  const controller = {
    async query({ prompt }) { return reply(prompt); },
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

  const orch = new WorkflowOrchestrator({
    roles: makeRoles(),
    config: { perTurnTimeoutMs: 1000, enforceEdgeDecisions: true, maxUpstreamRecoveries: 2 }
  });
  const res = await orch.run({ pdf: t.pdf, baseGenerator: t.gen, outDir: t.out, controller });
  assert.equal(analystTurns, 2, 'the analyst is re-run to resolve the blocker it caused');
  assert.equal(architectTurns, 2, 'the architect then re-runs and proceeds');
  // Order matters: analyst → architect → analyst → architect, never forward-jumping.
  const seq = recorder.turns.filter((x) => x === 'template_analyst' || x === 'template_architect');
  assert.deepEqual(seq, ['template_analyst', 'template_architect', 'template_analyst', 'template_architect']);
  assert.equal(res.statusCode, 0, 'the run completes after the upstream fix');
});

test('run(): a writer that judges its own output not approvable gets another attempt', async () => {
  // Observed live: the architect simulated its own reconstruction plan, measured 98,560 residual ink
  // pixels, and returned `failed` with an issue against its own work. The run ended with the defect
  // precisely known and never addressed.
  const t = await tmpOut();
  const recorder = { turns: [] };
  let architectTurns = 0;
  const reply = (message) => {
    const { role, mode } = roleFromMessage(message);
    const runId = String(message).match(/Active run id: ([A-Za-z0-9_-]+)/)?.[1] || 'RUN-0001';
    recorder.turns.push(mode ? `${role}/${mode}` : role);
    const handoff = {
      run_id: runId, role, mode, stage_status: 'passed',
      recommended_status_code: role === 'final_auditor' || (role === 'controller' && mode === 'finalize') ? 0 : null,
      artifacts: [{ path: `temporary/${role}.json`, sha256: 'a'.repeat(64) }],
      new_issues: [], verified_issues: [], required_reruns: [], next_role: null
    };
    if (role === 'template_architect') {
      architectTurns += 1;
      if (architectTurns === 1) {
        // Self-owned finding, and NO upstream role named — so only self-repair can rescue this.
        handoff.stage_status = 'failed';
        handoff.recommended_status_code = 60;
        handoff.next_role = 'controller';
        handoff.new_issues = [{
          issue_id: 'ISSUE-0001', severity: 'major', domain: 'reconstruction',
          code: 'RESIDUAL_SOURCE_VALUE_PIXELS', stage: 'template_specification',
          artifact: 'reconstruction_simulation.png', field: null, table: 'coo_form', cell: null,
          bbox: [0, 0, 1, 1], evidence: '98560 residual ink pixels', owner: 'template_architect',
          required_reruns: ['template_specification'], status: 'open'
        }];
      } else {
        handoff.stage_status = 'ready_for_review';
        handoff.verified_issues = ['ISSUE-0001'];
      }
    }
    if (role === 'qa_auditor' && mode === 'edge') handoff.edge_decisions = fullEdgeDecisions();
    return { text: `notes\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`` };
  };
  const controller = {
    async query({ prompt }) { return reply(prompt); },
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
  const orch = new WorkflowOrchestrator({
    roles: makeRoles(),
    config: { perTurnTimeoutMs: 1000, enforceEdgeDecisions: true, maxSelfRepairs: 2 }
  });
  const res = await orch.run({ pdf: t.pdf, baseGenerator: t.gen, outDir: t.out, controller });
  assert.equal(architectTurns, 2, 'the writer gets a second attempt with its own findings assigned');
  // The analyst must NOT be re-run: the finding was self-owned, not upstream.
  assert.equal(recorder.turns.filter((x) => x === 'template_analyst').length, 1);
  assert.equal(res.statusCode, 0, 'the run proceeds once the writer fixes its own work');
});

test('run(): the FIRST creation stage can still recover when it blocks', async () => {
  // Observed live: the analyst blocked with six blocker crops for unreadable lines — the honest
  // behaviour its prompt asks for — and the run ended at status 80 in five minutes. It is the first
  // write step, so it has no upstream role to return to, and the contract restricts issue `owner` to
  // the two spec/generator writers, so its findings can never name itself either. It was the only role
  // with no recovery path at all.
  const t = await tmpOut();
  const recorder = { turns: [] };
  let analystTurns = 0;
  const reply = (message) => {
    const { role, mode } = roleFromMessage(message);
    const runId = String(message).match(/Active run id: ([A-Za-z0-9_-]+)/)?.[1] || 'RUN-0001';
    recorder.turns.push(mode ? `${role}/${mode}` : role);
    const handoff = {
      run_id: runId, role, mode, stage_status: 'passed',
      recommended_status_code: role === 'final_auditor' || (role === 'controller' && mode === 'finalize') ? 0 : null,
      artifacts: [{ path: `temporary/${role}.json`, sha256: 'a'.repeat(64) }],
      new_issues: [], verified_issues: [], required_reruns: [], next_role: null
    };
    if (role === 'template_analyst') {
      analystTurns += 1;
      if (analystTurns === 1) {
        handoff.stage_status = 'blocked';
        handoff.recommended_status_code = 80;
        handoff.next_role = 'controller';
        // Note the owner: the contract only permits these two writers, never template_analyst.
        handoff.new_issues = [{
          issue_id: 'ISSUE-0001', severity: 'critical', domain: 'semantics',
          code: 'STATIC_TEXT_UNREADABLE', stage: 'scan_inventory',
          artifact: 'blockers/u001.png', field: null, table: 'coo_form', cell: null,
          bbox: [0, 0, 1, 1], evidence: 'six lines could not be transcribed',
          owner: 'template_architect', required_reruns: ['scan_inventory'], status: 'blocked'
        }];
      } else {
        handoff.stage_status = 'ready_for_review';
        handoff.verified_issues = ['ISSUE-0001'];
      }
    }
    if (role === 'qa_auditor' && mode === 'edge') handoff.edge_decisions = fullEdgeDecisions();
    return { text: `notes\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`` };
  };
  const controller = {
    async query({ prompt }) { return reply(prompt); },
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
  const orch = new WorkflowOrchestrator({
    roles: makeRoles(),
    config: { perTurnTimeoutMs: 1000, enforceEdgeDecisions: true, maxSelfRepairs: 2 }
  });
  const res = await orch.run({ pdf: t.pdf, baseGenerator: t.gen, outDir: t.out, controller });
  assert.equal(analystTurns, 2, 'the first creation stage gets a second attempt');
  assert.equal(res.statusCode, 0, 'the run proceeds after it resolves its own blockers');
});

test('run(): self-repair is bounded and then fails with the causal status', async () => {
  const t = await tmpOut();
  const recorder = { turns: [] };
  let architectTurns = 0;
  const reply = (message) => {
    const { role, mode } = roleFromMessage(message);
    const runId = String(message).match(/Active run id: ([A-Za-z0-9_-]+)/)?.[1] || 'RUN-0001';
    recorder.turns.push(mode ? `${role}/${mode}` : role);
    const handoff = {
      run_id: runId, role, mode, stage_status: 'passed', recommended_status_code: null,
      artifacts: [{ path: `temporary/${role}.json`, sha256: 'a'.repeat(64) }],
      new_issues: [], verified_issues: [], required_reruns: [], next_role: null
    };
    if (role === 'template_architect') {
      architectTurns += 1;
      handoff.stage_status = 'failed';
      handoff.recommended_status_code = 60;
      handoff.next_role = 'controller';
      handoff.new_issues = [{
        issue_id: `ISSUE-000${architectTurns}`, severity: 'major', domain: 'reconstruction',
        code: 'RESIDUAL_SOURCE_VALUE_PIXELS', stage: 'template_specification',
        artifact: 'sim.png', field: null, table: 'coo_form', cell: null, bbox: [0, 0, 1, 1],
        evidence: 'still residual', owner: 'template_architect',
        required_reruns: ['template_specification'], status: 'open'
      }];
    }
    return { text: `notes\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`` };
  };
  const controller = {
    async query({ prompt }) { return reply(prompt); },
    async followUp({ text }) { return reply(text); },
    async downloadLastAssistantEntities() { return []; },
    async downloadLastAssistantFiles() { return []; }
  };
  const orch = new WorkflowOrchestrator({
    roles: makeRoles(), config: { perTurnTimeoutMs: 1000, maxSelfRepairs: 2 }
  });
  const res = await orch.run({ pdf: t.pdf, baseGenerator: t.gen, outDir: t.out, controller });
  assert.equal(architectTurns, 3, 'first attempt plus exactly maxSelfRepairs retries');
  assert.equal(res.success, false);
  assert.equal(res.statusCode, 60);
});

test('run(): upstream recovery is bounded and then fails with the blocked status', async () => {
  const t = await tmpOut();
  const recorder = { turns: [] };
  let analystTurns = 0;
  const reply = (message) => {
    const { role, mode } = roleFromMessage(message);
    const runId = String(message).match(/Active run id: ([A-Za-z0-9_-]+)/)?.[1] || 'RUN-0001';
    recorder.turns.push(mode ? `${role}/${mode}` : role);
    const handoff = {
      run_id: runId, role, mode, stage_status: 'passed', recommended_status_code: null,
      artifacts: [{ path: `temporary/${role}.json`, sha256: 'a'.repeat(64) }],
      new_issues: [], verified_issues: [], required_reruns: [], next_role: null
    };
    if (role === 'template_analyst') analystTurns += 1;
    if (role === 'template_architect') {
      // Never satisfied: the analyst keeps handing back the same deficiency.
      handoff.stage_status = 'blocked';
      handoff.recommended_status_code = 80;
      handoff.next_role = 'template_analyst';
      handoff.required_reruns = ['scan_inventory_static_text_transcription'];
    }
    return { text: `notes\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`` };
  };
  const controller = {
    async query({ prompt }) { return reply(prompt); },
    async followUp({ text }) { return reply(text); },
    async downloadLastAssistantEntities() { return []; },
    async downloadLastAssistantFiles() { return []; }
  };
  const orch = new WorkflowOrchestrator({
    roles: makeRoles(),
    config: { perTurnTimeoutMs: 1000, maxUpstreamRecoveries: 2 }
  });
  const res = await orch.run({ pdf: t.pdf, baseGenerator: t.gen, outDir: t.out, controller });
  assert.equal(analystTurns, 3, 'the first pass plus exactly maxUpstreamRecoveries retries');
  assert.equal(res.statusCode, 80, 'an unresolvable blocker still ends the run as blocked/partial');
  assert.equal(res.success, false);
});

test('run(): a repaired issue the writer never marked fixed still recovers the gate', async () => {
  // Observed live: the architect applied the whole repair plan and returned `verified_issues: []`,
  // so the issue stayed `open` rather than `fixed`. If the re-audit then passes without echoing the
  // id, the gate must still recover — otherwise every round re-plans the same issue until the budget
  // runs out, at roughly an hour per round.
  const t = await tmpOut();
  const recorder = { turns: [] };
  const orch = new WorkflowOrchestrator({
    roles: makeRoles(),
    config: { perTurnTimeoutMs: 1000, maxRepairRounds: 4, enforceEdgeDecisions: true }
  });
  const res = await orch.run({
    pdf: t.pdf, baseGenerator: t.gen, outDir: t.out,
    controller: terseAuditController(recorder, { writerReportsFix: false })
  });
  assert.ok(res.gatesPassed.includes('template'), 'the template gate must recover');
  assert.equal(res.issues.find((i) => i.issue_id === 'ISSUE-0001').status, 'verified');
  const audits = recorder.turns.filter((x) => x === 'qa_auditor/template').length;
  assert.ok(audits <= 3, `the loop must not burn every round (template audits: ${audits})`);
  assert.equal(res.statusCode, 0);
});

test('run(): an issue fixed via upstream recovery does not block a gate whose audit passed', async () => {
  // Observed live, and the closest a run came to passing: the architect blocked on the analyst's
  // inventory, upstream recovery fixed it, the template audit later PASSED — and the gate still failed
  // because that upstream issue sat at "fixed" and was never recorded as verified. It had never been in
  // any repair round's assigned list, so tracking only per-round issues could not reach it.
  const t = await tmpOut();
  const recorder = { turns: [] };
  let architectTurns = 0;
  let templateAudits = 0;
  const reply = (message) => {
    const { role, mode } = roleFromMessage(message);
    const runId = String(message).match(/Active run id: ([A-Za-z0-9_-]+)/)?.[1] || 'RUN-0001';
    recorder.turns.push(mode ? `${role}/${mode}` : role);
    const handoff = {
      run_id: runId, role, mode, stage_status: 'passed',
      recommended_status_code: role === 'final_auditor' || (role === 'controller' && mode === 'finalize') ? 0 : null,
      artifacts: [{ path: `temporary/${role}.json`, sha256: 'a'.repeat(64) }],
      new_issues: [], verified_issues: [], required_reruns: [], next_role: null
    };
    if (role === 'template_architect') {
      architectTurns += 1;
      if (architectTurns === 1) {
        // Blocks on upstream work, raising a CRITICAL issue that upstream recovery will resolve.
        handoff.stage_status = 'blocked';
        handoff.recommended_status_code = 80;
        handoff.next_role = 'template_analyst';
        handoff.required_reruns = ['scan_inventory_static_text_transcription'];
        handoff.new_issues = [{
          issue_id: 'ISSUE-0001', severity: 'critical', domain: 'geometry',
          code: 'SCAN_INVENTORY_CONTAINER_GEOMETRY_INCONSISTENT', stage: 'template_specification',
          artifact: 'scan_inventory.json', field: null, table: 'coo_form', cell: 'box_8',
          bbox: [0, 0, 1, 1], evidence: 'container geometry inconsistent', owner: 'template_architect',
          required_reruns: ['scan_inventory'], status: 'open'
        }];
      } else {
        handoff.stage_status = 'ready_for_review';
        // The writer reports it fixed — status becomes `fixed`, never `verified`.
        handoff.verified_issues = ['ISSUE-0001'];
      }
    }
    if (role === 'qa_auditor' && mode === 'template') {
      templateAudits += 1;
      // Fails once so a repair loop starts, then passes — echoing nothing.
      if (templateAudits === 1) {
        handoff.stage_status = 'failed';
        handoff.new_issues = [{
          issue_id: 'ISSUE-0002', severity: 'major', domain: 'geometry', code: 'BBOX',
          stage: 'template', artifact: 'a.png', field: null, table: 'coo_form', cell: null,
          bbox: [0, 0, 1, 1], evidence: 'bbox not tight', owner: 'template_architect',
          required_reruns: ['template'], status: 'open'
        }];
      }
    }
    if (role === 'qa_auditor' && mode === 'edge') handoff.edge_decisions = fullEdgeDecisions();
    return { text: `notes\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`` };
  };
  const controller = {
    async query({ prompt }) { return reply(prompt); },
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
  const orch = new WorkflowOrchestrator({
    roles: makeRoles(),
    config: { perTurnTimeoutMs: 1000, enforceEdgeDecisions: true, maxRepairRounds: 4, maxUpstreamRecoveries: 2 }
  });
  const res = await orch.run({ pdf: t.pdf, baseGenerator: t.gen, outDir: t.out, controller });
  assert.ok(res.gatesPassed.includes('template'), 'a passing audit must close the gate');
  assert.equal(res.issues.find((i) => i.issue_id === 'ISSUE-0001').status, 'verified',
    'the upstream-recovered issue is recorded as verified by the passing audit');
  assert.equal(res.statusCode, 0);
});

test('run(): a passing re-audit that does not echo issue IDs still recovers the gate', async () => {
  // The deadlock this prevents: the writer marks issues `fixed`, the independent auditor re-validates
  // and returns `passed` but lists nothing in `verified_issues`. Those issues stay "fixed" — which
  // blocks release — while no longer being "open", so the next repair round has nothing to plan and
  // every remaining round is spent achieving nothing before the gate fails.
  const t = await tmpOut();
  const recorder = { turns: [] };
  let templateAudits = 0;
  const controller = {
    async query({ prompt }) { return reply(prompt); },
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
  function reply(message) {
    const { role, mode } = roleFromMessage(message);
    const runId = String(message).match(/Active run id: ([A-Za-z0-9_-]+)/)?.[1] || 'RUN-0001';
    recorder.turns.push(mode ? `${role}/${mode}` : role);
    const handoff = {
      run_id: runId, role, mode, stage_status: 'passed',
      recommended_status_code: role === 'final_auditor' || (role === 'controller' && mode === 'finalize') ? 0 : null,
      artifacts: [{ path: `temporary/${role}.json`, sha256: 'a'.repeat(64) }],
      new_issues: [], verified_issues: [], required_reruns: [], next_role: null
    };
    if (role === 'qa_auditor' && mode === 'template') {
      templateAudits += 1;
      if (templateAudits === 1) {
        handoff.stage_status = 'failed';
        handoff.new_issues = [{
          issue_id: 'ISSUE-0001', severity: 'major', domain: 'geometry', code: 'BBOX',
          stage: 'template', artifact: 'a.png', field: null, table: null, cell: null,
          bbox: [0, 0, 1, 1], evidence: 'clipped glyphs', owner: 'template_architect',
          required_reruns: ['template'], status: 'open'
        }];
      }
      // Every later template audit passes but deliberately echoes NO ids.
    }
    if (role === 'template_architect' && templateAudits >= 1) {
      // The writer reports the fix (contract: writers mark fixed, never verified).
      handoff.stage_status = 'ready_for_review';
      handoff.verified_issues = ['ISSUE-0001'];
    }
    if (role === 'qa_auditor' && mode === 'edge') handoff.edge_decisions = fullEdgeDecisions();
    return { text: `notes\n\`\`\`json\n${JSON.stringify(handoff)}\n\`\`\`` };
  }

  const orch = new WorkflowOrchestrator({
    roles: makeRoles(),
    config: { perTurnTimeoutMs: 1000, maxRepairRounds: 4, enforceEdgeDecisions: true }
  });
  const res = await orch.run({ pdf: t.pdf, baseGenerator: t.gen, outDir: t.out, controller });
  assert.ok(res.gatesPassed.includes('template'), 'the template gate must recover');
  const repairAudits = recorder.turns.filter((x) => x === 'qa_auditor/template').length;
  assert.ok(repairAudits <= 3, `the loop must not burn every round (template audits: ${repairAudits})`);
  const issue = res.issues.find((i) => i.issue_id === 'ISSUE-0001');
  assert.equal(issue.status, 'verified', "the auditor's pass is recorded as the verification");
  assert.equal(res.statusCode, 0, 'the run completes once the gate recovers');
});

test('run(): a partial (blocked) repair plan still reaches the owning writer', async () => {
  // Observed live: the Repair Engineer returned `blocked` because 1 of 8 issues was not locally
  // repairable, while carrying five complete change groups for the other seven. The gate was
  // abandoned on round 1 with no repair attempted at all.
  const t = await tmpOut();
  const recorder = { turns: [] };
  const base = scriptedController(recorder, { fail: { 'qa_auditor/template': 1 } })();
  const controller = {
    ...base,
    async followUp(args) {
      const { role } = roleFromMessage(args.text);
      if (role === 'repair_engineer') {
        const runId = String(args.text).match(/Active run id: ([A-Za-z0-9_-]+)/)?.[1] || 'RUN-0001';
        const handoff = {
          run_id: runId, role: 'repair_engineer', mode: null,
          stage_status: 'blocked', recommended_status_code: 80,
          artifacts: [{ path: 'temporary/plan.json', sha256: 'a'.repeat(64) }],
          new_issues: [], verified_issues: [], required_reruns: ['template'], next_role: 'template_architect'
        };
        return { text: '```json\n' + JSON.stringify(handoff) + '\n```' };
      }
      return base.followUp(args);
    }
  };
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { perTurnTimeoutMs: 1000, maxRepairRounds: 1 } });
  await orch.run({ pdf: t.pdf, baseGenerator: t.gen, outDir: t.out, controller });
  // The architect authors the spec once in the normal plan; a second turn means the repair was
  // actually applied rather than discarded with the plan.
  const architectTurns = recorder.turns.filter((x) => x === 'template_architect').length;
  assert.equal(architectTurns, 2, 'the architect must apply the repairable part of a partial plan');
});

test('run(): a repair plan that failed outright ends the gate without calling a writer', async () => {
  const t = await tmpOut();
  const recorder = { turns: [] };
  const base = scriptedController(recorder, { fail: { 'qa_auditor/template': 1 } })();
  const controller = {
    ...base,
    async followUp(args) {
      const { role } = roleFromMessage(args.text);
      if (role === 'repair_engineer') {
        const runId = String(args.text).match(/Active run id: ([A-Za-z0-9_-]+)/)?.[1] || 'RUN-0001';
        return { text: '```json\n' + JSON.stringify({
          run_id: runId, role: 'repair_engineer', mode: null,
          stage_status: 'failed', recommended_status_code: 50,
          artifacts: [{ path: 'temporary/plan.json', sha256: 'a'.repeat(64) }],
          new_issues: [], verified_issues: [], required_reruns: [], next_role: 'controller'
        }) + '\n```' };
      }
      return base.followUp(args);
    }
  };
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { perTurnTimeoutMs: 1000, maxRepairRounds: 1 } });
  const res = await orch.run({ pdf: t.pdf, baseGenerator: t.gen, outDir: t.out, controller });
  assert.equal(res.success, false);
  const architectTurns = recorder.turns.filter((x) => x === 'template_architect').length;
  assert.equal(architectTurns, 1, 'a planner that could not plan at all ends the gate, no repair write');
});

test('run(): a ChatGPT server error re-sends the same turn instead of asking for JSON again', async () => {
  const t = await tmpOut();
  const recorder = { turns: [] };
  const orch = new WorkflowOrchestrator({
    roles: makeRoles(),
    config: { perTurnTimeoutMs: 1000, serverErrorRetries: 2, serverErrorBackoffMs: [0, 0] }
  });
  const res = await orch.run({
    pdf: t.pdf, baseGenerator: t.gen, outDir: t.out,
    controller: serverErrorController(recorder, 1)
  });
  assert.equal(res.statusCode, 0, 'the run recovers from a transient provider error');
  assert.equal(recorder.errorReplies, 1);
  // The opening turn was re-sent verbatim; the useless "reply again with valid JSON" nag, which
  // used to consume the run's only retry against an error card, is never sent.
  assert.equal(recorder.messages[0], recorder.messages[1], 'the identical turn is re-sent');
  assert.ok(
    !recorder.messages.some((m) => /did not end with a valid shared-handoff/.test(String(m))),
    'no reformat re-ask is sent for a server error'
  );
  assert.equal(recorder.turns[0], 'controller/start');
});

test('run(): a persistent ChatGPT server error raises a retryable error carrying the completed turns', async () => {
  const t = await tmpOut();
  const recorder = { turns: [] };
  const orch = new WorkflowOrchestrator({
    roles: makeRoles(),
    config: { perTurnTimeoutMs: 1000, serverErrorRetries: 1, serverErrorBackoffMs: [0] }
  });
  // Fail every turn from the third onward: the first two turns succeed, so there is real work to
  // preserve when the outage hits.
  let calls = 0;
  const base = scriptedController(recorder)();
  const controller = {
    ...base,
    async query(args) { calls += 1; return base.query(args); },
    async followUp(args) {
      calls += 1;
      if (calls >= 3) {
        return { text: 'Something went wrong while processing your request.', meta: { hasError: true } };
      }
      return base.followUp(args);
    }
  };
  await assert.rejects(
    () => orch.run({ pdf: t.pdf, baseGenerator: t.gen, outDir: t.out, controller }),
    (err) => {
      assert.equal(err.message, 'chatgpt_server_error');
      assert.equal(err.retryable, true, 'the caller must retry this file rather than record a status');
      assert.ok(Array.isArray(err.transcript) && err.transcript.length >= 2,
        'the completed turns ride along for the post-mortem');
      assert.ok(Array.isArray(err.issues));
      return true;
    }
  );
});

test('run(): a controller throw carries the transcript of the turns that did complete', async () => {
  const t = await tmpOut();
  const recorder = { turns: [] };
  const base = scriptedController(recorder)();
  let calls = 0;
  const controller = {
    ...base,
    async query(args) { calls += 1; return base.query(args); },
    async followUp(args) {
      calls += 1;
      if (calls >= 3) {
        const err = new Error('response_stalled_no_output');
        err.retryable = true;
        throw err;
      }
      return base.followUp(args);
    }
  };
  await assert.rejects(
    () => orch_run_helper(t, controller),
    (err) => {
      assert.equal(err.message, 'response_stalled_no_output');
      assert.ok(err.transcript.length >= 2, 'completed turns survive a mid-run controller throw');
      return true;
    }
  );
});

function orch_run_helper(t, controller) {
  const orch = new WorkflowOrchestrator({ roles: makeRoles(), config: { perTurnTimeoutMs: 1000 } });
  return orch.run({ pdf: t.pdf, baseGenerator: t.gen, outDir: t.out, controller });
}

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
  assert.deepEqual(
    PLAN.map(({ role, mode }) => `${role}/${mode || '-'}`),
    [
      'controller/start',
      'template_analyst/-',
      'template_architect/-',
      'qa_auditor/template',
      'generator_engineer/background',
      'qa_auditor/background',
      'generator_engineer/implementation',
      'qa_auditor/baseline',
      'qa_auditor/fidelity',
      'qa_auditor/edge',
      'qa_auditor/regression',
      'generator_engineer/package',
      'contract_auditor/release',
      'final_auditor/-',
      'controller/finalize'
    ]
  );
});
