/* global Chart, acquireVsCodeApi */
(function () {
  const vscode = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const charts = {};
  let DATA = null;

  const css = getComputedStyle(document.body);
  const FG = css.getPropertyValue('--vscode-foreground').trim() || '#ccc';
  const GRID = css.getPropertyValue('--vscode-editorWidget-border').trim() || 'rgba(128,128,128,.2)';
  const PALETTE = ['#4C6EF5', '#12B886', '#FAB005', '#FA5252', '#7950F2', '#15AABF', '#FD7E14', '#82C91E', '#E64980', '#868E96'];
  const CHAT = '#4C6EF5', INLINE = '#12B886';

  Chart.defaults.color = FG;
  Chart.defaults.borderColor = GRID;
  Chart.defaults.font.family = css.getPropertyValue('--vscode-font-family') || 'system-ui';
  Chart.defaults.maintainAspectRatio = false;
  Chart.defaults.plugins.legend.labels.boxWidth = 12;

  // ------------------------------------------------------------ helpers
  const count = (arr, key) => {
    const m = new Map();
    for (const r of arr) {
      const vals = Array.isArray(key(r)) ? key(r) : [key(r)];
      for (const v of vals) if (v !== null && v !== undefined && v !== '') m.set(v, (m.get(v) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  const topN = (entries, n) => {
    if (entries.length <= n) return entries;
    const rest = entries.slice(n).reduce((s, [, v]) => s + v, 0);
    return [...entries.slice(0, n), ['Other', rest]];
  };
  const pct = (v, total) => total ? (100 * v / total).toFixed(1) + '%' : '–';
  const dayKey = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const esc = s => String(s).replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));

  function draw(id, config) {
    if (charts[id]) charts[id].destroy();
    charts[id] = new Chart($(id), config);
  }
  function doughnut(id, entries, n = 8) {
    const e = topN(entries, n);
    draw(id, {
      type: 'doughnut',
      data: { labels: e.map(x => x[0]), datasets: [{ data: e.map(x => x[1]), backgroundColor: PALETTE, borderWidth: 0 }] },
      options: { cutout: '60%', plugins: { legend: { position: 'right' } } }
    });
  }
  function hbar(id, entries, n = 10, color = PALETTE[0]) {
    const e = entries.slice(0, n);
    draw(id, {
      type: 'bar',
      data: { labels: e.map(x => x[0]), datasets: [{ data: e.map(x => x[1]), backgroundColor: color, borderRadius: 3 }] },
      options: { indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } } } }
    });
  }
  function table(id, entries, total, n = 8) {
    $(id).innerHTML = entries.length
      ? `<table>${entries.slice(0, n).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td><td class="num">${pct(v, total)}</td></tr>`).join('')}</table>`
      : '<p class="muted">No data yet.</p>';
  }

  // ------------------------------------------------------------ render
  function render() {
    if (!DATA) return;
    const days = +$('range').value;
    const proj = $('project').value;
    const since = days ? (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() - (days - 1) * 864e5; })() : 0;
    const keep = r => r.t >= since && (!proj || r.project === proj);
    const chat = DATA.chat.filter(keep);
    const inline = DATA.inline.filter(keep);

    // KPIs
    const sessions = new Set(chat.map(r => r.session)).size;
    const activeDays = new Set([...chat, ...inline].map(r => dayKey(r.t))).size;
    const models = count(chat, r => r.model);
    const projects = count([...chat, ...inline], r => r.project);
    const aiChars = inline.reduce((s, r) => s + (r.chars || 0), 0);
    const kpi = (v, l) => `<div class="kpi"><b>${esc(v)}</b><span>${esc(l)}</span></div>`;
    $('kpis').innerHTML = [
      kpi(chat.length, 'chat prompts'),
      kpi(inline.length, 'inline accepts (est.)'),
      kpi(sessions, 'chat sessions'),
      kpi(activeDays, 'active days'),
      kpi(models[0] ? models[0][0] : '–', 'top model'),
      kpi(projects[0] ? projects[0][0] : '–', 'top project'),
      kpi(aiChars > 9999 ? (aiChars / 1000).toFixed(1) + 'k' : aiChars, 'chars from inline')
    ].join('');
    const firstChat = DATA.chat.reduce((m, r) => Math.min(m, r.t), Infinity);
    const firstInline = DATA.inline.reduce((m, r) => Math.min(m, r.t), Infinity);
    $('sub').textContent = `${DATA.meta.files} chat files scanned · first Copilot chat: ${isFinite(firstChat) ? dayKey(firstChat) : '–'}`
      + ` · inline tracked since: ${isFinite(firstInline) ? dayKey(firstInline) : 'install (no data yet)'}`
      + ` · updated ${new Date(DATA.meta.generated).toLocaleTimeString()}`;

    // Per day (fill gaps)
    const start = days ? since : Math.min(...[...chat, ...inline].map(r => r.t), Date.now());
    const labels = [];
    for (let d = new Date(start); d <= new Date(); d.setDate(d.getDate() + 1)) labels.push(dayKey(d.getTime()));
    const perDay = arr => { const m = new Map(count(arr, r => dayKey(r.t))); return labels.map(l => m.get(l) || 0); };
    draw('cDay', {
      type: 'bar',
      data: { labels, datasets: [
        { label: 'Chat', data: perDay(chat), backgroundColor: CHAT, borderRadius: 2 },
        { label: 'Inline (est.)', data: perDay(inline), backgroundColor: INLINE, borderRadius: 2 }
      ] },
      options: { scales: { x: { stacked: true, ticks: { maxTicksLimit: 15 } }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } } }
    });

    // Hour of day
    const hours = [...Array(24).keys()];
    const perHour = arr => { const h = Array(24).fill(0); arr.forEach(r => h[new Date(r.t).getHours()]++); return h; };
    draw('cHour', {
      type: 'bar',
      data: { labels: hours.map(h => String(h).padStart(2, '0')), datasets: [
        { label: 'Chat', data: perHour(chat), backgroundColor: CHAT },
        { label: 'Inline', data: perHour(inline), backgroundColor: INLINE }
      ] },
      options: { scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, ticks: { precision: 0 } } } }
    });

    // Chat vs inline
    draw('cKind', {
      type: 'doughnut',
      data: { labels: ['Chat prompts', 'Inline accepts (est.)'], datasets: [{ data: [chat.length, inline.length], backgroundColor: [CHAT, INLINE], borderWidth: 0 }] },
      options: { cutout: '60%', plugins: { legend: { position: 'right' } } }
    });

    // Projects: combined chart + split table
    doughnut('cProject', projects);
    const pc = new Map(count(chat, r => r.project)), pi = new Map(count(inline, r => r.project));
    $('tProject').innerHTML = projects.length
      ? `<table><tr><th>Project</th><th class="num">Chat</th><th class="num">Inline</th></tr>${projects.slice(0, 8).map(([k]) =>
          `<tr><td>${esc(k)}</td><td class="num">${pc.get(k) || 0}</td><td class="num">${pi.get(k) || 0}</td></tr>`).join('')}</table>`
      : '<p class="muted">No data yet.</p>';

    // Models, modes, agents, prompt types
    doughnut('cModel', models); table('tModel', models, chat.length);
    doughnut('cMode', count(chat, r => r.mode));
    doughnut('cAgent', count(chat, r => r.agent));
    const types = count(chat, r => r.ptype);
    doughnut('cType', types); table('tType', types, chat.length);

    // Skills, custom agents, prompt files, slash commands
    const sections = [
      ['Skills (SKILL.md)', count(chat, r => r.skills)],
      ['Custom agents', count(chat, r => r.agentFiles)],
      ['Prompt files', count(chat, r => r.promptFiles)],
      ['Slash commands', count(chat, r => r.slash)]
    ];
    $('tCustom').innerHTML = sections.map(([title, e]) =>
      `<h3>${title}</h3>` + (e.length
        ? `<table>${e.slice(0, 8).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`).join('')}</table>`
        : '<p class="muted">None used in this period.</p>')).join('');

    hbar('cTool', count(chat, r => r.tools), 12, PALETTE[4]);
    hbar('cLang', count(inline, r => r.lang), 10, INLINE);
    renderFolders(chat, inline);
  }

  // ------------------------------------------------------------ folders table
  let folderSort = { key: 'last', dir: -1 };
  let folderRows = [];

  const displayPath = p => {
    let s = String(p || '');
    try { s = decodeURIComponent(s); } catch { /* keep raw */ }
    s = s.replace(/^file:\/\//i, '');
    if (/^\/[a-zA-Z]:/.test(s)) s = s.slice(1).replace(/\//g, '\\'); // /c:/x -> c:\x
    return s;
  };

  function renderFolders(chat, inline) {
    const map = new Map();
    const get = r => {
      const key = (r.wsPath ? displayPath(r.wsPath) : r.ws || '(unknown)').toLowerCase();
      if (!map.has(key)) map.set(key, {
        name: r.ws || '(unknown)', path: r.wsPath ? displayPath(r.wsPath) : '', raw: r.wsPath || '',
        project: r.project, prompts: 0, inline: 0, sessions: new Set(), models: new Map(),
        first: Infinity, last: 0, here: false
      });
      const f = map.get(key);
      if (!f.raw && r.wsPath) { f.raw = r.wsPath; f.path = displayPath(r.wsPath); }
      f.first = Math.min(f.first, r.t); f.last = Math.max(f.last, r.t);
      f.here = f.here || !!r.here;
      return f;
    };
    for (const r of chat) {
      const f = get(r);
      f.prompts++; f.sessions.add(r.session);
      f.models.set(r.model, (f.models.get(r.model) || 0) + 1);
    }
    for (const r of inline) get(r).inline++;

    folderRows = [...map.values()].map(f => {
      const top = [...f.models.entries()].sort((a, b) => b[1] - a[1])[0];
      return { ...f, sessions: f.sessions.size, model: top ? top[0] : '—', modelShare: top && f.prompts ? Math.round(100 * top[1] / f.prompts) : 0 };
    });
    drawFolders();
  }

  function drawFolders() {
    const q = lc($('folderSearch').value).trim();
    const rows = folderRows
      .filter(f => !q || lc(f.name).includes(q) || lc(f.path).includes(q) || lc(f.project).includes(q) || lc(f.model).includes(q))
      .sort((a, b) => {
        const k = folderSort.key, x = a[k], y = b[k];
        const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
        return c * folderSort.dir;
      });
    $('folderCount').textContent = `(${rows.length}${rows.length !== folderRows.length ? ' of ' + folderRows.length : ''})`;
    if (!folderRows.length) { $('tFolders').innerHTML = '<p class="muted">No Copilot usage in this period.</p>'; return; }

    const cols = [
      ['name', 'Folder'], ['project', 'Project'], ['prompts', 'Chat prompts', 'num'], ['sessions', 'Sessions', 'num'],
      ['inline', 'Inline (est.)', 'num'], ['model', 'Top model'], ['first', 'First use'], ['last', 'Last use']
    ];
    const arrow = k => folderSort.key === k ? (folderSort.dir > 0 ? ' ▲' : ' ▼') : '';
    const head = cols.map(([k, t, c]) => `<th class="sort ${c || ''}" data-key="${k}">${t}${arrow(k)}</th>`).join('');
    const body = rows.map(f => `<tr${f.here ? ' class="here"' : ''}>
      <td><b>${esc(f.name)}</b>${f.here ? ' <span class="badge project">open now</span>' : ''}
        <div class="muted small">${esc(f.path || '—')}</div></td>
      <td>${f.project === f.name ? '<span class="muted">—</span>' : esc(f.project)}</td>
      <td class="num">${f.prompts}</td>
      <td class="num">${f.sessions}</td>
      <td class="num">${f.inline}</td>
      <td>${esc(f.model)}${f.modelShare ? ` <span class="muted small">${f.modelShare}%</span>` : ''}</td>
      <td>${fmtDay(isFinite(f.first) ? f.first : 0)}</td>
      <td>${fmtDay(f.last)}</td>
      <td>${f.raw && !f.here ? `<a href="#" class="openFolder" data-path="${esc(f.raw)}" title="Open in a new window">Open ↗</a>` : ''}</td>
    </tr>`).join('');
    $('tFolders').innerHTML = `<table class="folders"><tr>${head}<th></th></tr>${body}</table>`;
  }

  function setData(data) {
    DATA = data;
    const sel = $('project');
    const current = sel.value;
    const defined = data.meta.projects || [];
    const folders = [...new Set([...data.chat, ...data.inline].map(r => r.project))]
      .filter(n => !defined.includes(n)).sort();
    const opt = n => `<option value="${esc(n)}">${esc(n)}</option>`;
    sel.innerHTML = '<option value="">All projects</option>'
      + (defined.length ? `<optgroup label="My projects">${defined.map(opt).join('')}</optgroup>` : '')
      + (folders.length ? `<optgroup label="Unassigned folders">${folders.map(opt).join('')}</optgroup>` : '');
    if ([...defined, ...folders].includes(current)) sel.value = current;
    $('projectHint').hidden = defined.length > 0;
    updateButtons();
    render();
  }

  function updateButtons() {
    const isProject = DATA && (DATA.meta.projects || []).includes($('project').value);
    $('deleteProject').disabled = !isProject;
  }

  // ------------------------------------------------------------ "This workspace" tab
  let SETUP = null;
  const lc = v => String(v || '').toLowerCase();
  const fmtDay = t => t ? dayKey(t) : '–';

  function usesOf(item, records) {
    const k = item.keys || [lc(item.name)];
    const hit = r => {
      if (item.kind === 'skill') return (r.skills || []).some(s => k.includes(lc(s)));
      if (item.kind === 'agent') return (r.agentFiles || []).some(s => k.includes(lc(s))) || k.includes(lc(r.mode));
      if (item.kind === 'prompt') return (r.promptFiles || []).some(s => k.includes(lc(s))) || k.includes(lc((r.slash || '').slice(1)));
      if (item.kind === 'instruction') return (r.instructionFiles || []).some(s => k.includes(lc(s)));
      return false;
    };
    const used = records.filter(hit);
    return { n: used.length, last: used.reduce((m, r) => Math.max(m, r.t), 0) };
  }

  function itemTable(id, items, records, columns, emptyMsg) {
    if (!items.length) { $(id).innerHTML = `<p class="muted">${emptyMsg}</p>`; return; }
    const rows = items.map(it => {
      const u = usesOf(it, records);
      const badge = `<span class="badge ${esc(it.scope)}">${it.scope === 'personal' ? 'Personal' : 'Project'}</span>`;
      const name = `<a href="#" class="open" data-file="${esc(it.file)}" title="${esc(it.file)}">${esc(it.name)}</a>`;
      const extra = columns.map(c => `<td>${c(it)}</td>`).join('');
      const usage = u.n ? `<b>${u.n}</b><div class="muted">last ${fmtDay(u.last)}</div>` : '<span class="muted">never</span>';
      return `<tr><td>${name} ${badge}<div class="muted small">${esc(it.rel)}</div></td>${extra}<td class="num">${usage}</td></tr>`;
    }).join('');
    const head = columns.map(c => `<th>${esc(c.title)}</th>`).join('');
    $(id).innerHTML = `<table class="items"><tr><th>Name</th>${head}<th class="num">Used here</th></tr>${rows}</table>`;
  }
  const col = (title, fn) => Object.assign(fn, { title });
  const descCol = col('Description', it => esc(it.description || '—'));
  const chips = arr => (arr || []).map(t => `<span class="chip">${esc(t)}</span>`).join(' ') || '<span class="muted">all</span>';

  function renderSetup() {
    if (!SETUP) return;
    const here = DATA ? DATA.chat.filter(r => r.here) : [];
    const items = SETUP.items;
    const of = kind => items.filter(i => i.kind === kind);
    const folders = SETUP.folders;

    $('wsTitle').textContent = folders.length ? (SETUP.workspaceName || folders.map(f => f.name).join(' + ')) : 'No folder open';
    $('wsSub').textContent = folders.length ? folders.map(f => f.path).join(' · ') : 'Open a folder (File → Open Folder) to see its AI setup.';

    const sorted = [...here].sort((a, b) => b.t - a.t);
    const mcpServers = of('mcp').reduce((s, m) => s + (m.servers || []).length, 0);
    const kpi = (v, l) => `<div class="kpi"><b>${esc(v)}</b><span>${esc(l)}</span></div>`;
    $('wsKpis').innerHTML = [
      kpi(here.length, 'chat prompts here'),
      kpi(new Set(here.map(r => r.session)).size, 'chat sessions'),
      kpi(sorted.length ? fmtDay(sorted[sorted.length - 1].t) : '–', 'first Copilot use'),
      kpi(sorted.length ? sorted[0].model : '–', 'last model used'),
      kpi(of('agent').length, 'custom agents'),
      kpi(of('skill').length, 'skills'),
      kpi(of('instruction').length, 'instruction files'),
      kpi(of('prompt').length, 'prompt files'),
      kpi(mcpServers, 'MCP servers')
    ].join('');

    const models = count(here, r => r.model);
    doughnut('wModel', models); table('wModelT', models, here.length);
    doughnut('wMode', count(here, r => r.mode));
    table('wAgentT', count(here, r => r.agent), here.length);

    itemTable('wAgents', of('agent'), here, [descCol,
      col('Model', it => esc(it.model || 'default')),
      col('Tools', it => chips(it.tools))],
      'No custom agents. Add one in <code>.github/agents/&lt;name&gt;.agent.md</code>.');
    itemTable('wSkills', of('skill'), here, [descCol],
      'No skills. Add one in <code>.github/skills/&lt;name&gt;/SKILL.md</code>.');
    itemTable('wInstr', of('instruction'), here, [descCol,
      col('Applies to', it => esc(it.applyTo || '—'))],
      'No instruction files. Try <code>.github/copilot-instructions.md</code> or <code>AGENTS.md</code>.');
    itemTable('wPrompts', of('prompt'), here, [descCol,
      col('Agent / model', it => esc([it.agent, it.model].filter(Boolean).join(' · ') || 'default'))],
      'No prompt files. Add reusable prompts in <code>.github/prompts/&lt;name&gt;.prompt.md</code>.');

    const mcp = of('mcp');
    $('wMcp').innerHTML = mcp.length && mcpServers
      ? `<table>${mcp.flatMap(m => (m.servers || []).map(s =>
          `<tr><td><a href="#" class="open" data-file="${esc(m.file)}">${esc(s.name)}</a> <span class="badge ${esc(m.scope)}">${m.scope === 'personal' ? 'Personal' : 'Project'}</span></td><td>${esc(s.type)}</td><td class="muted small">${esc(s.target)}</td></tr>`)).join('')}</table>`
      : '<p class="muted">No MCP servers configured (<code>.vscode/mcp.json</code>).</p>';

    $('wSettings').innerHTML = SETUP.settings.length
      ? `<table>${SETUP.settings.map(s => `<tr><td><code>${esc(s.key)}</code></td><td class="small">${esc(s.value)}</td></tr>`).join('')}</table>`
      : '<p class="muted">No Copilot / chat settings in this workspace — VS Code defaults apply.</p>';

    $('wAvail').innerHTML = SETUP.models.length
      ? SETUP.models.map(m => {
          const used = models.find(([k]) => lc(k) === lc(m.id) || lc(k) === lc(m.family) || lc(k) === lc(m.name));
          return `<span class="chip ${used ? 'used' : ''}" title="${esc(m.id)}${m.maxInput ? ' · ' + m.maxInput + ' input tokens' : ''}">${esc(m.name)}${used ? ' · ' + used[1] : ''}</span>`;
        }).join(' ') + '<p class="muted small">Highlighted = used in this workspace (with prompt count).</p>'
      : '<p class="muted">Copilot did not report its model list (needs the Copilot Chat extension signed in).</p>';
  }

  function showTab(name) {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('.tabpane').forEach(p => { p.hidden = p.id !== 'tab-' + name; });
    const st = vscode.getState() || {}; vscode.setState({ ...st, tab: name });
    // Charts in hidden panes have zero size: re-render the visible one
    if (name === 'workspace') renderSetup(); else render();
  }

  // ------------------------------------------------------------ wiring
  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
  $('wsRefresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  $('folderSearch').addEventListener('input', drawFolders);
  document.body.addEventListener('click', e => {
    const th = e.target.closest('th.sort');
    if (th) {
      const k = th.dataset.key;
      folderSort = folderSort.key === k ? { key: k, dir: -folderSort.dir } : { key: k, dir: ['name', 'project', 'model'].includes(k) ? 1 : -1 };
      drawFolders();
      return;
    }
    const of = e.target.closest('a.openFolder');
    if (of) { e.preventDefault(); vscode.postMessage({ type: 'openFolder', path: of.dataset.path }); return; }
    const a = e.target.closest('a.open');
    if (a) { e.preventDefault(); vscode.postMessage({ type: 'openFile', file: a.dataset.file }); }
  });
  const state = vscode.getState() || {};
  if (state.range) $('range').value = state.range;
  if (state.tab) showTab(state.tab);
  $('range').addEventListener('change', () => { vscode.setState({ ...(vscode.getState() || {}), range: $('range').value }); render(); });
  $('project').addEventListener('change', () => { updateButtons(); render(); });
  $('addProject').addEventListener('click', () => vscode.postMessage({ type: 'addProject' }));
  $('editProject').addEventListener('click', () => vscode.postMessage({ type: 'editProject', name: $('project').value }));
  $('deleteProject').addEventListener('click', () => vscode.postMessage({ type: 'deleteProject', name: $('project').value }));
  $('hintAdd').addEventListener('click', () => vscode.postMessage({ type: 'addProject' }));
  $('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
  window.addEventListener('message', e => {
    const m = e.data || {};
    if (m.type === 'data') { setData(m.data); renderSetup(); }
    else if (m.type === 'setup') { SETUP = m.setup; renderSetup(); }
    else if (m.type === 'tab') showTab(m.tab);
  });
  vscode.postMessage({ type: 'ready' });
})();
