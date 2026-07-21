// Agentic workflow orchestrator.
//
// This module is the *mechanical* Controller of the role-separated workflow described
// in workflow/WORKFLOW.md. For one target PDF it drives a single ChatGPT chat through a
// fixed sequence of roles (as conversation turns), enforces the stage gates, tracks an
// append-only issue log, computes dependency-based reruns during repair, and selects the
// final numeric status code. The model does the per-role work (analysing the scan,
// editing generator.py's EDIT ZONE, running its CLI, reviewing rendered artifacts,
// building the visual-review envelope) inside its sandbox; this code never edits or
// approves document artifacts itself.
//
// It talks to any controller exposing:
//   query({ prompt, attachments, timeoutMs, newChat }) -> { text, codeBlocks? }
//   followUp({ text, timeoutMs })                       -> { text }
//   downloadLastAssistantEntities({ outDir })           -> [{ path, name }]
//   downloadLastAssistantFiles({ maxFiles, outDir })    -> [{ path, name }]
// which makes it unit-testable with a scripted fake controller.

import fs from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Static workflow definition
// ---------------------------------------------------------------------------

// Ordered gates (see workflow/WORKFLOW.md "Stage gates").
export const GATES = [
  'preflight', 'template', 'background', 'baseline', 'edge', 'regression', 'release', 'final'
];

// QA modes that a repair round can re-run.
export const QA_MODES = ['template', 'background', 'baseline', 'edge', 'regression'];

// Role -> prompt file (under <workflowDir>/roles).
export const ROLE_FILES = {
  shared: '00_SHARED_CONTRACT.txt',
  controller: '01_CONTROLLER.txt',
  contract_auditor: '02_CONTRACT_AUDITOR.txt',
  template_analyst: '03_TEMPLATE_ANALYST.txt',
  template_architect: '04_TEMPLATE_ARCHITECT.txt',
  generator_engineer: '05_GENERATOR_ENGINEER.txt',
  qa_auditor: '06_QA_AUDITOR.txt',
  repair_engineer: '07_REPAIR_ENGINEER.txt',
  final_auditor: '08_FINAL_AUDITOR.txt'
};

// The fixed step plan. `kind` is 'write' (creation) or 'audit' (approval); a role that
// writes an artifact is always followed by an independent auditor. `gate` marks the gate
// an audit step opens.
export const PLAN = [
  { role: 'contract_auditor', mode: 'preflight', gate: 'preflight', kind: 'audit' },
  { role: 'template_analyst', mode: null, gate: null, kind: 'write' },
  { role: 'template_architect', mode: null, gate: null, kind: 'write' },
  { role: 'generator_engineer', mode: 'implementation', gate: null, kind: 'write' },
  { role: 'qa_auditor', mode: 'template', gate: 'template', kind: 'audit' },
  { role: 'qa_auditor', mode: 'background', gate: 'background', kind: 'audit' },
  { role: 'qa_auditor', mode: 'baseline', gate: 'baseline', kind: 'audit' },
  { role: 'qa_auditor', mode: 'edge', gate: 'edge', kind: 'audit' },
  { role: 'qa_auditor', mode: 'regression', gate: 'regression', kind: 'audit' },
  { role: 'generator_engineer', mode: 'package', gate: null, kind: 'write' },
  { role: 'contract_auditor', mode: 'release', gate: 'release', kind: 'audit' },
  { role: 'final_auditor', mode: null, gate: 'final', kind: 'audit' }
];

// Repair dependency map: issue domain -> QA modes that must rerun (07_REPAIR_ENGINEER).
export const RERUN_MAP = {
  runtime: ['template', 'background', 'baseline', 'edge', 'regression'],
  geometry: ['template', 'background', 'baseline', 'edge'],
  reconstruction: ['background', 'baseline', 'edge'],
  typography: ['baseline', 'edge'],
  placement: ['baseline', 'edge'],
  annotation: ['baseline', 'edge'],
  semantics: ['baseline'],
  compatibility: ['baseline'],
  packaging: ['regression']
};

// Causal status codes (match generator.py STATUS_CODES).
const DOMAIN_CODE = {
  runtime: 20, compatibility: 20, semantics: 30, geometry: 50, annotation: 50,
  reconstruction: 60, typography: 60, placement: 60, packaging: 70
};
const STAGE_CODE = {
  preflight: 30, template: 50, background: 60, baseline: 60, edge: 60,
  regression: 99, release: 70, final: 99
};
const SEVERITY_RANK = { critical: 3, major: 2, minor: 1, info: 0 };

export const PERSISTENT_FILES = ['generator.py', 'manifest.json', 'generator_report.json'];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Extract the handoff object from a reply. A reply may contain several JSON blocks (e.g.
// the visual-review envelope AND the handoff), so pick the LAST fenced ```json block that
// parses and carries a stage_status; fall back to a bare {...} with stage_status.
function _normaliseHandoff(obj) {
  if (!obj || typeof obj !== 'object' || typeof obj.stage_status !== 'string') return null;
  for (const key of ['evidence', 'new_issues', 'verified_issues', 'required_reruns']) {
    if (!Array.isArray(obj[key])) obj[key] = [];
  }
  return obj;
}

export function parseHandoff(text) {
  const src = String(text || '');
  const candidates = [];
  const fence = /```json\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fence.exec(src)) !== null) candidates.push(m[1]);
  if (candidates.length === 0) {
    const braceRe = /\{[\s\S]*?"stage_status"[\s\S]*?\}/gi;
    let bm;
    while ((bm = braceRe.exec(src)) !== null) candidates.push(bm[0]);
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    let obj;
    try {
      obj = JSON.parse(candidates[i].trim());
    } catch {
      continue;
    }
    const norm = _normaliseHandoff(obj);
    if (norm) return norm;
  }
  return null;
}

// Union of explicitly requested reruns and reruns derived from open-issue domains.
export function mergeReruns(requiredReruns = [], issues = []) {
  const out = new Set();
  for (const r of requiredReruns) {
    const name = String(r || '').toLowerCase();
    if (QA_MODES.includes(name)) out.add(name);
  }
  for (const issue of issues) {
    const domain = String(issue?.domain || '').toLowerCase();
    for (const mode of RERUN_MAP[domain] || []) out.add(mode);
  }
  // Preserve QA_MODES order.
  return QA_MODES.filter((m) => out.has(m));
}

// Pick the causal failure code: most-severe open/blocked issue's domain code, else the
// failing stage's default, else 99.
export function selectFailureCode(issues = [], failedStage = null, fallback = 99) {
  const open = issues.filter((i) => i && (i.status === 'open' || i.status === 'blocked' || i.status === 'fixed'));
  let best = null;
  for (const issue of open) {
    const rank = SEVERITY_RANK[issue.severity] ?? 0;
    if (!best || rank > best.rank) best = { rank, issue };
  }
  if (best) {
    const code = DOMAIN_CODE[String(best.issue.domain || '').toLowerCase()];
    if (Number.isFinite(code)) return code;
  }
  if (failedStage && Number.isFinite(STAGE_CODE[failedStage])) return STAGE_CODE[failedStage];
  return fallback;
}

// ---------------------------------------------------------------------------
// Append-only issue log
// ---------------------------------------------------------------------------

export class IssueLog {
  constructor() {
    this.issues = [];
    this._byId = new Map();
  }

  _ingest(record, { defaultStatus } = {}) {
    if (!record || typeof record !== 'object') return;
    const id = String(record.issue_id || `ISSUE-${this.issues.length + 1}`);
    const existing = this._byId.get(id);
    if (existing) {
      Object.assign(existing, record, { issue_id: id });
      return;
    }
    const rec = { status: defaultStatus || 'open', ...record, issue_id: id };
    this.issues.push(rec);
    this._byId.set(id, rec);
  }

  addNew(records = []) {
    for (const r of records) this._ingest(r, { defaultStatus: 'open' });
  }

  markFixed(records = []) {
    for (const r of records) {
      const id = String(r?.issue_id || r || '');
      const rec = this._byId.get(id);
      if (rec) rec.status = 'fixed';
      else this._ingest({ ...(typeof r === 'object' ? r : { issue_id: id }), status: 'fixed' });
    }
  }

  // Only an independent auditor may verify.
  markVerified(records = []) {
    for (const r of records) {
      const id = String(r?.issue_id || r || '');
      const rec = this._byId.get(id);
      if (rec) rec.status = 'verified';
    }
  }

  open() {
    return this.issues.filter((i) => i.status === 'open' || i.status === 'blocked');
  }

  // A gate cannot pass while a critical/major issue is unresolved (open/blocked/fixed-but-unverified).
  blockingForRelease() {
    return this.issues.filter(
      (i) => (i.severity === 'critical' || i.severity === 'major') && i.status !== 'verified'
    );
  }

  snapshot() {
    return this.issues.map((i) => ({ ...i }));
  }
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG = {
  maxRepairRounds: 4,
  perTurnTimeoutMs: 900000,
  successCode: 0,
  reAskOnBadHandoff: true
};

export class WorkflowOrchestrator {
  // roles: { shared, contract_auditor, ... } mapping role -> prompt text (from loadRoles).
  constructor({ roles, config = {}, log = () => {} } = {}) {
    if (!roles || !roles.shared) throw new Error('orchestrator: roles (with shared contract) are required');
    this.roles = roles;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.log = log;
  }

  // Compose the message text for one role turn.
  _composeMessage(step, ctx, { includeShared }) {
    const parts = [];
    if (includeShared) {
      parts.push('===== SHARED ADAPTATION CONTRACT =====');
      parts.push(this.roles.shared.trim());
      parts.push(
        `\nInputs attached to this chat: the target scanned PDF (${ctx.pdfName}) and the base generator.py. ` +
        `Save the generator as generator.py in your working directory and drive it with its CLI. ` +
        `Run id: ${ctx.runId}.`
      );
    } else {
      parts.push('(The shared adaptation contract from the first message still applies.)');
    }
    parts.push(`\n===== ROLE: ${step.role.toUpperCase()}${step.mode ? ` (mode: ${step.mode})` : ''} =====`);
    parts.push((this.roles[step.role] || '').trim());
    if (step.mode) parts.push(`\nAct in mode: ${step.mode}.`);

    const notes = [];
    if (ctx.gate) notes.push(`This turn targets the "${ctx.gate}" gate.`);
    if (ctx.assignedIssues && ctx.assignedIssues.length) {
      notes.push('Assigned open issues to address:');
      notes.push('```json');
      notes.push(JSON.stringify(ctx.assignedIssues, null, 2));
      notes.push('```');
    }
    if (ctx.rerunNote) notes.push(ctx.rerunNote);
    if (ctx.extra) notes.push(ctx.extra);
    notes.push(
      'End your reply with exactly one fenced ```json block containing the shared handoff object.'
    );
    parts.push('\n' + notes.join('\n'));
    return parts.join('\n');
  }

  // Best-effort capture of the three persistent files from the current last assistant
  // message. Called right after the package turn (when they are freshly produced) and
  // again at the end as a fallback.
  async _downloadPersistent(controller, outDir) {
    if (!controller.downloadLastAssistantEntities) return [];
    await fs.mkdir(outDir, { recursive: true }).catch(() => {});
    const entities = await controller.downloadLastAssistantEntities({ outDir }).catch(() => []);
    const links = controller.downloadLastAssistantFiles
      ? await controller.downloadLastAssistantFiles({ maxFiles: 20, outDir }).catch(() => [])
      : [];
    return [...entities, ...links]
      .filter((f) => f && PERSISTENT_FILES.includes(f.name))
      .map((f) => ({ path: f.path, name: f.name }));
  }

  async _send(controller, message, { first, attachments, timeoutMs, newChat }) {
    if (first) {
      return controller.query({ prompt: message, attachments, timeoutMs, newChat });
    }
    return controller.followUp({ text: message, timeoutMs });
  }

  // Run one role turn: send, capture text, parse the handoff (re-asking once if needed).
  async _turn(controller, step, ctx, sendOpts, transcript) {
    const message = this._composeMessage(step, ctx, { includeShared: sendOpts.first });
    let result = await this._send(controller, message, sendOpts);
    let text = String(result?.text || '');
    transcript.push({ role: step.role, mode: step.mode, text });
    let handoff = parseHandoff(text);
    if (!handoff && this.config.reAskOnBadHandoff) {
      this.log(`  · ${step.role}${step.mode ? '/' + step.mode : ''}: no valid handoff — re-asking once`);
      const reask = await controller.followUp({
        text: 'Your previous reply did not end with a valid shared-handoff JSON block. ' +
          'Reply again with ONLY the required fenced ```json handoff object for the same role and mode.',
        timeoutMs: sendOpts.timeoutMs
      });
      text = String(reask?.text || '');
      transcript.push({ role: step.role, mode: step.mode, text, reask: true });
      handoff = parseHandoff(text);
    }
    return { handoff, result, text };
  }

  // Attempt to recover a failed gate via repair rounds with targeted reruns.
  async _repairGate(controller, step, state, transcript) {
    const gate = step.gate;
    for (let round = 1; round <= this.config.maxRepairRounds; round++) {
      const assigned = state.issues.open();
      this.log(`  ↻ repair round ${round}/${this.config.maxRepairRounds} for "${gate}" gate (${assigned.length} open issue(s))`);

      // 1) Repair Engineer addresses the open issues.
      const repairTurn = await this._turn(
        controller,
        { role: 'repair_engineer', mode: null, gate },
        { ...state.ctx, gate, assignedIssues: assigned,
          extra: 'Fix the smallest root-cause domain, re-run self-test and audit phase 1, mark issues fixed, and list required_reruns.' },
        { first: false, timeoutMs: this.config.perTurnTimeoutMs },
        transcript
      );
      if (!repairTurn.handoff) return { recovered: false, code: 99, stage: gate };
      state.issues.addNew(repairTurn.handoff.new_issues);
      // A Repair Engineer may mark an issue fixed, never verified — so the ids it reports
      // addressed (in verified_issues) are downgraded to "fixed" here.
      state.issues.markFixed(repairTurn.handoff.verified_issues);

      const rerunModes = mergeReruns(repairTurn.handoff.required_reruns, state.issues.open());
      // Always re-run at least the failing gate's own mode if it is a QA mode.
      const modes = rerunModes.length ? rerunModes : (QA_MODES.includes(gate) ? [gate] : []);
      this.log(`    reruns: ${modes.join(', ') || '(none)'}`);

      // 2) Re-run the affected QA modes (independent auditor).
      let gatePassed = false;
      for (const mode of modes) {
        const qaStep = { role: 'qa_auditor', mode, gate: mode };
        const qaTurn = await this._turn(
          controller,
          qaStep,
          { ...state.ctx, gate: mode, extra: 'Independently re-validate after repair. Verify fixed issues or reopen them.' },
          { first: false, timeoutMs: this.config.perTurnTimeoutMs },
          transcript
        );
        if (!qaTurn.handoff) return { recovered: false, code: 99, stage: mode };
        state.issues.addNew(qaTurn.handoff.new_issues);
        state.issues.markVerified(qaTurn.handoff.verified_issues);
        if (mode === gate) gatePassed = qaTurn.handoff.stage_status === 'passed';
      }
      // If the gate itself was not among reruns, re-check it explicitly.
      if (!modes.includes(gate) && QA_MODES.includes(gate)) {
        const qaTurn = await this._turn(
          controller,
          { role: 'qa_auditor', mode: gate, gate },
          { ...state.ctx, gate, extra: 'Re-validate this gate after repair.' },
          { first: false, timeoutMs: this.config.perTurnTimeoutMs },
          transcript
        );
        if (!qaTurn.handoff) return { recovered: false, code: 99, stage: gate };
        state.issues.addNew(qaTurn.handoff.new_issues);
        state.issues.markVerified(qaTurn.handoff.verified_issues);
        gatePassed = qaTurn.handoff.stage_status === 'passed';
      }

      if (gatePassed && state.issues.blockingForRelease().length === 0) {
        this.log(`  ✓ "${gate}" gate recovered after repair round ${round}`);
        return { recovered: true };
      }
    }
    const code = selectFailureCode(state.issues.snapshot(), gate);
    return { recovered: false, code, stage: gate };
  }

  // Drive the whole workflow for one PDF.
  async run({ pdf, baseGenerator, outDir, controller, timeoutMs, newChat = true, runId = 'RUN-0001' }) {
    const perTurnTimeoutMs = timeoutMs || this.config.perTurnTimeoutMs;
    const transcript = [];
    const state = {
      issues: new IssueLog(),
      ctx: { runId, pdfName: path.basename(pdf) }
    };
    const attachments = [pdf, baseGenerator];
    const gatesPassed = [];
    let statusCode = null;
    let failedStage = null;
    let packagedFiles = [];

    for (let i = 0; i < PLAN.length; i++) {
      const step = PLAN[i];
      const first = i === 0;
      this.log(`▶ ${step.role}${step.mode ? '/' + step.mode : ''}${step.gate ? ` [gate: ${step.gate}]` : ''}`);
      const turn = await this._turn(
        controller,
        step,
        { ...state.ctx, gate: step.gate },
        { first, attachments, timeoutMs: perTurnTimeoutMs, newChat },
        transcript
      );

      if (!turn.handoff) {
        failedStage = step.gate || step.mode || step.role;
        statusCode = 99;
        this.log(`  ✗ ${step.role}: unparseable handoff → status 99`);
        break;
      }

      // Apply issue-log transitions.
      state.issues.addNew(turn.handoff.new_issues);
      if (step.kind === 'audit') state.issues.markVerified(turn.handoff.verified_issues);
      else state.issues.markFixed(turn.handoff.verified_issues);

      // Capture the persistent files while they are freshly produced by the package turn.
      if (step.role === 'generator_engineer' && step.mode === 'package') {
        packagedFiles = await this._downloadPersistent(controller, outDir);
      }

      if (step.kind === 'audit' && step.gate) {
        if (turn.handoff.stage_status === 'passed' && state.issues.blockingForRelease().length === 0) {
          gatesPassed.push(step.gate);
          this.log(`  ✓ "${step.gate}" gate passed`);
          if (step.gate === 'final') {
            const rec = Number(turn.handoff.recommended_status_code);
            statusCode = Number.isFinite(rec) ? rec : this.config.successCode;
          }
          continue;
        }

        // Non-recoverable stages (preflight/release/final): abort with a causal code.
        if (!['template', 'background', 'baseline', 'edge', 'regression'].includes(step.gate)) {
          failedStage = step.gate;
          const rec = Number(turn.handoff.recommended_status_code);
          statusCode = Number.isFinite(rec) && rec !== 0
            ? rec
            : selectFailureCode(state.issues.snapshot(), step.gate);
          this.log(`  ✗ "${step.gate}" gate failed → status ${statusCode}`);
          break;
        }

        // Recoverable QA gate: run the repair loop.
        const outcome = await this._repairGate(controller, step, state, transcript);
        if (outcome.recovered) {
          gatesPassed.push(step.gate);
          continue;
        }
        failedStage = outcome.stage || step.gate;
        statusCode = outcome.code;
        this.log(`  ✗ "${step.gate}" gate could not be repaired → status ${statusCode}`);
        break;
      }
    }

    const success = statusCode === this.config.successCode && gatesPassed.includes('final');
    if (!Number.isFinite(statusCode)) statusCode = success ? this.config.successCode : selectFailureCode(state.issues.snapshot(), failedStage);

    // Prefer files captured at the package turn; otherwise try the last reply.
    let files = packagedFiles;
    if (!files.length) files = await this._downloadPersistent(controller, outDir);

    return {
      runId,
      statusCode,
      success,
      failedStage,
      gatesPassed,
      issues: state.issues.snapshot(),
      files,
      transcript
    };
  }
}

// Load role prompt texts from <workflowDir>/roles.
export async function loadRoles(workflowDir) {
  const rolesDir = path.join(workflowDir, 'roles');
  const roles = {};
  for (const [role, file] of Object.entries(ROLE_FILES)) {
    roles[role] = await fs.readFile(path.join(rolesDir, file), 'utf8');
  }
  return roles;
}
