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
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Static workflow definition
// ---------------------------------------------------------------------------

// Ordered gates (see workflow/WORKFLOW.md "Stage gates"). The base generator is a fixed,
// known-good artifact, so its soundness is verified mechanically (a byte-hash identity check in
// run()) instead of by an LLM "preflight" audit — which re-derived the same static facts every
// run and, worse, hallucinated repairable defects into a clean file. See _checkGeneratorIdentity.
export const GATES = [
  'template', 'background', 'baseline', 'fidelity', 'edge', 'regression', 'release', 'final'
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
  template: 50, background: 60, baseline: 60, fidelity: 60, edge: 60,
  regression: 99, release: 70, final: 99,
  start: 20, finalize: 20, generator_identity: 20,
  template_analyst: 50, template_architect: 50, implementation: 20, package: 70
};
const SEVERITY_RANK = { critical: 3, major: 2, minor: 1, info: 0 };

export const PERSISTENT_FILES = ['generator.py', 'manifest.json', 'generator_report.json'];

// The six QA gates the visual-review envelope must cover (release/final are not QA gates).
const ENVELOPE_QA_GATES = ['template', 'background', 'baseline', 'fidelity', 'edge', 'regression'];

// Roles that create artifacts. A visual review authored by any of these is a self-approval and is
// rejected by the envelope builder (mirrors generator.py's VISUAL_REVIEW_SELF_APPROVAL check).
export const WRITER_ROLES = new Set(['generator_engineer', 'template_architect']);

// Release-envelope vocabulary. The generator separately validates an in-sandbox machine-review
// envelope because package hashes do not exist until after that audit completes. Keep this version
// in sync with ORCHESTRATOR_VISUAL_REVIEW_SCHEMA_VERSION in workflow/generator.py.
export const VISUAL_REVIEW_SCHEMA_VERSION = 'synthetic-document-visual-review/1.2';
export const EDGE_CASES = [
  'normal_random_placement',
  'top_left_placement',
  'bottom_right_placement',
  'wide_glyph_pressure',
  'narrow_glyph_pressure',
  'long_unbroken_strings',
  'punctuation',
  'multilingual_text',
  'dense_multiline_text',
  'minimum_font_size',
  'maximum_permitted_character_length',
  'low_dpi',
  'high_dpi',
  'text_near_field_edges',
  'shared_collision_groups',
  'expected_max_chars_failure',
  'expected_impossible_fit_failure'
];
// 1-indexed name lookup used to backfill a decision's case number from its canonical name.
const EDGE_CASE_INDEX = new Map(EDGE_CASES.map((name, i) => [name, i + 1]));

// SHA-256 of a file's bytes — the orchestrator's own, independently computed hash (as opposed to
// the model-claimed hashes carried in handoffs).
export async function sha256File(filePath) {
  const bytes = await fs.readFile(filePath);
  return createHash('sha256').update(bytes).digest('hex');
}

// Render a millisecond duration as a compact, human-readable string ("8m 12s", "540ms", "1h 03m").
export function humanizeDuration(ms) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  if (n < 1000) return `${n}ms`;
  const totalSec = Math.round(n / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

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

// Per-edge-case decision statuses. `passed` and `expected_failure` are both "resolved"; cases 16 and
// 17 are the two expected failures (MAX_CHARS_EXCEEDED / TEXT_CANNOT_FIT).
const EDGE_STATUS_ALIASES = new Map([
  ['pass', 'passed'], ['passed', 'passed'], ['ok', 'passed'], ['success', 'passed'], ['approved', 'passed'],
  ['expected_failure', 'expected_failure'], ['expected_fail', 'expected_failure'], ['xfail', 'expected_failure'],
  ['known_failure', 'expected_failure'], ['expected', 'expected_failure'],
  ['fail', 'failed'], ['failed', 'failed'], ['error', 'failed']
]);

// Normalize a qa_auditor/edge handoff's per-case decisions: canonicalize aliases and backfill a
// missing case number from the canonical name (resolution, not invention — like the mode backfill).
function normaliseEdgeDecisions(value) {
  const list = asList(value);
  if (!list.length) return [];
  return list.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const name = canonicalToken(objectField(entry, 'name', 'edge_case', 'edgeCase', 'case_name', 'caseName')) || null;
    let caseNum = Number(objectField(entry, 'case', 'case_number', 'caseNumber', 'index', 'id', 'number'));
    if (!Number.isInteger(caseNum) && name && EDGE_CASE_INDEX.has(name)) caseNum = EDGE_CASE_INDEX.get(name);
    const rawStatus = objectField(entry, 'status', 'decision', 'result', 'outcome');
    return {
      ...entry,
      case: Number.isInteger(caseNum) ? caseNum : null,
      name,
      status: EDGE_STATUS_ALIASES.get(canonicalToken(rawStatus)) || canonicalToken(rawStatus),
      code: objectField(entry, 'code', 'status_code', 'statusCode') ?? null,
      artifact: objectField(entry, 'artifact', 'path', 'file') ?? null
    };
  });
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
  obj.issues = objectField(obj, 'issues', 'issue_records', 'issueRecords');
  obj.verified_issues = objectField(obj, 'verified_issues', 'verifiedIssues');
  obj.fixed_issues = objectField(obj, 'fixed_issues', 'fixedIssues');
  obj.required_reruns = objectField(obj, 'required_reruns', 'requiredReruns', 'reruns');
  obj.next_role = objectField(obj, 'next_role', 'nextRole');
  obj.edge_decisions = objectField(
    obj, 'edge_decisions', 'edgeDecisions', 'edge_cases', 'edgeCases', 'per_edge_decisions', 'perEdgeDecisions'
  );

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

  for (const key of ['evidence', 'new_issues', 'issues', 'verified_issues', 'fixed_issues', 'required_reruns']) {
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
  obj.edge_decisions = normaliseEdgeDecisions(obj.edge_decisions);
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
const ISSUE_SEVERITIES = new Set(['critical', 'major', 'minor']);
const ISSUE_DOMAINS = new Set([
  'runtime', 'geometry', 'semantics', 'reconstruction', 'typography', 'placement',
  'annotation', 'compatibility', 'packaging'
]);

function completeIssueRecordError(issue) {
  if (!issue || typeof issue !== 'object' || Array.isArray(issue)) return 'new issue must be a complete object, not an ID';
  if (typeof issue.issue_id !== 'string' || !issue.issue_id.trim()) return 'new issue is missing issue_id';
  if (!ISSUE_SEVERITIES.has(canonicalToken(issue.severity))) return `${issue.issue_id}: invalid or missing severity`;
  if (!ISSUE_DOMAINS.has(canonicalToken(issue.domain))) return `${issue.issue_id}: invalid or missing domain`;
  for (const key of ['code', 'stage', 'artifact', 'evidence', 'owner']) {
    if (typeof issue[key] !== 'string' || !issue[key].trim()) return `${issue.issue_id}: missing ${key}`;
  }
  if (!Array.isArray(issue.required_reruns)) return `${issue.issue_id}: required_reruns must be an array`;
  if (!['open', 'fixed', 'verified', 'blocked'].includes(canonicalToken(issue.status))) {
    return `${issue.issue_id}: invalid or missing status`;
  }
  return null;
}

// Validate the v3 inter-agent envelope at the orchestration boundary. Artifact entries
// are hash-bound; only control turns may omit artifact evidence.
export function handoffValidationError(handoff, step, runId) {
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
  const detailedIssues = issueRecordsFromHandoff(handoff);
  if (handoff.new_issues.length !== detailedIssues.length) return 'every new issue must have one complete issue record';
  for (const issue of detailedIssues) {
    const issueError = completeIssueRecordError(issue);
    if (issueError) return issueError;
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

// Restrict a rerun list to QA stages at or before `gate` in pipeline order. Downstream stages have
// not produced artifacts yet during an early gate's repair, so auditing them there is spurious.
// A no-op for late gates (regression sees everything). Preserves QA_MODES order.
export function clampRerunsToGate(rerunModes = [], gate = null) {
  const gateIdx = QA_MODES.indexOf(gate);
  return rerunModes.filter((m) => {
    const i = QA_MODES.indexOf(m);
    return i >= 0 && (gateIdx < 0 || i <= gateIdx);
  });
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
  reAskOnBadHandoff: true,
  // Release/final evidence (visual-review envelope + per-edge decisions) is pasted inline
  // when it fits this many characters; otherwise it is written to a single file and
  // attached, keeping the isolated auditor's prompt short so its attention stays sharp.
  auditEvidenceInlineMax: 12_000,
  // Require the qa_auditor/edge review to resolve all 17 individual edge cases before the
  // visual-review envelope can be built. Default false so bare-config unit tests stay green;
  // run-batch enables it in production.
  enforceEdgeDecisions: false,
  // Optional pin for the base generator's SHA-256. When set, run() fails fast (status 20) if the
  // attached base generator's bytes do not match — the mechanical replacement for the LLM
  // preflight audit. When null, the hash is only logged (no enforcement).
  expectedGeneratorSha256: null
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
  //
  // The full shared contract is sent ONLY on the first turn of a chat (includeShared). ChatGPT
  // retains it for the rest of that conversation, so later turns carry a one-line reminder instead
  // of re-appending ~6 KB every turn. The isolated audit session is a separate chat, so its first
  // turn (the release audit) also gets includeShared → the full contract there too.
  _composeMessage(step, ctx, { includeShared }) {
    const parts = [];
    if (includeShared) {
      parts.push('===== SHARED ADAPTATION CONTRACT =====');
      parts.push(this.roles.shared.trim());
      // A fresh isolated-audit turn overrides the default writer-oriented note, because it
      // starts a brand-new chat with different attachments and no prior sandbox.
      parts.push(
        '\n' + (ctx.inputsNote ||
          `Inputs attached to this chat: the target scanned PDF (${ctx.pdfName}) and the base generator.py. ` +
          `Save the generator as generator.py in your working directory and drive it with its CLI.`)
      );
    } else {
      parts.push('(The shared adaptation contract provided at the start of this chat is still in force; keep following it.)');
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

  // Record one passing QA review into state.reviews (latest per gate wins), so the envelope
  // builder can assemble a reviewer-sourced certification. Pure data, no reasoning text.
  _recordReview(state, step, handoff, round = 0) {
    const record = {
      gate: step.gate ?? step.mode ?? null,
      role: handoff.role || step.role,
      mode: step.mode ?? null,
      status: handoff.stage_status,
      round,
      artifacts: (handoff.artifacts || []).map((a) => ({ path: a.path, sha256: a.sha256, source: 'model_claimed' })),
      verified_issues: handoff.verified_issues || [],
      edge_decisions: handoff.edge_decisions || []
    };
    const gate = record.gate;
    const existing = state.reviews.findIndex((r) => r.gate === gate);
    if (existing >= 0) state.reviews[existing] = record;
    else state.reviews.push(record);
  }

  // Assemble and validate the orchestrator's visual-review envelope (Envelope-O) from the retained
  // QA reviews plus the downloaded package files. This is the mechanical home the docs promise: it
  // certifies an independent, hash-bound review before the release decision. Returns
  // { envelope } on success or { error: { message, code } } on a fail-closed condition.
  //
  // Honest scope: the three persistent files are hashed here by the orchestrator itself
  // (source: 'orchestrator_verified'); sandbox artifacts (overlays, edge documents) never left the
  // model, so their hashes stay 'model_claimed' and are labeled as such.
  async _buildAndValidateEnvelope(state, packagedFiles, outDir) {
    const fail = (code, message) => ({ error: { code, message } });

    // 1) All six QA gates reviewed and passed.
    const byGate = new Map(state.reviews.map((r) => [r.gate, r]));
    for (const gate of ENVELOPE_QA_GATES) {
      const review = byGate.get(gate);
      if (!review || review.status !== 'passed') {
        return fail(60, `visual-review envelope: QA gate "${gate}" has no passing review`);
      }
    }

    // 2) Reviewer ≠ writer. The orchestrator assigned every role, so this is authoritative.
    for (const gate of ENVELOPE_QA_GATES) {
      const review = byGate.get(gate);
      if (review.role !== 'qa_auditor' || WRITER_ROLES.has(review.role)) {
        return fail(30, `visual-review envelope: gate "${gate}" was reviewed by a non-independent role "${review.role}"`);
      }
    }

    // 3) Exactly 17 resolved per-edge decisions from the edge review.
    if (this.config.enforceEdgeDecisions !== false) {
      const edge = byGate.get('edge');
      const resolved = new Set(
        (edge.edge_decisions || [])
          .filter((d) => ['passed', 'expected_failure'].includes(d.status) && Number.isInteger(d.case) && d.case >= 1 && d.case <= 17)
          .map((d) => d.case)
      );
      if (resolved.size !== EDGE_CASES.length) {
        return fail(60, `visual-review envelope: edge review resolved ${resolved.size}/${EDGE_CASES.length} individual cases`);
      }
    }

    // 4) Every referenced artifact carries a valid model-claimed hash.
    for (const review of state.reviews) {
      for (const a of review.artifacts) {
        if (!a.path || typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(a.sha256)) {
          return fail(30, `visual-review envelope: gate "${review.gate}" has an artifact without a valid hash`);
        }
      }
    }

    // 5) No unresolved blocking issue.
    if (state.issues.blockingForRelease().length !== 0) {
      return fail(60, 'visual-review envelope: unresolved critical/major issues remain');
    }

    // 6) Orchestrator-verified hashes of the three persistent files.
    const packageArtifacts = [];
    for (const name of PERSISTENT_FILES) {
      const file = packagedFiles.find((f) => f.name === name);
      if (!file) return fail(70, `visual-review envelope: persistent file ${name} is missing`);
      packageArtifacts.push({ path: name, sha256: await sha256File(file.path), source: 'orchestrator_verified' });
    }

    // 7) Cross-check the downloaded generator_report.json (and manifest) against Envelope-P.
    const reportFile = packagedFiles.find((f) => f.name === 'generator_report.json');
    let reportStatus = null;
    let visualQuality = null;
    try {
      const report = JSON.parse(await fs.readFile(reportFile.path, 'utf8'));
      reportStatus = report.status_code ?? report.status ?? null;
      visualQuality = report?.checks?.visual_quality ?? null;
    } catch (err) {
      return fail(70, `visual-review envelope: generator_report.json is unreadable (${err.message})`);
    }
    if (visualQuality !== true) {
      return fail(70, `visual-review envelope: generator_report.json does not record checks.visual_quality === true (got ${JSON.stringify(visualQuality)})`);
    }
    if (reportStatus != null && Number(reportStatus) !== this.config.successCode) {
      return fail(70, `visual-review envelope: generator_report.json status ${reportStatus} is not the success code`);
    }
    const manifestFile = packagedFiles.find((f) => f.name === 'manifest.json');
    let schemaOk = true;
    try {
      const manifest = JSON.parse(await fs.readFile(manifestFile.path, 'utf8'));
      const version = manifest.visual_review_schema_version;
      if (version != null && version !== VISUAL_REVIEW_SCHEMA_VERSION) schemaOk = false;
    } catch {
      // A manifest we cannot parse is a packaging defect.
      return fail(70, 'visual-review envelope: manifest.json is unreadable');
    }
    if (!schemaOk) {
      return fail(70, `visual-review envelope: manifest visual_review_schema_version != ${VISUAL_REVIEW_SCHEMA_VERSION}`);
    }

    const envelope = {
      schema_version: VISUAL_REVIEW_SCHEMA_VERSION,
      builder: 'workflow-orchestrator',
      run_id: state.ctx.runId,
      reviewer_roles: ['qa_auditor'],
      writer_roles: [...WRITER_ROLES],
      status: 'passed',
      gates: Object.fromEntries(ENVELOPE_QA_GATES.map((g) => [g, byGate.get(g).status])),
      edge_decisions: (byGate.get('edge').edge_decisions || []).slice(),
      reviewed_artifacts: state.reviews.flatMap((r) => r.artifacts),
      package_artifacts: packageArtifacts,
      report_status: reportStatus,
      issues: []
    };
    return { envelope };
  }

  // Serialize the validated envelope into the human-readable evidence block the isolated
  // release/final auditors read. Reviewer-sourced (fixes the earlier writer-scrape). Missing
  // envelope yields an explicit failure note so the auditor rejects rather than assumes.
  _serializeEnvelope(envelope) {
    if (!envelope) {
      return '(NO VALIDATED VISUAL-REVIEW ENVELOPE — the orchestrator did not certify an independent ' +
        'review. Reject release: do not approve without a current, hash-bound, independent review.)';
    }
    const lines = [];
    lines.push('===== ORCHESTRATOR-VERIFIED PACKAGE HASHES (independently computed) =====');
    for (const a of envelope.package_artifacts) lines.push(`${a.path}  sha256=${a.sha256}`);
    lines.push(`generator_report.json status: ${envelope.report_status}`);
    lines.push('');
    lines.push('===== INDEPENDENT REVIEW COVERAGE (reviewer: ' + envelope.reviewer_roles.join(', ') + ') =====');
    for (const [gate, status] of Object.entries(envelope.gates)) lines.push(`${gate}: ${status}`);
    lines.push('');
    lines.push(`===== 17 PER-EDGE DECISIONS (from the independent QA edge review) =====`);
    for (const d of envelope.edge_decisions) {
      lines.push(`case ${d.case} ${d.name || ''}: ${d.status}${d.code != null ? ` (code ${d.code})` : ''}`);
    }
    lines.push('');
    lines.push('===== MODEL-CLAIMED REVIEWED ARTIFACTS (hashes claimed by the model, not independently verified) =====');
    for (const a of envelope.reviewed_artifacts) lines.push(`${a.path}  sha256=${a.sha256} [${a.source}]`);
    return lines.join('\n');
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
    const started = Date.now();
    const label = `${step.role}${step.mode ? '/' + step.mode : ''}`;
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
      const edgeNote = step.mode === 'edge'
        ? ' Include an `edge_decisions` array with exactly 17 objects {case,name,status}, one per edge ' +
          'case 1-17 (cases 16 and 17 are expected_failure).'
        : '';
      const reask = await controller.followUp({
        text: 'Your previous reply did not end with a valid shared-handoff JSON block. ' +
          `Validation error: ${validationError}. ` +
          `Reply again with ONLY the required fenced \`\`\`json handoff object. Required identity: ` +
          `run_id=${ctx.runId}, role=${step.role}, mode=${step.mode ?? 'null'}. ` +
          'Include an artifacts array and a valid SHA-256 for every listed artifact.' + edgeNote,
        timeoutMs: sendOpts.timeoutMs,
        responseState
      });
      text = String(reask?.text || '');
      transcript.push({ role: step.role, mode: step.mode, text, reask: true });
      handoff = parseHandoff(text, expected);
      validationError = handoff ? handoffValidationError(handoff, step, ctx.runId) : 'handoff JSON not found';
      if (validationError) handoff = null;
    }
    // Always-on, human-readable turn outcome (independent of the debug-only response-gate lines).
    const dur = humanizeDuration(Date.now() - started);
    if (handoff) {
      this.log(`  ✓ ${label} — ${text.length} chars in ${dur} (${handoff.stage_status})`);
    } else {
      this.log(`  ✗ ${label} — no valid handoff in ${dur} (${text.length} chars)`);
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
      // Clamp reruns to QA stages at or before the current gate in pipeline order. Earlier gates
      // have no downstream artifacts yet (implementation, edge, and regression run only after the
      // background gate), so re-auditing a later stage during an early gate's repair merely audits
      // files that do not exist — fabricating fresh failures that prevent the gate from ever
      // converging. RERUN_MAP's downstream entries are meant for late repairs, where those stages
      // already exist and this clamp is a no-op.
      const inScope = clampRerunsToGate(rerunModes, gate);
      const dropped = rerunModes.filter((m) => !inScope.includes(m));
      // Always re-run at least the failing gate's own mode if it is a QA mode.
      const modes = inScope.length ? inScope : (QA_MODES.includes(gate) ? [gate] : []);
      this.log(`    reruns: ${modes.join(', ') || '(none)'}${dropped.length ? ` (deferred downstream: ${dropped.join(', ')})` : ''}`);

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
        if (qaTurn.handoff.stage_status === 'passed') this._recordReview(state, qaStep, qaTurn.handoff, round);
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
        if (qaTurn.handoff.stage_status === 'passed') {
          this._recordReview(state, { role: 'qa_auditor', mode: gate, gate }, qaTurn.handoff, round);
        }
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

  // Mechanical base-generator identity gate (replaces the LLM preflight audit). The base
  // generator is a fixed, known-good, single file the orchestrator attaches itself; verifying its
  // byte hash is a deterministic, instant substitute for a model re-reading and re-validating it
  // every run. Always logs the computed hash; enforces equality only when a pin is configured.
  async _checkGeneratorIdentity(baseGenerator) {
    let sha;
    try {
      sha = await sha256File(baseGenerator);
    } catch (err) {
      return { ok: false, reason: `base generator unreadable: ${err?.message || err}` };
    }
    this.log(`base generator sha256=${sha}`);
    const expected = String(this.config.expectedGeneratorSha256 || '').trim().toLowerCase();
    if (expected && expected !== sha) {
      return { ok: false, sha, reason: `hash mismatch (expected ${expected.slice(0, 12)}…, got ${sha.slice(0, 12)}…)` };
    }
    return { ok: true, sha };
  }

  // Drive the whole workflow for one PDF.
  //
  // makeAuditController (optional): an async factory returning { controller, close }. When
  // provided, the release + final audits run in that FRESH, isolated session — a chat that
  // never saw the writer's reasoning or sandbox — so the status-0 decision is genuinely
  // independent. When omitted, every step runs on the single `controller` (legacy behavior).
  async run({ pdf, baseGenerator, outDir, controller, timeoutMs, newChat = true, runId = 'RUN-0001', makeAuditController = null }) {
    const perTurnTimeoutMs = timeoutMs || this.config.perTurnTimeoutMs;
    const transcript = [];
    const state = {
      issues: new IssueLog(),
      // Structured record of each passing QA review (one per gate, latest wins), used to build the
      // visual-review envelope. Populated by _recordReview at every passing audit site.
      reviews: [],
      envelope: null,
      ctx: { runId, pdfName: path.basename(pdf) }
    };
    const attachments = [pdf, baseGenerator];
    const gatesPassed = [];

    // Base-generator identity gate — the mechanical replacement for the removed LLM preflight
    // audit. The base generator is a fixed, known-good artifact the orchestrator itself attaches,
    // so its soundness is asserted by byte identity rather than re-validated by a model every run.
    // The hash is always logged (auditable run record); a configured pin fails fast on mismatch.
    const identity = await this._checkGeneratorIdentity(baseGenerator);
    if (!identity.ok) {
      this.log(`  ✗ base generator identity check failed (${identity.reason}) → status 20`);
      return {
        runId, statusCode: 20, success: false, failedStage: 'generator_identity',
        gatesPassed: [], issues: [], reviews: [], envelope: null, files: [], transcript
      };
    }

    let statusCode = null;
    let failedStage = null;
    let packagedFiles = [];
    let packageProduced = false;
    // The isolated audit session is opened lazily at the release step and closed in the
    // finally below, so no extra tab opens for runs that fail before release.
    let auditSession = null;
    let auditController = null;

    try {
    for (let i = 0; i < PLAN.length; i++) {
      const step = PLAN[i];
      const isFreshAudit = !!makeAuditController &&
        ((step.role === 'contract_auditor' && step.mode === 'release') || step.role === 'final_auditor');

      let turnController = controller;
      let ctx = { ...state.ctx, gate: step.gate };
      let sendOpts = { first: i === 0, attachments, timeoutMs: perTurnTimeoutMs, newChat };

      if (isFreshAudit) {
        if (!auditController) {
          auditSession = await makeAuditController();
          auditController = auditSession.controller;
        }
        turnController = auditController;
        const releaseStep = step.role === 'contract_auditor';

        // Deliver the release evidence: paste inline when short (sharper attention), else
        // write one file and attach it so the prompt body stays small.
        const auditAttachments = [pdf, ...packagedFiles.map((f) => f.path)];
        const evidence = this._serializeEnvelope(state.envelope);
        const budget = Number(this.config.auditEvidenceInlineMax) || 0;
        let extra;
        if (evidence.length <= budget) {
          extra = 'Release-decision evidence (the maker chat is NOT visible to you):\n\n' + evidence;
          this.log(`  · audit evidence pasted inline (${evidence.length} chars)`);
        } else {
          const evidencePath = path.join(outDir, `${runId}.audit_evidence.md`);
          await fs.mkdir(outDir, { recursive: true }).catch(() => {});
          await fs.writeFile(evidencePath, evidence);
          if (releaseStep) auditAttachments.push(evidencePath);
          extra =
            'Release-decision evidence is in the attached file audit_evidence.md (the maker chat is ' +
            'NOT visible to you). Read it in full before deciding.';
          this.log(`  · audit evidence attached as file (${evidence.length} chars > inline budget ${budget})`);
        }

        ctx = {
          ...state.ctx,
          gate: step.gate,
          // The isolated auditor never saw the fixed-but-unverified issue IDs in chat, and
          // blockingForRelease() counts any critical/major issue that is not verified. Pass
          // them so it can verify each against the attached artifacts.
          assignedIssues: state.issues.snapshot().filter((issue) => issue.status !== 'verified'),
          inputsNote:
            'This is a FRESH, isolated review chat. You have NO prior context, conversation history, ' +
            `or working sandbox from the document generation. Attached: the target scanned PDF ` +
            `(${state.ctx.pdfName}) and the final package files generator.py, manifest.json, and ` +
            'generator_report.json. Save generator.py and independently compile, import, and run it — ' +
            'do not trust report claims. Release evidence follows below or in an attached file.',
          extra
        };
        sendOpts = {
          first: releaseStep, // release opens the fresh chat (query + attachments); final follows up
          attachments: releaseStep ? auditAttachments : [],
          timeoutMs: perTurnTimeoutMs,
          newChat: false // the tab is already a fresh temporary chat; a "New chat" click would destroy it
        };
      }

      this.log(`▶ ${step.role}${step.mode ? '/' + step.mode : ''}${step.gate ? ` [gate: ${step.gate}]` : ''}${isFreshAudit ? ' [isolated audit session]' : ''}`);
      const turn = await this._turn(turnController, step, ctx, sendOpts, transcript);

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

        // Build and validate the visual-review envelope now that the QA reviews and the packaged
        // files both exist, and before the release decision consumes it. Fail closed if incomplete.
        const built = await this._buildAndValidateEnvelope(state, packagedFiles, outDir);
        if (built.error) {
          failedStage = 'release';
          statusCode = built.error.code;
          this.log(`  ✗ ${built.error.message} → status ${statusCode}`);
          break;
        }
        state.envelope = built.envelope;
        this.log(`  ✓ visual-review envelope built (6 gates, ${state.envelope.edge_decisions.length} edge decisions, ${state.envelope.package_artifacts.length} verified package hashes)`);
      }

      if (step.kind === 'audit' && step.gate) {
        if (turn.handoff.stage_status === 'passed' && state.issues.blockingForRelease().length === 0) {
          gatesPassed.push(step.gate);
          if (QA_MODES.includes(step.gate)) this._recordReview(state, step, turn.handoff, 0);
          this.log(`  ✓ "${step.gate}" gate passed`);
          if (step.gate === 'final') {
            const rec = Number(turn.handoff.recommended_status_code);
            statusCode = Number.isFinite(rec) ? rec : this.config.successCode;
          }
          continue;
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
    } finally {
      // Always close the isolated audit tab, on pass, reject, or throw.
      if (auditSession) await auditSession.close().catch(() => {});
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
      reviews: state.reviews,
      envelope: state.envelope,
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
