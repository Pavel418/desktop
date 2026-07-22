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

function extractFencedBlocks(text) {
  const src = String(text || '');
  const blocks = [];
  const closed = /```[^\r\n]*\r?\n([\s\S]*?)```/g;
  for (const match of src.matchAll(closed)) blocks.push(match[1]);
  // Streaming or malformed replies sometimes omit the final fence. Keep the tail as
  // a candidate; conservative bracket completion below decides whether it is usable.
  const lastFence = src.lastIndexOf('```');
  if (lastFence >= 0 && src.indexOf('```', lastFence + 3) === -1) {
    const tail = src.slice(lastFence + 3).replace(/^[^\r\n]*\r?\n?/, '');
    if (tail.trim()) blocks.push(tail);
  }
  return blocks;
}

function stripJsonComments(src) {
  let out = '';
  let quote = null;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
    } else if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
    } else {
      out += ch;
    }
  }
  return out;
}

function convertSingleQuotedStrings(src) {
  let out = '';
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inDouble) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inDouble = false;
      continue;
    }
    if (inSingle) {
      if (escaped) {
        if (ch === "'") out += "'";
        else if (ch === '"') out += '\\"';
        else out += `\\${ch}`;
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === "'") {
        out += '"';
        inSingle = false;
      } else if (ch === '"') {
        out += '\\"';
      } else if (ch === '\n') {
        out += '\\n';
      } else {
        out += ch;
      }
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
    } else if (ch === "'") {
      inSingle = true;
      out += '"';
    } else {
      out += ch;
    }
  }
  return out;
}

function transformOutsideStrings(src, transform) {
  let out = '';
  let segment = '';
  let inString = false;
  let escaped = false;
  for (const ch of src) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      out += transform(segment) + ch;
      segment = '';
      inString = true;
    } else {
      segment += ch;
    }
  }
  return out + transform(segment);
}

function completeJsonContainers(src) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const ch of src) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') {
      const expected = ch === '}' ? '{' : '[';
      if (stack.at(-1) !== expected) return src;
      stack.pop();
    }
  }
  if (inString || stack.length > 12) return src;
  return src + stack.reverse().map((ch) => (ch === '{' ? '}' : ']')).join('');
}

function relaxedJsonVariants(raw) {
  const base = String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/^\s*(?:json|javascript|js)\s*\r?\n/i, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/&quot;/gi, '"')
    .trim()
    .replace(/;\s*$/, '');
  const variants = [base, stripTrailingCommas(base)];
  if (/\\"/.test(base)) {
    const unescaped = base.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    variants.push(unescaped, stripTrailingCommas(unescaped));
  }
  let relaxed = convertSingleQuotedStrings(stripJsonComments(base));
  relaxed = transformOutsideStrings(relaxed, (segment) =>
    segment
      .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)(\s*:)/g, '$1"$2"$3')
      .replace(/\bNone\b/g, 'null')
      .replace(/\bTrue\b/g, 'true')
      .replace(/\bFalse\b/g, 'false')
      .replace(/\b(?:undefined|NaN)\b/g, 'null')
  );
  variants.push(relaxed, stripTrailingCommas(relaxed));
  if (/stage[_ -]?status/i.test(relaxed)) {
    variants.push(completeJsonContainers(relaxed), completeJsonContainers(stripTrailingCommas(relaxed)));
  }
  return Array.from(new Set(variants.filter(Boolean)));
}

function parseYamlScalar(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^(?:null|none|~)$/i.test(value)) return null;
  if (/^(?:true|false)$/i.test(value)) return /^true$/i.test(value);
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  if (/^[\[{]/.test(value)) {
    const parsed = parseRelaxedJson(value);
    if (parsed != null) return parsed;
  }
  return value;
}

// Constrained YAML-like fallback for the flat handoff shape GPT occasionally emits.
// It supports top-level scalars, scalar lists, and artifact/issue object lists; it is
// data-only and deliberately does not implement YAML tags, anchors, or execution.
function parseSimpleYamlHandoff(raw) {
  const src = String(raw || '').replace(/^\s*(?:yaml|yml)\s*\r?\n/i, '');
  if (!/(?:^|\n)\s*(?:stage_status|stageStatus)\s*:/m.test(src)) return null;
  const out = {};
  let section = null;
  let listObject = null;
  for (const originalLine of src.split(/\r?\n/)) {
    if (!originalLine.trim() || /^\s*#/.test(originalLine)) continue;
    const indent = originalLine.match(/^\s*/)?.[0].length || 0;
    const line = originalLine.trim();
    if (indent === 0) {
      const top = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
      if (!top) continue;
      const [, key, rest] = top;
      if (rest === '') {
        out[key] = [];
        section = key;
        listObject = null;
      } else {
        out[key] = parseYamlScalar(rest.replace(/\s+#.*$/, ''));
        section = null;
        listObject = null;
      }
      continue;
    }
    if (!section || !Array.isArray(out[section])) continue;
    const item = line.match(/^-\s*(.*)$/);
    if (item) {
      const objectStart = item[1].match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
      if (objectStart) {
        listObject = { [objectStart[1]]: parseYamlScalar(objectStart[2]) };
        out[section].push(listObject);
      } else {
        listObject = null;
        out[section].push(parseYamlScalar(item[1]));
      }
      continue;
    }
    const property = line.match(/^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (property && listObject) listObject[property[1]] = parseYamlScalar(property[2]);
  }
  return out;
}

function parseRelaxedJson(raw) {
  for (const variant of relaxedJsonVariants(raw)) {
    try {
      return JSON.parse(variant);
    } catch {}
  }
  return parseSimpleYamlHandoff(raw);
}

function canonicalToken(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  return [value];
}

const STATUS_ALIASES = new Map([
  ['pass', 'passed'], ['passed', 'passed'], ['success', 'passed'], ['succeeded', 'passed'],
  ['complete', 'passed'], ['completed', 'passed'], ['ok', 'passed'],
  ['fail', 'failed'], ['failed', 'failed'], ['error', 'failed'],
  ['blocked', 'blocked'], ['partial', 'blocked'],
  ['ready', 'ready_for_review'], ['ready_for_review', 'ready_for_review'], ['ready_to_review', 'ready_for_review']
]);

function objectField(obj, ...names) {
  for (const name of names) if (Object.hasOwn(obj, name)) return obj[name];
  return undefined;
}

// Normalize syntax and harmless naming variations, but never invent run IDs, roles,
// artifact paths, or hashes. Expected identity only resolves casing/separators and
// mode omissions after the supplied run and role already match.
function _normaliseHandoff(input, expected = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const obj = { ...input };
  obj.run_id = objectField(obj, 'run_id', 'runId', 'runID');
  obj.role = objectField(obj, 'role', 'agent_role', 'agentRole');
  obj.mode = objectField(obj, 'mode', 'stage_mode', 'stageMode');
  obj.stage_status = objectField(obj, 'stage_status', 'stageStatus', 'status');
  obj.recommended_status_code = objectField(
    obj, 'recommended_status_code', 'recommendedStatusCode', 'status_code', 'statusCode'
  );
  obj.artifacts = objectField(obj, 'artifacts', 'artifact', 'artifact_evidence', 'artifactEvidence', 'files');
  obj.evidence = objectField(obj, 'evidence', 'checks');
  obj.new_issues = objectField(obj, 'new_issues', 'newIssues');
  obj.verified_issues = objectField(obj, 'verified_issues', 'verifiedIssues');
  obj.fixed_issues = objectField(obj, 'fixed_issues', 'fixedIssues');
  obj.required_reruns = objectField(obj, 'required_reruns', 'requiredReruns', 'reruns');
  obj.next_role = objectField(obj, 'next_role', 'nextRole');

  if (typeof obj.stage_status !== 'string') return null;
  obj.stage_status = STATUS_ALIASES.get(canonicalToken(obj.stage_status)) || canonicalToken(obj.stage_status);
  obj.run_id = typeof obj.run_id === 'string' ? obj.run_id.trim() : obj.run_id;
  obj.role = canonicalToken(obj.role);
  const rawMode = obj.mode;
  obj.mode = rawMode == null || ['null', 'none', 'default', 'n/a', 'na', ''].includes(canonicalToken(rawMode))
    ? null
    : canonicalToken(rawMode);

  const expectedRole = canonicalToken(expected?.role);
  const runMatches = expected?.runId && typeof obj.run_id === 'string' && obj.run_id.toLowerCase() === String(expected.runId).toLowerCase();
  const roleMatches = expectedRole && obj.role === expectedRole;
  if (runMatches) obj.run_id = expected.runId;
  if (roleMatches) obj.role = expected.role;
  if (runMatches && roleMatches) {
    if (expected?.mode == null) obj.mode = null;
    else if (obj.mode == null || obj.mode === canonicalToken(expected.mode)) obj.mode = expected.mode;
  }

  for (const key of ['evidence', 'new_issues', 'verified_issues', 'fixed_issues', 'required_reruns']) {
    obj[key] = asList(obj[key]);
  }
  if (expected?.kind === 'write' && obj.verified_issues.length === 0 && obj.fixed_issues.length) {
    obj.verified_issues = [...obj.fixed_issues];
  }
  obj.artifacts = asList(obj.artifacts).map((artifact) => {
    if (!artifact || typeof artifact !== 'object') return artifact;
    return {
      ...artifact,
      path: objectField(artifact, 'path', 'file', 'file_path', 'filePath', 'artifact'),
      sha256: objectField(artifact, 'sha256', 'sha_256', 'hash', 'digest')
    };
  });
  if (typeof obj.recommended_status_code === 'string' && canonicalToken(obj.recommended_status_code) === 'null') {
    obj.recommended_status_code = null;
  }
  return obj;
}

function collectHandoffObjects(value, out, depth = 0) {
  if (depth > 8 || value == null) return;
  if (Array.isArray(value)) {
    for (const item of value) collectHandoffObjects(item, out, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;
  const keys = Object.keys(value);
  if (keys.some((key) => ['stage_status', 'stageStatus'].includes(key)) || (keys.includes('status') && keys.some((key) => ['role', 'agent_role', 'agentRole'].includes(key)))) {
    out.push(value);
  }
  for (const key of ['handoff', 'shared_handoff', 'sharedHandoff', 'result', 'output', 'data']) {
    if (Object.hasOwn(value, key)) collectHandoffObjects(value[key], out, depth + 1);
  }
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
// Parse strict or common GPT-adjacent data formats from the whole reply, fenced
// blocks, and balanced objects. When the caller supplies the expected stage identity,
// prefer that candidate over later decoy/report objects; final schema validation
// still happens separately at the orchestration boundary.
export function parseHandoff(text, expected = null) {
  const src = String(text || '');
  const rawCandidates = [src, ...extractFencedBlocks(src), ...extractJsonObjects(src)];
  const handoffs = [];
  for (const raw of Array.from(new Set(rawCandidates))) {
    const parsed = parseRelaxedJson(raw);
    if (parsed == null) continue;
    const objects = [];
    collectHandoffObjects(parsed, objects);
    for (const object of objects) {
      const normalized = _normaliseHandoff(object, expected);
      if (normalized) handoffs.push(normalized);
    }
  }
  if (!handoffs.length) return null;
  if (!expected) return handoffs.at(-1);

  const expectedRole = canonicalToken(expected.role);
  const expectedMode = expected.mode == null ? null : canonicalToken(expected.mode);
  let best = null;
  for (let index = 0; index < handoffs.length; index++) {
    const handoff = handoffs[index];
    let score = 0;
    if (String(handoff.run_id || '').toLowerCase() === String(expected.runId || '').toLowerCase()) score += 8;
    if (canonicalToken(handoff.role) === expectedRole) score += 8;
    if ((handoff.mode == null ? null : canonicalToken(handoff.mode)) === expectedMode) score += 4;
    if (HANDOFF_STATUSES.has(handoff.stage_status)) score += 2;
    if (!best || score > best.score || (score === best.score && index > best.index)) best = { handoff, score, index };
  }
  return best?.handoff || null;
}

// Tri-state response classifier consumed by ChatGPTController's wait loop. A balanced
// handoff is complete even when later schema validation will reject it (so the normal
// re-ask path can run). A visible handoff prefix without a closed envelope is still
// streaming/truncated and must not be accepted merely because the UI looks idle.
export function handoffResponseState(text, expected = null) {
  const src = String(text || '').trim();
  if (!src) return 'unknown';
  // The parser intentionally repairs a missing final brace for already-finished
  // replies. The live response gate must be stricter: only a genuinely balanced
  // object (or a complete YAML-shaped handoff) proves streaming has reached the end.
  const balancedHandoff = extractJsonObjects(src)
    .some((candidate) => parseHandoff(candidate, expected) != null);
  const parsed = parseHandoff(src, expected);
  const yamlHandoff = parsed != null
    && /(?:^|\n)\s*(?:stage_status|stageStatus)\s*:/m.test(src)
    && !/[{\[]/.test(src);
  if (balancedHandoff || yamlHandoff) return 'complete';
  const hasHandoffKey = /(?:^|[,{]\s*)["']?(?:run[_ -]?id|agent[_ -]?role|stage[_ -]?status|recommended[_ -]?status[_ -]?code)["']?\s*[:=]/im.test(src);
  const hasStructuredPrefix = /(?:^|\n)\s*(?:```\s*(?:json|yaml|yml)?\s*|(?:json|yaml|yml)\s*\r?\n)\s*[\[{]/i.test(src);
  return hasHandoffKey || hasStructuredPrefix ? 'incomplete' : 'unknown';
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

// The compact v3 handoff lists new issue IDs, while some roles also include the
// complete issue records in an `issues` array. Preserve those details whenever
// available so repair routing retains severity, domain, owner, and evidence.
export function issueRecordsFromHandoff(handoff) {
  const refs = Array.isArray(handoff?.new_issues) ? handoff.new_issues : [];
  const details = Array.isArray(handoff?.issues) ? handoff.issues.filter((i) => i && typeof i === 'object') : [];
  const byId = new Map(details.map((i) => [String(i.issue_id || ''), i]));
  const out = [];
  const seen = new Set();
  for (const ref of refs) {
    const id = String(ref?.issue_id || ref || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(typeof ref === 'object' ? { ...(byId.get(id) || {}), ...ref } : (byId.get(id) || ref));
  }
  for (const detail of details) {
    const id = String(detail.issue_id || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(detail);
  }
  return out;
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
    // A referenced ID with no inline record must remain blocking until an auditor
    // verifies it; otherwise compact handoffs silently discard critical findings.
    if (typeof record === 'string' && record) record = { issue_id: record, severity: 'major' };
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
    if (!controller.downloadLastAssistantEntities && !controller.downloadLastAssistantFiles) return [];
    await fs.mkdir(outDir, { recursive: true }).catch(() => {});
    const stagingDir = await fs.mkdtemp(path.join(outDir, '.persistent-download-'));
    try {
      const entities = controller.downloadLastAssistantEntities
        ? await controller.downloadLastAssistantEntities({ outDir: stagingDir }).catch(() => [])
        : [];
      const links = controller.downloadLastAssistantFiles
        ? await controller.downloadLastAssistantFiles({ maxFiles: 20, outDir: stagingDir }).catch(() => [])
        : [];
      const found = new Map();
      for (const file of [...entities, ...links]) {
        if (file && PERSISTENT_FILES.includes(file.name) && !found.has(file.name)) found.set(file.name, file);
      }
      const published = [];
      for (const name of PERSISTENT_FILES) {
        const file = found.get(name);
        if (!file) continue;
        const destination = path.join(outDir, name);
        await fs.copyFile(file.path, destination);
        published.push({ path: destination, name });
      }
      return published;
    } finally {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  async _ensurePersistentDownloads(controller, outDir, transcript) {
    const captured = new Map();
    const collect = async () => {
      for (const file of await this._downloadPersistent(controller, outDir)) captured.set(file.name, file);
    };
    await collect();
    for (let attempt = 1; attempt <= 2 && captured.size < PERSISTENT_FILES.length; attempt++) {
      const missing = PERSISTENT_FILES.filter((name) => !captured.has(name));
      this.log(`  · package download recovery ${attempt}/2: requesting ${missing.join(', ')}`);
      const reply = await controller.followUp({
        text:
          `The package artifacts were not all exposed as downloadable attachments. ` +
          `Do not regenerate or modify them. Attach the existing files ${missing.join(', ')} to this reply ` +
          `with those exact filenames. Reply briefly and do not emit another handoff JSON.`,
        timeoutMs: this.config.perTurnTimeoutMs
      });
      transcript.push({ role: 'generator_engineer', mode: 'package_download', text: String(reply?.text || '') });
      await collect();
    }
    return PERSISTENT_FILES.map((name) => captured.get(name)).filter(Boolean);
  }

  async _send(controller, message, { first, attachments, timeoutMs, newChat, responseState = null }) {
    if (first) {
      return controller.query({ prompt: message, attachments, timeoutMs, newChat, responseState });
    }
    return controller.followUp({ text: message, timeoutMs, responseState });
  }

  // Run one role turn: send, capture text, parse the handoff (re-asking once if needed).
  async _turn(controller, step, ctx, sendOpts, transcript) {
    const message = this._composeMessage(step, ctx, { includeShared: sendOpts.first });
    const expected = { runId: ctx.runId, role: step.role, mode: step.mode ?? null, kind: step.kind };
    const responseState = (candidate) => handoffResponseState(candidate, expected);
    let result = await this._send(controller, message, { ...sendOpts, responseState });
    let text = String(result?.text || '');
    transcript.push({ role: step.role, mode: step.mode, text });
    let handoff = parseHandoff(text, expected);
    let validationError = handoff ? handoffValidationError(handoff, step, ctx.runId) : 'handoff JSON not found';
    if (validationError) handoff = null;
    if (!handoff && this.config.reAskOnBadHandoff) {
      this.log(
        `  · ${step.role}${step.mode ? '/' + step.mode : ''}: invalid handoff ` +
          `(${validationError}; replyChars=${text.length}) — re-asking once`
      );
      const reask = await controller.followUp({
        text: 'Your previous reply did not end with a valid shared-handoff JSON block. ' +
          `Reply again with ONLY the required fenced \`\`\`json handoff object. Required identity: ` +
          `run_id=${ctx.runId}, role=${step.role}, mode=${step.mode ?? 'null'}. ` +
          'Include an artifacts array and a valid SHA-256 for every listed artifact.',
        timeoutMs: sendOpts.timeoutMs,
        responseState
      });
      text = String(reask?.text || '');
      transcript.push({ role: step.role, mode: step.mode, text, reask: true });
      handoff = parseHandoff(text, expected);
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
      state.issues.addNew(issueRecordsFromHandoff(repairTurn.handoff));

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
        state.issues.addNew(issueRecordsFromHandoff(writerTurn.handoff));
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
        state.issues.addNew(issueRecordsFromHandoff(qaTurn.handoff));
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
        state.issues.addNew(issueRecordsFromHandoff(qaTurn.handoff));
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

  // Preflight findings concern the reusable base runtime and must be repaired by
  // Generator Engineer before template analysis starts. Re-audit them with Contract
  // Auditor; routing them through QA modes would run template checks before a
  // template specification exists.
  async _repairPreflight(controller, state, transcript) {
    for (let round = 1; round <= this.config.maxRepairRounds; round++) {
      const assigned = state.issues.open();
      this.log(`  ↻ preflight repair round ${round}/${this.config.maxRepairRounds} (${assigned.length} open issue(s))`);

      const planner = await this._turn(
        controller,
        { role: 'repair_engineer', mode: null, gate: 'preflight' },
        {
          ...state.ctx,
          gate: 'preflight',
          assignedIssues: assigned,
          extra: 'Plan only the reusable-runtime preflight corrections. Do not perform template adaptation, edit files, or verify issues.'
        },
        { first: false, timeoutMs: this.config.perTurnTimeoutMs },
        transcript
      );
      if (!planner.handoff || !['passed', 'ready_for_review'].includes(planner.handoff.stage_status)) {
        return { recovered: false, code: selectFailureCode(state.issues.snapshot(), 'preflight'), stage: 'preflight' };
      }
      state.issues.addNew(issueRecordsFromHandoff(planner.handoff));

      const writer = await this._turn(
        controller,
        { role: 'generator_engineer', mode: 'repair', kind: 'write' },
        {
          ...state.ctx,
          gate: 'preflight',
          assignedIssues: state.issues.open(),
          extra: 'Apply only the approved base-runtime preflight corrections. Mark addressed issue IDs fixed, never verified. Do not adapt the target template yet.'
        },
        { first: false, timeoutMs: this.config.perTurnTimeoutMs },
        transcript
      );
      if (!writer.handoff || !['passed', 'ready_for_review'].includes(writer.handoff.stage_status)) {
        return { recovered: false, code: selectFailureCode(state.issues.snapshot(), 'preflight'), stage: 'preflight' };
      }
      state.issues.addNew(issueRecordsFromHandoff(writer.handoff));
      state.issues.markFixed(writer.handoff.verified_issues);

      const audit = await this._turn(
        controller,
        { role: 'contract_auditor', mode: 'preflight', gate: 'preflight', kind: 'audit' },
        {
          ...state.ctx,
          gate: 'preflight',
          assignedIssues: state.issues.snapshot().filter((issue) => issue.status !== 'verified'),
          extra: 'Re-run preflight after repair. Verify each corrected issue ID explicitly, reopen failures with complete issue records, and do not perform template adaptation.'
        },
        { first: false, timeoutMs: this.config.perTurnTimeoutMs },
        transcript
      );
      if (!audit.handoff) return { recovered: false, code: 99, stage: 'preflight' };
      state.issues.addNew(issueRecordsFromHandoff(audit.handoff));
      state.issues.markVerified(audit.handoff.verified_issues);

      if (audit.handoff.stage_status === 'passed' && state.issues.blockingForRelease().length === 0) {
        this.log(`  ✓ "preflight" gate recovered after repair round ${round}`);
        return { recovered: true };
      }
    }
    return { recovered: false, code: selectFailureCode(state.issues.snapshot(), 'preflight'), stage: 'preflight' };
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
    let packageProduced = false;

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
      state.issues.addNew(issueRecordsFromHandoff(turn.handoff));
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
        packageProduced = true;
        packagedFiles = await this._ensurePersistentDownloads(controller, outDir, transcript);
        const missing = PERSISTENT_FILES.filter((name) => !packagedFiles.some((file) => file.name === name));
        if (missing.length) {
          failedStage = 'package';
          statusCode = 70;
          this.log(`  ✗ package did not expose downloadable persistent files: ${missing.join(', ')} → status 70`);
          break;
        }
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

        // Preflight defects are base-runtime defects. Repair them before any target
        // template work, then have Contract Auditor independently re-run preflight.
        if (step.gate === 'preflight') {
          const outcome = await this._repairPreflight(controller, state, transcript);
          if (outcome.recovered) {
            gatesPassed.push(step.gate);
            continue;
          }
          failedStage = outcome.stage;
          statusCode = outcome.code;
          this.log(`  ✗ "preflight" gate could not be repaired → status ${statusCode}`);
          break;
        }

        // Release and final remain non-recoverable in this run.
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

    const workflowReachedSuccess = statusCode === this.config.successCode && gatesPassed.includes('final');
    if (!Number.isFinite(statusCode)) {
      statusCode = workflowReachedSuccess ? this.config.successCode : selectFailureCode(state.issues.snapshot(), failedStage);
    }

    // Files are captured and recovery-retried at the package turn. Never invoke the
    // downloader on an early failure response: no persistent files exist yet.
    const files = packagedFiles;

    const missingPersistent = PERSISTENT_FILES.filter((name) => !files.some((file) => file.name === name));
    if (packageProduced && missingPersistent.length) {
      statusCode = 70;
      failedStage = 'package';
    }

    const success = statusCode === this.config.successCode && gatesPassed.includes('final') && missingPersistent.length === 0;

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
