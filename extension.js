const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const { scanChat } = require('./src/parser');
const { InlineTracker } = require('./src/inlineTracker');
const { scanWorkspaceSetup } = require('./src/aiSetup');

let panel = null;
let tracker = null;
let statusItem = null;
let ctx = null;

// ---------------------------------------------------------------- helpers

function userDirs() {
  // globalStorageUri = <User>/globalStorage/<publisher.name>  ->  <User>
  const own = path.dirname(path.dirname(ctx.globalStorageUri.fsPath));
  const extraRaw = vscode.workspace.getConfiguration('copilotUsage').get('extraChatFolders', []);
  const extra = Array.isArray(extraRaw) ? extraRaw.filter(x => typeof x === 'string' && path.isAbsolute(x)) : [];
  return [own, ...extra];
}

/**
 * Case-insensitive wildcard matcher (* and ?). Implemented without RegExp so a pattern like
 * "*a*a*a*a*b" can never cause catastrophic backtracking (ReDoS). Linear-time two-pointer algorithm.
 * Returns an object with .test(str) so it is a drop-in replacement for the old regex.
 */
function globToRegex(glob) {
  const p = String(glob).toLowerCase();
  return {
    test(input) {
      const s = String(input || '').toLowerCase();
      let i = 0, j = 0, star = -1, mark = 0;
      while (i < s.length) {
        if (j < p.length && (p[j] === '?' || p[j] === s[i])) { i++; j++; }
        else if (j < p.length && p[j] === '*') { star = j++; mark = i; }
        else if (star !== -1) { j = star + 1; i = ++mark; }
        else return false;
      }
      while (j < p.length && p[j] === '*') j++;
      return j === p.length;
    }
  };
}

function projectResolver() {
  const compiled = Object.entries(getGroups()).map(([name, pats]) => [name, pats.map(globToRegex)]);
  return (ws, wsPath) => {
    for (const [name, res] of compiled) {
      if (res.some(r => r.test(ws) || (wsPath && r.test(wsPath)))) return name;
    }
    return ws || '(unknown)';
  };
}

const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } };
const normPath = p => safeDecode(String(p || ''))
  .replace(/^file:\/\//i, '').replace(/^vscode-remote:\/\/[^/]+/i, '')
  .replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// The webview may only ask to open paths this extension itself discovered.
let allowedFiles = new Set();
let allowedFolders = new Set();

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const isProjectName = (groups, name) => typeof name === 'string' && hasOwn(groups, name);

/** Returns a predicate telling whether a record belongs to the folder(s) open in this window. */
function isCurrentWorkspace() {
  const folders = vscode.workspace.workspaceFolders || [];
  const targets = folders.map(f => normPath(f.uri.fsPath));
  if (vscode.workspace.workspaceFile) targets.push(normPath(vscode.workspace.workspaceFile.fsPath));
  const names = new Set(folders.map(f => f.name.toLowerCase()));
  return (ws, wsPath) => {
    if (wsPath) {
      const p = normPath(wsPath);
      return targets.some(t => t && (p === t || p.endsWith(t) || t.endsWith(p)));
    }
    return names.has(String(ws || '').toLowerCase());
  };
}

// ---------------------------------------------------------------- project management

/** Project groups from settings, sanitised: string keys -> arrays of short strings. */
function getGroups() {
  const raw = vscode.workspace.getConfiguration('copilotUsage').get('projectGroups', {});
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [name, pats] of Object.entries(raw)) {
    if (RESERVED_NAMES.has(name)) continue;
    const list = Array.isArray(pats) ? pats : (typeof pats === 'string' ? [pats] : []);
    out[name] = list.filter(x => typeof x === 'string' && x.length > 0 && x.length <= 260);
  }
  return out;
}

async function saveGroups(groups) {
  await vscode.workspace.getConfiguration('copilotUsage')
    .update('projectGroups', groups, vscode.ConfigurationTarget.Global);
}

function knownWorkspaces() {
  // Every workspace folder seen in chat history or inline tracking, with usage counts.
  const counts = new Map();
  const { records } = scanChat(userDirs());
  for (const r of [...records, ...tracker.records()]) {
    if (!r.ws) continue;
    counts.set(r.ws, (counts.get(r.ws) || 0) + 1);
  }
  for (const f of vscode.workspace.workspaceFolders || []) if (!counts.has(f.name)) counts.set(f.name, 0);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

async function editProject(preset) {
  const groups = getGroups();
  let name = preset;

  if (!name) {
    const NEW = '$(add) New project…';
    const items = [{ label: NEW }, ...Object.keys(groups).map(n => ({
      label: n, description: `${groups[n].length} folder(s)`
    }))];
    const pick = await vscode.window.showQuickPick(items, { title: 'Copilot Usage: add or edit a project' });
    if (!pick) return;
    name = pick.label;
    if (name === NEW) {
      name = (await vscode.window.showInputBox({
        title: 'New project',
        prompt: 'Project name (e.g. a client, a product, your thesis)',
        validateInput: v => {
          const t = v.trim();
          if (!t) return 'Enter a name';
          if (t.length > 80) return 'Keep the name under 80 characters';
          if (RESERVED_NAMES.has(t)) return 'This name is reserved';
          return hasOwn(groups, t) ? 'A project with this name already exists' : null;
        }
      }) || '').trim();
      if (!name) return;
    }
  }

  const current = groups[name] || [];
  const regexes = current.map(globToRegex);
  const wildcards = current.filter(p => /[*?]/.test(p));
  const owner = ws => Object.keys(groups).find(n => n !== name && groups[n].map(globToRegex).some(r => r.test(ws)));

  const CUSTOM = '$(regex) Add a name pattern…';
  const items = knownWorkspaces().map(([ws, n]) => ({
    label: ws,
    description: `${n} records`,
    detail: owner(ws) ? `currently in "${owner(ws)}" — selecting it moves it here` : undefined,
    picked: regexes.some(r => r.test(ws))
  }));
  items.push({ label: CUSTOM, alwaysShow: true });

  const picked = await vscode.window.showQuickPick(items, {
    title: `Folders that belong to "${name}"`,
    placeHolder: 'Select the workspace folders for this project',
    canPickMany: true
  });
  if (!picked) return;

  const folders = picked.filter(p => p.label !== CUSTOM).map(p => p.label);
  let patterns = [...new Set([...wildcards, ...folders])];

  if (picked.some(p => p.label === CUSTOM)) {
    const pat = await vscode.window.showInputBox({
      title: `Pattern for "${name}"`,
      prompt: 'Matches future folders too. * = anything, e.g. *sailpoint* or client-*',
      value: wildcards.join(', ')
    });
    if (pat !== undefined) {
      const typed = pat.split(',').map(s => s.trim()).filter(Boolean);
      patterns = [...new Set([...folders, ...typed])];
    }
  }

  // A folder belongs to one project: remove explicitly picked folders from other projects.
  for (const other of Object.keys(groups)) {
    if (other !== name) groups[other] = groups[other].filter(p => !folders.includes(p));
  }
  if (patterns.length === 0) {
    const del = await vscode.window.showWarningMessage(`"${name}" has no folders. Delete the project?`, 'Delete', 'Keep empty');
    if (del === 'Delete') delete groups[name]; else groups[name] = [];
  } else {
    groups[name] = patterns;
  }
  await saveGroups(groups);
  vscode.window.showInformationMessage(`Project "${name}" saved (${patterns.length} folder(s)/pattern(s)).`);
  refresh();
}

async function deleteProject(preset) {
  const groups = getGroups();
  const names = Object.keys(groups);
  if (!names.length) { vscode.window.showInformationMessage('No projects defined yet.'); return; }
  const name = preset || await vscode.window.showQuickPick(names, { title: 'Delete which project?' });
  if (!isProjectName(groups, name)) return;
  const ok = await vscode.window.showWarningMessage(
    `Delete project "${name}"? Its folders will be shown under their own names again. No usage data is deleted.`,
    { modal: true }, 'Delete');
  if (ok !== 'Delete') return;
  delete groups[name];
  await saveGroups(groups);
  refresh();
}

function collect() {
  const resolve = projectResolver();
  const { files, records } = scanChat(userDirs());
  const here = isCurrentWorkspace();
  const chat = records.map(r => ({ ...r, project: resolve(r.ws, r.wsPath), here: here(r.ws, r.wsPath) }));
  const inline = tracker.records().map(r => ({ ...r, project: resolve(r.ws, r.wsPath), here: here(r.ws, r.wsPath) }));
  return { chat, inline, meta: { files, generated: Date.now(), dirs: userDirs(), projects: Object.keys(getGroups()) } };
}

function startOfToday() {
  const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime();
}

function updateStatus(data) {
  if (!statusItem) return;
  if (!vscode.workspace.getConfiguration('copilotUsage').get('statusBar', true)) { statusItem.hide(); return; }
  const t0 = startOfToday();
  const c = data.chat.filter(r => r.t >= t0).length;
  const i = data.inline.filter(r => r.t >= t0).length;
  statusItem.text = `$(graph) ${c} chat · ${i} inline`;
  statusItem.tooltip = 'Copilot usage today — click to open the dashboard';
  statusItem.show();
}

let refreshTimer = null;
function refresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    let data;
    try { data = collect(); } catch (err) { console.error('[copilot-usage]', err); return; }
    updateStatus(data);
    allowedFolders = new Set([...data.chat, ...data.inline].map(r => r.wsPath).filter(Boolean));
    if (panel) {
      panel.webview.postMessage({ type: 'data', data });
      scanWorkspaceSetup(userDirs()[0])
        .then(setup => {
          allowedFiles = new Set(setup.items.map(i => i.file));
          if (panel) panel.webview.postMessage({ type: 'setup', setup });
        })
        .catch(err => console.error('[copilot-usage] setup scan', err));
    }
  }, 300);
}

// ---------------------------------------------------------------- webview

function openDashboard(tab) {
  const showTab = () => { if (typeof tab === 'string' && panel) panel.webview.postMessage({ type: 'tab', tab }); };
  if (panel) { panel.reveal(); showTab(); refresh(); return; }
  setTimeout(showTab, 500);
  const media = vscode.Uri.joinPath(ctx.extensionUri, 'media');
  panel = vscode.window.createWebviewPanel('copilotUsage', 'Copilot Usage', vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [media]
  });
  const w = panel.webview;
  const uri = f => w.asWebviewUri(vscode.Uri.joinPath(media, f));
  const nonce = crypto.randomBytes(16).toString('hex');
  w.html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource} data:; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri('dashboard.css')}">
<title>Copilot Usage</title></head>
<body>
<nav class="tabs">
  <button class="tab active" data-tab="usage">📊 Usage (all projects)</button>
  <button class="tab" data-tab="workspace">🧩 This workspace</button>
</nav>
<div id="tab-workspace" class="tabpane" hidden>
  <header>
    <div><h1 id="wsTitle">This workspace</h1><div id="wsSub" class="muted">Scanning…</div></div>
    <div class="controls"><button id="wsRefresh" title="Rescan">⟳</button></div>
  </header>
  <section id="wsKpis" class="kpis"></section>
  <main class="grid">
    <div class="card"><h2>Models used here</h2><div class="chart"><canvas id="wModel"></canvas></div><div id="wModelT"></div></div>
    <div class="card"><h2>Modes &amp; agents used here</h2><div class="chart"><canvas id="wMode"></canvas></div><div id="wAgentT"></div></div>
    <div class="card wide"><h2>Custom agents</h2><div id="wAgents"></div></div>
    <div class="card wide"><h2>Skills</h2><div id="wSkills"></div></div>
    <div class="card wide"><h2>Instructions</h2><div id="wInstr"></div></div>
    <div class="card wide"><h2>Prompt files</h2><div id="wPrompts"></div></div>
    <div class="card"><h2>MCP servers</h2><div id="wMcp"></div></div>
    <div class="card"><h2>AI settings (.vscode/settings.json)</h2><div id="wSettings"></div></div>
    <div class="card wide"><h2>Models available to you now</h2><div id="wAvail"></div></div>
  </main>
</div>
<div id="tab-usage" class="tabpane">
<header>
  <div><h1>Copilot Usage</h1><div id="sub" class="muted">Loading…</div></div>
  <div class="controls">
    <select id="range">
      <option value="0" selected>All time</option>
      <option value="7">Last 7 days</option>
      <option value="30">Last 30 days</option>
      <option value="90">Last 90 days</option>
    </select>
    <select id="project"><option value="">All projects</option></select>
    <button id="addProject" title="Create a project and choose its folders">+ Project</button>
    <button id="editProject" title="Edit the selected project, or pick one">Edit</button>
    <button id="deleteProject" title="Delete the selected project">Delete</button>
    <button id="refresh" title="Rescan">⟳</button>
  </div>
</header>
<div id="projectHint" class="hint" hidden>
  No projects yet — usage is grouped by folder name. <button id="hintAdd">+ Create your first project</button>
  and choose which folders belong to it.
</div>
<section id="kpis" class="kpis"></section>
<main class="grid">
  <div class="card wide"><h2>Usage per day</h2><div class="chart tall"><canvas id="cDay"></canvas></div></div>
  <div class="card"><h2>Hour of day</h2><div class="chart"><canvas id="cHour"></canvas></div></div>
  <div class="card"><h2>Chat vs inline</h2><div class="chart"><canvas id="cKind"></canvas></div></div>
  <div class="card"><h2>Projects</h2><div class="chart"><canvas id="cProject"></canvas></div><div id="tProject"></div></div>
  <div class="card"><h2>Models</h2><div class="chart"><canvas id="cModel"></canvas></div><div id="tModel"></div></div>
  <div class="card"><h2>Chat modes</h2><div class="chart"><canvas id="cMode"></canvas></div></div>
  <div class="card"><h2>Agents / @participants</h2><div class="chart"><canvas id="cAgent"></canvas></div></div>
  <div class="card"><h2>Prompt types</h2><div class="chart"><canvas id="cType"></canvas></div><div id="tType"></div></div>
  <div class="card"><h2>Skills · custom agents · prompt files</h2><div id="tCustom"></div></div>
  <div class="card"><h2>Top tools used by the agent</h2><div class="chart"><canvas id="cTool"></canvas></div></div>
  <div class="card"><h2>Inline completions by language</h2><div class="chart"><canvas id="cLang"></canvas></div></div>
  <div class="card wide">
    <div class="cardhead">
      <h2>Folders where you used Copilot <span id="folderCount" class="muted"></span></h2>
      <input id="folderSearch" type="search" placeholder="Filter folders…">
    </div>
    <div id="tFolders" class="scroll"></div>
  </div>
</main>
</div>
<footer class="muted">Inline numbers are estimated from editor insertions. Chat data is read from VS Code's local chat history. Nothing leaves your machine.</footer>
<script nonce="${nonce}" src="${uri('chart.umd.js')}"></script>
<script nonce="${nonce}" src="${uri('dashboard.js')}"></script>
</body></html>`;
  w.onDidReceiveMessage(m => {
    if (!m || typeof m !== 'object' || typeof m.type !== 'string') return;
    const groups = getGroups();
    if (m.type === 'ready' || m.type === 'refresh') refresh();
    else if (m.type === 'addProject') editProject(null);
    else if (m.type === 'editProject') editProject(isProjectName(groups, m.name) ? m.name : null);
    else if (m.type === 'deleteProject') deleteProject(isProjectName(groups, m.name) ? m.name : null);
    else if (m.type === 'openFolder') {
      // Only folders that appear in your Copilot history, and only local file:// folders.
      if (typeof m.path !== 'string' || !allowedFolders.has(m.path)) return;
      let uri;
      if (/^file:\/\//i.test(m.path)) uri = vscode.Uri.parse(m.path, true);
      else if (!/^[a-z][\w+.-]*:/i.test(m.path) || /^[a-z]:[\\/]/i.test(m.path)) uri = vscode.Uri.file(m.path);
      else return; // vscode-remote:// etc. are not opened from the dashboard
      vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true }).then(undefined, () =>
        vscode.window.showWarningMessage('Could not open that folder — it may have been moved or deleted.'));
    }
    else if (m.type === 'openFile') {
      // Only customization files found by the workspace scan.
      if (typeof m.file !== 'string' || !allowedFiles.has(m.file)) return;
      vscode.window.showTextDocument(vscode.Uri.file(m.file), { preview: true }).then(undefined, () =>
        vscode.window.showWarningMessage('Could not open that file.'));
    }
  });
  panel.onDidDispose(() => { panel = null; });
}

// ---------------------------------------------------------------- activation

function activate(context) {
  ctx = context;
  tracker = new InlineTracker(context, refresh);
  tracker.start();

  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusItem.command = 'copilotUsage.openDashboard';
  context.subscriptions.push(statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('copilotUsage.openDashboard', () => openDashboard('usage')),
    vscode.commands.registerCommand('copilotUsage.showWorkspaceSetup', () => openDashboard('workspace')),
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.commands.registerCommand('copilotUsage.refresh', refresh),
    vscode.commands.registerCommand('copilotUsage.editProject', () => editProject(null)),
    vscode.commands.registerCommand('copilotUsage.deleteProject', () => deleteProject(null)),
    vscode.commands.registerCommand('copilotUsage.exportJson', async () => {
      const target = await vscode.window.showSaveDialog({ filters: { JSON: ['json'] }, saveLabel: 'Export' });
      if (!target) return;
      await vscode.workspace.fs.writeFile(target, Buffer.from(JSON.stringify(collect(), null, 2)));
      vscode.window.showInformationMessage(`Exported to ${target.fsPath}`);
    }),
    vscode.commands.registerCommand('copilotUsage.resetInline', async () => {
      const ok = await vscode.window.showWarningMessage('Delete all recorded inline completion events?', { modal: true }, 'Delete');
      if (ok === 'Delete') { tracker.reset(); refresh(); }
    }),
    vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('copilotUsage')) refresh(); })
  );

  // Rescan when any AI customization file in the workspace changes
  const watcher = vscode.workspace.createFileSystemWatcher(
    '**/{SKILL.md,*.agent.md,*.chatmode.md,*.prompt.md,*.instructions.md,copilot-instructions.md,AGENTS.md,CLAUDE.md,GEMINI.md,mcp.json,settings.json}');
  watcher.onDidCreate(refresh); watcher.onDidChange(refresh); watcher.onDidDelete(refresh);
  context.subscriptions.push(watcher);

  const interval = setInterval(refresh, 2 * 60 * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(interval) });
  refresh();
}

function deactivate() {}

module.exports = { activate, deactivate };
