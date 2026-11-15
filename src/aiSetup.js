// Discovers every AI / Copilot customization that applies to the open workspace:
// custom agents, skills, instruction files, prompt files, AGENTS.md & co, MCP
// servers and AI-related settings — both in the project and in your personal
// (user-level) folders.

const vscode = require('vscode');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXCLUDE = '**/{node_modules,.git,target,build,dist,out,bin,obj,.venv,venv,__pycache__}/**';

// ---------------------------------------------------------------- small parsers

const MAX_TEXT_BYTES = 1024 * 1024; // customization files are small; never read huge files

function readText(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_TEXT_BYTES) return '';
    return fs.readFileSync(file, 'utf8');
  } catch { return ''; }
}

/** Minimal YAML front-matter reader: key: value, key: [a, b], key: 'x'. */
function frontMatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  let lastKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) {
      lastKey = kv[1];
      let v = kv[2].trim();
      if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      else v = v.replace(/^['"]|['"]$/g, '');
      out[lastKey] = v;
    } else if (lastKey && /^\s*-\s+/.test(line)) {
      // YAML list item under the last key
      if (!Array.isArray(out[lastKey])) out[lastKey] = out[lastKey] ? [out[lastKey]] : [];
      out[lastKey].push(line.replace(/^\s*-\s+/, '').trim().replace(/^['"]|['"]$/g, ''));
    }
  }
  return out;
}

function firstHeading(text) {
  const body = text.replace(/^﻿?---[\s\S]*?\n---/, '');
  const h = /^#\s+(.+)$/m.exec(body);
  if (h) return h[1].trim();
  const p = body.split(/\r?\n/).map(s => s.trim()).find(s => s && !s.startsWith('<!--'));
  return p ? p.slice(0, 140) : '';
}

/** JSON with comments and trailing commas (settings.json, mcp.json). */
function parseJsonc(text) {
  if (!text) return null;
  // Pass 1: strip comments (string-aware).
  let out = '', inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\' && n !== undefined) { out += n; i++; } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && n === '*') { i += 2; while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  // Pass 2: drop trailing commas (string-aware, so values like "a, }" are never changed).
  let clean = ''; inStr = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (inStr) {
      clean += c;
      if (c === '\\' && i + 1 < out.length) { clean += out[++i]; } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; clean += c; continue; }
    if (c === ',') {
      let j = i + 1;
      while (j < out.length && /\s/.test(out[j])) j++;
      if (out[j] === '}' || out[j] === ']') continue;
    }
    clean += c;
  }
  try { return JSON.parse(clean); } catch { return null; }
}

/** Hide secrets that people sometimes put directly in MCP args / URLs (env and headers are never read). */
function redact(text) {
  return String(text || '')
    .replace(/([?&](?:api[_-]?key|key|token|access[_-]?token|secret|password|pwd|auth)=)[^&\s]+/gi, '$1•••')
    .replace(/(--?(?:api[_-]?key|token|secret|password|pwd|auth)[=\s]+)\S+/gi, '$1•••')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g, '•••')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//•••@'); // user:pass@host
}

// ---------------------------------------------------------------- classification

function classify(file) {
  const base = path.basename(file);
  const lower = base.toLowerCase();
  const norm = file.replace(/\\/g, '/');
  if (lower === 'skill.md') return 'skill';
  if (lower.endsWith('.agent.md') || lower.endsWith('.chatmode.md')) return 'agent';
  if (lower.endsWith('.prompt.md')) return 'prompt';
  if (lower.endsWith('.instructions.md') || lower === 'copilot-instructions.md') return 'instruction';
  if (['agents.md', 'claude.md', 'gemini.md'].includes(lower)) return 'instruction';
  if (lower === 'mcp.json' && (/\/\.vscode\/mcp\.json$/.test(norm) || /\/User\/mcp\.json$/.test(norm))) return 'mcp';
  return null;
}

function nameOf(kind, file) {
  const base = path.basename(file);
  if (kind === 'skill') return path.basename(path.dirname(file));
  return base.replace(/\.(agent|chatmode|prompt|instructions)\.md$/i, '').replace(/\.md$/i, '');
}

function describe(kind, file, scope, root) {
  const text = readText(file);
  const fm = frontMatter(text);
  const item = {
    kind,
    scope, // 'project' | 'personal'
    name: fm.name || nameOf(kind, file),
    fileName: path.basename(file),
    file,
    rel: root ? path.relative(root, file).replace(/\\/g, '/') : file,
    description: fm.description || firstHeading(text),
    applyTo: fm.applyTo || null,
    model: fm.model || null,
    tools: Array.isArray(fm.tools) ? fm.tools : (fm.tools ? [fm.tools] : []),
    agent: fm.agent || fm.mode || null,
    size: text.length
  };
  // Lower-case names under which chat history may reference this item
  item.keys = [...new Set([item.name, nameOf(kind, file)].filter(Boolean).map(s => String(s).toLowerCase()))];
  const lower = item.fileName.toLowerCase();
  if (lower === 'copilot-instructions.md') { item.name = 'copilot-instructions'; item.applyTo = item.applyTo || 'every chat request'; }
  if (lower === 'agents.md') item.applyTo = item.applyTo || (path.dirname(item.rel) === '.' ? 'whole repo (agent mode)' : `${path.dirname(item.rel)}/** (agent mode)`);
  if (['claude.md', 'gemini.md'].includes(lower)) item.applyTo = item.applyTo || 'when enabled in settings';
  if (kind === 'mcp') {
    const json = parseJsonc(text) || {};
    const servers = json.servers || json.mcpServers || {};
    item.servers = Object.entries(servers)
      .filter(([, s]) => s && typeof s === 'object')
      .map(([n, s]) => ({
        name: n,
        type: String(s.type || (s.url ? 'http' : 'stdio')),
        target: redact(typeof s.url === 'string' ? s.url
          : [s.command, ...(Array.isArray(s.args) ? s.args : [])].filter(x => typeof x === 'string').join(' '))
      }));
    item.name = scope === 'personal' ? 'User mcp.json' : '.vscode/mcp.json';
    item.description = `${item.servers.length} server(s)`;
  }
  return item;
}

// ---------------------------------------------------------------- locations

function listDir(dir, filter, recurse = 0) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && recurse > 0) out.push(...listDir(p, filter, recurse - 1));
    else if (e.isFile() && filter(e.name)) out.push(p);
  }
  return out;
}

function settingLocations(key, root) {
  // chat.promptFilesLocations / chat.instructionsFilesLocations / chat.agentFilesLocations ...
  // In an untrusted workspace, a cloned repo's .vscode/settings.json could point these at any
  // folder on disk, so only the user-level value is honoured there.
  const cfg = vscode.workspace.getConfiguration();
  const val = vscode.workspace.isTrusted ? cfg.get(key) : (cfg.inspect(key) || {}).globalValue;
  if (!val || typeof val !== 'object') return [];
  return Object.entries(val).filter(([, on]) => on).map(([p]) => {
    p = p.replace(/^~(?=$|[\\/])/, os.homedir());
    return path.isAbsolute(p) ? p : (root ? path.join(root, p) : null);
  }).filter(Boolean);
}

function personalFiles(userDir) {
  const home = os.homedir();
  const files = [];
  // VS Code user prompts folder holds personal prompt / instruction / agent files
  files.push(...listDir(path.join(userDir, 'prompts'), n => /\.(prompt|instructions|agent|chatmode)\.md$/i.test(n), 1));
  files.push(path.join(userDir, 'mcp.json'));
  // Personal skills folders (only listed if they exist)
  for (const d of [path.join(home, '.copilot', 'skills'), path.join(home, '.claude', 'skills')]) {
    files.push(...listDir(d, n => n.toLowerCase() === 'skill.md', 2));
  }
  return files.filter(f => fs.existsSync(f));
}

function aiSettings(root) {
  const json = parseJsonc(readText(path.join(root, '.vscode', 'settings.json'))) || {};
  return Object.entries(json)
    .filter(([k]) => /^(github\.copilot|chat\.|mcp|inlineChat|accessibility\.signals\.chat)/i.test(k))
    .map(([k, v]) => ({ key: k, value: typeof v === 'object' ? JSON.stringify(v) : String(v) }));
}

async function availableModels() {
  try {
    if (!vscode.lm || !vscode.lm.selectChatModels) return [];
    const models = await vscode.lm.selectChatModels({ vendor: 'copilot' });
    const seen = new Set();
    return models.map(m => ({ id: m.id, name: m.name, family: m.family, maxInput: m.maxInputTokens }))
      .filter(m => !seen.has(m.id) && seen.add(m.id));
  } catch { return []; }
}

// ---------------------------------------------------------------- main

async function scanWorkspaceSetup(userDir) {
  const folders = vscode.workspace.workspaceFolders || [];
  const items = [];
  const settings = [];
  const seen = new Set();
  const add = (file, scope, root) => {
    const key = path.resolve(file).toLowerCase();
    if (seen.has(key)) return;
    const kind = classify(file);
    if (!kind) return;
    seen.add(key);
    items.push(describe(kind, file, scope, root));
  };

  for (const folder of folders) {
    const root = folder.uri.fsPath;
    const pattern = new vscode.RelativePattern(folder,
      '**/{SKILL.md,*.agent.md,*.chatmode.md,*.prompt.md,*.instructions.md,copilot-instructions.md,AGENTS.md,CLAUDE.md,GEMINI.md,.vscode/mcp.json}');
    let uris = [];
    try { uris = await vscode.workspace.findFiles(pattern, EXCLUDE, 500); } catch { /* ignore */ }
    for (const u of uris) add(u.fsPath, 'project', root);

    // Extra folders configured in settings
    for (const key of ['chat.promptFilesLocations', 'chat.instructionsFilesLocations', 'chat.agentFilesLocations', 'chat.modeFilesLocations', 'chat.agentSkillsLocations']) {
      for (const dir of settingLocations(key, root)) {
        for (const f of listDir(dir, n => /\.md$/i.test(n), 2)) add(f, dir.startsWith(root) ? 'project' : 'personal', root);
      }
    }
    for (const s of aiSettings(root)) settings.push({ ...s, folder: folder.name });
  }
  for (const f of personalFiles(userDir)) add(f, 'personal', null);

  items.sort((a, b) => a.kind.localeCompare(b.kind) || a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
  return {
    folders: folders.map(f => ({ name: f.name, path: f.uri.fsPath })),
    workspaceName: vscode.workspace.name || null,
    items,
    settings,
    models: await availableModels()
  };
}

module.exports = { scanWorkspaceSetup, frontMatter, parseJsonc, classify, redact };
