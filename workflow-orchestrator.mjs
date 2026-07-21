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
  'preflight', 'template', 'background', 'baseline', 'fidelity', 'edge', 'regression', 'release', 'final'
];

// QA modes that a repair round can re-run.
export const QA_MODES = ['template', 'background', 'baseline', 'fidelity', 'edge', 'regression'];

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
  { role: 'controller', mode: 'start', gate: null, kind: 'control' },
  { role: 'contract_auditor', mode: 'preflight', gate: 'preflight', kind: 'audit' },
  { role: 'template_analyst', mode: null, gate: null, kind: 'write' },
  { role: 'template_architect', mode: null, gate: null, kind: 'write' },
  { role: 'qa_auditor', mode: 'template', gate: 'template', kind: 'audit' },
  { role: 'generator_engineer', mode: 'background', gate: null, kind: 'write' },
  { role: 'qa_auditor', mode: 'background', gate: 'background', kind: 'audit' },
  { role: 'generator_engineer', mode: 'implementation', gate: null, kind: 'write' },
  { role: 'qa_auditor', mode: 'baseline', gate: 'baseline', kind: 'audit' },
  { role: 'qa_auditor', mode: 'fidelity', gate: 'fidelity', kind: 'audit' },
  { role: 'qa_auditor', mode: 'edge', gate: 'edge', kind: 'audit' },
  { role: 'qa_auditor', mode: 'regression', gate: 'regression', kind: 'audit' },
  { role: 'generator_engineer', mode: 'package', gate: null, kind: 'write' },
  { role: 'contract_auditor', mode: 'release', gate: 'release', kind: 'audit' },
  { role: 'final_auditor', mode: null, gate: 'final', kind: 'audit' },
  { role: 'controller', mode: 'finalize', gate: null, kind: 'control' }
];

// Repair dependency map: issue domain -> QA modes that must rerun (07_REPAIR_ENGINEER).
export const RERUN_MAP = {
  runtime: ['regression'],
  geometry: ['template', 'background', 'baseline', 'edge'],
  reconstruction: ['background', 'baseline', 'fidelity', 'edge'],
  typography: ['baseline', 'edge'],
  placement: ['baseline', 'edge'],
  annotation: ['baseline', 'edge'],
  semantics: ['template', 'baseline'],
  compatibility: ['baseline'],
  packaging: ['regression']
};

// Causal status codes (match generator.py STATUS_CODES).
const DOMAIN_CODE = {
  runtime: 20, compatibility: 20, semantics: 30, geometry: 50, annotation: 50,
  reconstruction: 60, typography: 60, placement: 60, fidelity: 60, packaging: 70
};
const STAGE_CODE = {
  preflight: 30, template: 50, background: 60, baseline: 60, fidelity: 60, edge: 60,
  regression: 99, release: 70, final: 99,
  start: 20, finalize: 20,
  template_analyst: 50, template_architect: 50, implementation: 20, package: 70
};
const SEVERITY_RANK = { critical: 3, major: 2, minor: 1, info: 0 };

export const PERSISTENT_FILES = ['generator.py', 'manifest.json', 'generator_report.json'];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

// Extract every balanced top-level {...} object appearing anywhere in `text`. This is
// deliberately fence-agnostic: it ignores markdown fence markers, language tags (or
// their absence), and narrative prose entirely, and only tracks JSON string literals
// (double-quoted, escape-aware) so that braces/brackets INSIDE a string value — or
// nested objects/arrays like a handoff's evidence/new_issues entries — never truncate
// the match. A naive non-greedy regex (`\{[\s\S]*?\}`) stops at the FIRST closing brace
// after a match, which cuts a real handoff off mid-way through its first nested
// evidence/issue object; this scanner tracks actual nesting depth instead.
function extractJsonObjects(text) {
  const src = String(text || '');
  const objects = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escapeNext = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (escapeNext) escapeNext = false;
      else if (ch === '\\') escapeNext = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          objects.push(src.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return objects;
}

// Repair the single most common LLM JSON slip: a trailing comma before a closing
// brace/bracket (e.g. from an item added last-minute without removing the prior comma).
function stripTrailingCommas(jsonText) {
  return jsonText.replace(/,(\s*[}\]])/g, '$1');
}

// A parsed object counts as a handoff only once normalised: it must carry a string
// stage_status, and its list fields default to [] so downstream code never has to
// null-check them.
function _normaliseHandoff(obj) {
  if (!obj || typeof obj !== 'object' || typeof obj.stage_status !== 'string') return null;
  for (const key of ['evidence', 'new_issues', 'verified_issues', 'required_reruns']) {
    if (!Array.isArray(obj[key])) obj[key] = [];
  }
  return obj;
}

const HANDOFF_STATUSES = new Set(['passed', 'failed', 'blocked', 'ready_for_review']);

// Validate the v3 inter-agent envelope at the orchestration boundary. Artifact entries
// are hash-bound; only control turns may omit artifact evidence.
function handoffValidationError(handoff, step, runId) {
  if (!handoff || handoff.run_id !== runId) return 'run_id mismatch';
  if (handoff.role !== step.role) return 'role mismatch';
  if ((handoff.mode ?? null) !== (step.mode ?? null)) return 'mode mismatch';
  if (!HANDOFF_STATUSES.has(handoff.stage_status)) return 'invalid stage_status';
  if (handoff.recommended_status_code != null && !Number.isFinite(Number(handoff.recommended_status_code))) {
    return 'recommended_status_code must be numeric or null';
  }
  if (!Array.isArray(handoff.artifacts)) return 'artifacts must be an array';
  if (step.kind !== 'control' && handoff.artifacts.length === 0) return 'artifact evidence is required';
  for (const artifact of handoff.artifacts) {
    if (!artifact || typeof artifact.path !== 'string' || !artifact.path) return 'artifact path is missing';
    if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) {
      return `artifact hash is invalid: ${artifact.path}`;
    }
  }
  return null;
}

// Extract the handoff object from a reply. A reply may contain several JSON objects
// (e.g. a pasted report.json, the visual-review envelope, AND the handoff itself), in
// or out of markdown fences, with or without a "json" language tag. Scan the WHOLE
// text for balanced top-level objects and take the LAST one (scanning backward) that
// parses and carries a stage_status — matching the shared contract's "keep the
// handoff block last" rule regardless of how the model formatted it.
export function parseHandoff(text) {
  const objects = extractJsonObjects(text);
  for (let i = objects.length - 1; i >= 0; i--) {
    let obj;
    try {
      obj = JSON.parse(objects[i]);
    } catch {
      try {
        obj = JSON.parse(stripTrailingCommas(objects[i]));
      } catch {
        continue;
      }
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
    if (typeof record === 'string' && record) record = { issue_id: record };
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
  perTurnTimeoutMs: 7_200_000,
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
    parts.push('===== SHARED ADAPTATION CONTRACT =====');
    parts.push(this.roles.shared.trim());
    if (includeShared) {
      parts.push(
        `\nInputs attached to this chat: the target scanned PDF (${ctx.pdfName}) and the base generator.py. ` +
        `Save the generator as generator.py in your working directory and drive it with its CLI.`
      );
    }
    parts.push(`\nActive run id: ${ctx.runId}. Use this exact value in the handoff.`);
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
    let validationError = handoff ? handoffValidationError(handoff, step, ctx.runId) : 'handoff JSON not found';
    if (validationError) handoff = null;
    if (!handoff && this.config.reAskOnBadHandoff) {
      this.log(`  · ${step.role}${step.mode ? '/' + step.mode : ''}: invalid handoff (${validationError}) — re-asking once`);
      const reask = await controller.followUp({
        text: 'Your previous reply did not end with a valid shared-handoff JSON block. ' +
          `Reply again with ONLY the required fenced \`\`\`json handoff object. Required identity: ` +
          `run_id=${ctx.runId}, role=${step.role}, mode=${step.mode ?? 'null'}. ` +
          'Include an artifacts array and a valid SHA-256 for every listed artifact.',
        timeoutMs: sendOpts.timeoutMs
      });
      text = String(reask?.text || '');
      transcript.push({ role: step.role, mode: step.mode, text, reask: true });
      handoff = parseHandoff(text);
      validationError = handoff ? handoffValidationError(handoff, step, ctx.runId) : 'handoff JSON not found';
      if (validationError) handoff = null;
    }
    return { handoff, result, text };
  }

  // Attempt to recover a failed gate via repair rounds with targeted reruns.
  async _repairGate(controller, step, state, transcript) {
    const gate = step.gate;
    for (let round = 1; round <= this.config.maxRepairRounds; round++) {
      const assigned = state.issues.open();
      this.log(`  ↻ repair round ${round}/${this.config.maxRepairRounds} for "${gate}" gate (${assigned.length} open issue(s))`);

      // 1) Repair Engineer diagnoses the root cause and plans the smallest change.
      const repairTurn = await this._turn(
        controller,
        { role: 'repair_engineer', mode: null, gate },
        { ...state.ctx, gate, assignedIssues: assigned,
          extra: 'Plan the smallest root-cause correction and list exact required_reruns. Do not edit or verify artifacts; the owning writer applies the change next.' },
        { first: false, timeoutMs: this.config.perTurnTimeoutMs },
        transcript
      );
      if (!repairTurn.handoff) return { recovered: false, code: 99, stage: gate };
      if (!['passed', 'ready_for_review'].includes(repairTurn.handoff.stage_status)) {
        return { recovered: false, code: selectFailureCode(state.issues.snapshot(), gate), stage: gate };
      }
      state.issues.addNew(repairTurn.handoff.new_issues);

      // 2) The owning writer applies the plan. Template geometry/semantics belongs to
      // Template Architect; all generator/runtime/reconstruction concerns belong to
      // Generator Engineer repair mode.
      const domains = new Set(assigned.map((issue) => String(issue?.domain || '').toLowerCase()).filter(Boolean));
      const architectOwned = gate === 'template' || domains.has('geometry') || domains.has('semantics');
      const generatorOwned = gate !== 'template' || [...domains].some((domain) => !['geometry', 'semantics'].includes(domain));
      const writerSteps = [];
      if (architectOwned) writerSteps.push({ role: 'template_architect', mode: null, kind: 'write' });
      if (generatorOwned) writerSteps.push({ role: 'generator_engineer', mode: 'repair', kind: 'write' });

      const writerReruns = [];
      for (const writerStep of writerSteps) {
        const writerTurn = await this._turn(
          controller,
          writerStep,
          { ...state.ctx, gate, assignedIssues: assigned,
            extra: 'Apply the Repair Engineer plan in your owned domain. Mark addressed issue IDs fixed, never verified, and return exact required_reruns.' },
          { first: false, timeoutMs: this.config.perTurnTimeoutMs },
          transcript
        );
        if (!writerTurn.handoff || !['passed', 'ready_for_review'].includes(writerTurn.handoff.stage_status)) {
          return { recovered: false, code: selectFailureCode(state.issues.snapshot(), gate), stage: gate };
        }
        state.issues.addNew(writerTurn.handoff.new_issues);
        state.issues.markFixed(writerTurn.handoff.verified_issues);
        writerReruns.push(...writerTurn.handoff.required_reruns);
      }

      const rerunModes = mergeReruns(
        [...repairTurn.handoff.required_reruns, ...writerReruns],
        state.issues.open()
      );
      // Always re-run at least the failing gate's own mode if it is a QA mode.
      const modes = rerunModes.length ? rerunModes : (QA_MODES.includes(gate) ? [gate] : []);
      this.log(`    reruns: ${modes.join(', ') || '(none)'}`);

      // 3) Re-run the affected QA modes (independent auditor).
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
      else if (step.kind === 'write') state.issues.markFixed(turn.handoff.verified_issues);

      // Creation roles may hand off either a completed stage or an artifact that is
      // ready for independent review. Fail closed on blocked, failed, or unknown
      // statuses instead of continuing to an auditor with incomplete artifacts.
      if (step.kind !== 'audit' && !['passed', 'ready_for_review'].includes(turn.handoff.stage_status)) {
        failedStage = step.mode || step.role;
        const rec = Number(turn.handoff.recommended_status_code);
        statusCode = Number.isFinite(rec) && rec !== 0
          ? rec
          : selectFailureCode(state.issues.snapshot(), failedStage);
        this.log(`  ✗ "${failedStage}" ${step.kind} stage failed → status ${statusCode}`);
        break;
      }

      if (step.role === 'controller' && step.mode === 'finalize') {
        const rec = turn.handoff.recommended_status_code;
        if (rec != null && Number.isFinite(Number(rec))) statusCode = Number(rec);
      }

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
        if (!QA_MODES.includes(step.gate)) {
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
