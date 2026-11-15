// Parses the Copilot Chat session files VS Code keeps on disk and turns every
// prompt into a small flat record the dashboard can aggregate.
//
// VS Code's on-disk chat format is internal and changes between releases, so
// every field is looked up defensively with several fallbacks.

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------- file discovery

function findSessionFiles(userDirs) {
  const out = [];
  const visit = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'chatEditingSessions') continue;
        if (e.name === 'chatSessions') {
          let files = [];
          try { files = fs.readdirSync(p); } catch { /* ignore */ }
          for (const f of files) if (f.endsWith('.json') || f.endsWith('.jsonl')) out.push(path.join(p, f));
        } else if (depth < 3) {
          visit(p, depth + 1);
        }
      }
    }
  };
  for (const d of userDirs) {
    visit(path.join(d, 'workspaceStorage'), 0);
    visit(path.join(d, 'globalStorage'), 0);
  }
  return [...new Set(out)];
}

function workspaceOf(sessionFile) {
  const wsDir = path.dirname(path.dirname(sessionFile));
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(wsDir, 'workspace.json'), 'utf8'));
    const uri = meta.folder || meta.workspace || '';
    const decoded = decodeURIComponent(uri.replace(/\/+$/, ''));
    const name = decoded.split('/').pop().replace(/\.code-workspace$/, '');
    return { name: name || '(unknown)', path: decoded };
  } catch {
    if (sessionFile.includes('globalStorage') || sessionFile.includes('emptyWindow')) {
      return { name: '(no folder open)', path: '' };
    }
    return { name: '(unknown)', path: '' };
  }
}

// ---------------------------------------------------------------- loading

// Keys that would reach Object.prototype if used in a property path (prototype pollution).
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_SESSION_BYTES = 200 * 1024 * 1024; // skip absurdly large files instead of freezing VS Code

function checkKeys(keys) {
  if (!Array.isArray(keys)) throw new Error('bad path');
  for (const k of keys) {
    if (typeof k !== 'string' && typeof k !== 'number') throw new Error('bad key');
    if (FORBIDDEN_KEYS.has(String(k))) throw new Error('forbidden key');
  }
}
function getPath(obj, keys) {
  checkKeys(keys);
  return keys.reduce((o, k) => {
    if (o === null || typeof o !== 'object' || !Object.prototype.hasOwnProperty.call(o, k)) throw new Error('missing path');
    return o[k];
  }, obj);
}
function setPath(obj, keys, v) {
  checkKeys(keys);
  if (!keys.length) throw new Error('empty path');
  const parent = getPath(obj, keys.slice(0, -1));
  if (parent === null || typeof parent !== 'object') throw new Error('bad parent');
  parent[keys[keys.length - 1]] = v;
}

function findRequestLike(obj, out = []) {
  if (Array.isArray(obj)) obj.forEach(v => findRequestLike(v, out));
  else if (obj && typeof obj === 'object') {
    if ('message' in obj && ('response' in obj || 'requestId' in obj)) out.push(obj);
    else Object.values(obj).forEach(v => findRequestLike(v, out));
  }
  return out;
}

function loadSession(file) {
  if (fs.statSync(file).size > MAX_SESSION_BYTES) throw new Error('session file too large');
  const text = fs.readFileSync(file, 'utf8');
  if (file.endsWith('.json')) return JSON.parse(text);

  // .jsonl = mutation log: {kind:0,v} initial state, {kind:1,k,v} set,
  // {kind:2,k,v,i?} array push/splice, {kind:3,k} delete.
  const lines = text.split(/\r?\n/).filter(l => l.trim()).map(l => JSON.parse(l));
  try {
    let state = null;
    for (const e of lines) {
      if (e.kind === 0) { if (!e.v || typeof e.v !== "object" || Array.isArray(e.v)) throw new Error("bad state"); state = e.v; }
      else if (e.kind === 1) setPath(state, e.k, e.v);
      else if (e.kind === 2) {
        const arr = getPath(state, e.k);
        const items = Array.isArray(e.v) ? e.v : [];
        if (!Array.isArray(arr)) throw new Error('not an array');
        if (Number.isInteger(e.i) && e.i >= 0) arr.length = Math.min(arr.length, e.i);
        for (const it of items) arr.push(it); // loop, not spread: no stack overflow on huge arrays
      } else if (e.kind === 3) {
        checkKeys(e.k);
        const parent = getPath(state, e.k.slice(0, -1));
        if (parent && typeof parent === 'object') delete parent[e.k[e.k.length - 1]];
      }
    }
    if (state && typeof state === 'object') return state;
  } catch { /* fall through */ }
  return { requests: findRequestLike(lines) };
}

// ---------------------------------------------------------------- field extraction

function* walk(o) {
  if (Array.isArray(o)) { for (const v of o) yield* walk(v); }
  else if (o && typeof o === 'object') { yield o; for (const v of Object.values(o)) yield* walk(v); }
}

function promptText(req) {
  const m = req.message;
  if (typeof m === 'string') return m;
  if (m && typeof m === 'object') {
    if (typeof m.text === 'string') return m.text;
    if (Array.isArray(m.parts)) return m.parts.map(p => (p && p.text) || '').join(' ');
  }
  return '';
}

const MODEL_KEYS = ['modelId', 'model', 'selectedModel', 'languageModelId'];
const cleanModel = s => (s || '').trim().replace(/^(copilot|github\.copilot[-\w]*)\//, '') || '(unknown)';

function modelOf(req) {
  for (const k of MODEL_KEYS) {
    const v = req[k];
    if (typeof v === 'string' && v) return cleanModel(v);
    if (v && typeof v === 'object') {
      for (const kk of ['id', 'identifier', 'name', 'family']) if (typeof v[kk] === 'string') return cleanModel(v[kk]);
    }
  }
  const res = req.result || {};
  const meta = res.metadata || {};
  for (const k of MODEL_KEYS) if (typeof meta[k] === 'string') return cleanModel(meta[k]);
  if (typeof res.details === 'string' && res.details.trim()) return cleanModel(res.details.split('•')[0]);
  return '(unknown)';
}

const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function modeOf(req, session) {
  for (const src of [req, session]) {
    const mi = src.modeInfo || src.mode || src.chatMode;
    if (mi && typeof mi === 'object') {
      for (const k of ['modeName', 'name', 'kind', 'modeId', 'id']) if (typeof mi[k] === 'string') return cap(mi[k]);
    } else if (typeof mi === 'string' && mi) return cap(mi);
  }
  if (['editsAgent', 'editingSession'].includes(session.initialLocation)) return 'Edit/Agent';
  return 'Ask';
}

function agentOf(req) {
  const a = req.agent;
  if (!a || typeof a !== 'object') return 'Copilot (default)';
  const id = a.id || '';
  const name = a.name || a.fullName || id;
  if (!id || id === 'github.copilot.default' || name === 'GitHubCopilot') return 'Copilot (default)';
  if (/edits?agent|editingSession/i.test(id)) return 'Copilot Agent/Edits';
  return name.startsWith('@') ? name : '@' + name;
}

// File references (skills, prompt files, agents, instructions) are found with a linear scan
// instead of regular expressions: the old regexes backtracked quadratically on long agent
// responses and could freeze the extension host (ReDoS).
const SEP = new Set(['/', '\\', '"', "'", ' ', '\n', '(', '[', '`', '<', '>']);
const MAX_NAME = 200;
const asciiLower = s => s.replace(/[A-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + 32)); // keeps length

/** For every occurrence of `suffix`, return the path segment that ends right before it. */
function namesBefore(blob, lower, suffix, { requireSep = false } = {}) {
  const out = new Set();
  for (let i = lower.indexOf(suffix); i !== -1; i = lower.indexOf(suffix, i + suffix.length)) {
    let end = i;
    while (end > 0 && blob[end - 1] === '\\') end--; // JSON escapes a Windows "\" as "\\"
    let j = end;
    while (j > 0 && end - j < MAX_NAME && !SEP.has(blob[j - 1])) j--;
    // exact file names (AGENTS.md): the character right before must be a path separator
    if (requireSep && !(end === 0 || end !== i || SEP.has(blob[end - 1]))) continue;
    const name = blob.slice(j, end);
    if (name || requireSep) out.add(name);
  }
  return out;
}

function fileRefs(blob) {
  const lower = asciiLower(blob);
  const skills = new Set([...namesBefore(blob, lower, '/skill.md'), ...namesBefore(blob, lower, '\\skill.md')]);
  // for skills the segment before "/SKILL.md" is the folder: take the last path component
  const skillNames = [...skills].map(n => n.split(/[\\/]/).filter(Boolean).pop()).filter(Boolean);
  const prompts = namesBefore(blob, lower, '.prompt.md');
  const agents = new Set([...namesBefore(blob, lower, '.agent.md'), ...namesBefore(blob, lower, '.chatmode.md')]);
  const instr = namesBefore(blob, lower, '.instructions.md');
  for (const fixed of ['copilot-instructions.md', 'agents.md']) {
    const hits = namesBefore(blob, lower, fixed, { requireSep: true });
    if (hits.size) instr.add(fixed === 'agents.md' ? 'AGENTS' : 'copilot-instructions');
  }
  return {
    skills: [...new Set(skillNames)],
    promptFiles: [...prompts].filter(Boolean),
    agentFiles: [...agents].filter(Boolean),
    instructionFiles: [...instr].filter(Boolean)
  };
}

function extras(req) {
  const tools = [];
  for (const d of walk(req.response || [])) {
    if (d.kind === 'toolInvocationSerialized' || d.kind === 'toolInvocation' || 'toolId' in d) {
      const t = d.toolId || d.toolName;
      if (typeof t === 'string') tools.push(t);
    }
  }
  const blob = JSON.stringify(req);
  let slash = null;
  if (req.slashCommand && req.slashCommand.name) slash = '/' + req.slashCommand.name;
  else {
    const m = /^\s*\/([\w.-]+)/.exec(promptText(req));
    if (m) slash = '/' + m[1];
  }
  return { tools, ...fileRefs(blob), slash };
}

function timeOf(req, session) {
  for (const v of [req.timestamp, session.creationDate, session.lastMessageDate]) {
    if (typeof v === 'number' && v > 0) return v > 1e11 ? v : v * 1000;
    if (typeof v === 'string') { const t = Date.parse(v); if (!isNaN(t)) return t; }
  }
  return null;
}

// ---------------------------------------------------------------- prompt types (EN + RO keywords)

const CATEGORIES = [
  ['Debug / fix', /\b(fix|bug|error|exception|crash|fail\w*|broken|not working|doesn'?t work|stack ?trace|nu merge|eroare|gresit|greșit|repar[aă])\b/i],
  ['Explain / learn', /\b(explain|what is|what does|why|how does|meaning|understand|explic[aă]|ce (este|face|inseamn[aă]|înseamnă)|de ce|cum func[tț]ioneaz[aă])\b/i],
  ['Tests', /\b(tests?|unit test|pytest|junit|mock|coverage|teste)\b/i],
  ['Refactor / improve', /\b(refactor|clean ?up|simplify|optimi[sz]e|improve|rename|restructure|performance|optimizeaz[aă]|îmbunătățește|imbunatateste)\b/i],
  ['Review', /\b(review|check (this|my)|is this (correct|right|ok)|verific[aă])\b/i],
  ['Docs / comments', /\b(document\w*|docstring|comment\w*|readme|jsdoc|javadoc|comentari\w*)\b/i],
  ['Generate / implement', /\b(create|write|generate|implement|add|build|make|scaffold|creeaz[aă]|scrie|genereaz[aă]|implementeaz[aă]|adaug[aă])\b/i],
  ['Shell / config / git', /\b(git|docker|npm|pip|install|config\w*|yaml|deploy|terminal|command|powershell|bash)\b/i]
];

function classify(text) {
  for (const [name, re] of CATEGORIES) if (re.test(text)) return name;
  return 'Other / chat';
}

// ---------------------------------------------------------------- main entry

const cache = new Map(); // file -> { mtimeMs, records }

function parseFile(file) {
  let st;
  try { st = fs.statSync(file); } catch { return []; }
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs) return hit.records;

  let records = [];
  try {
    const session = loadSession(file);
    const ws = workspaceOf(file);
    const reqs = Array.isArray(session.requests) ? session.requests : [];
    for (const req of reqs) {
      if (!req || typeof req !== 'object') continue;
      const text = promptText(req);
      const ex = extras(req);
      records.push({
        t: timeOf(req, session) ?? st.mtimeMs,
        ws: ws.name,
        wsPath: ws.path,
        model: modelOf(req),
        mode: modeOf(req, session),
        agent: agentOf(req),
        ptype: classify(text),
        words: text.split(/\s+/).filter(Boolean).length,
        session: session.sessionId || file,
        ...ex
      });
    }
  } catch {
    records = [];
  }
  cache.set(file, { mtimeMs: st.mtimeMs, records });
  return records;
}

function scanChat(userDirs) {
  const files = findSessionFiles(userDirs);
  const records = [];
  for (const f of files) records.push(...parseFile(f));
  return { files: files.length, records };
}

module.exports = { scanChat, findSessionFiles, loadSession, classify, workspaceOf };
