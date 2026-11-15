// Estimates accepted inline (ghost-text) completions.
//
// Extensions cannot observe Copilot's suggestions directly, so we use a
// heuristic: a single insertion of >= N characters in the active editor that is
// not an undo/redo and not equal to the clipboard (i.e. not a paste) is almost
// always an accepted completion. Numbers are therefore an estimate.
//
// Events are appended to monthly JSONL files in the extension's global storage,
// so several open VS Code windows can write without overwriting each other.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

class InlineTracker {
  constructor(context, onChange) {
    this.dir = path.join(context.globalStorageUri.fsPath, 'inline');
    fs.mkdirSync(this.dir, { recursive: true });
    this.context = context;
    this.onChange = onChange;
  }

  start() {
    this.context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument(e => this.handle(e))
    );
  }

  async handle(e) {
    const cfg = vscode.workspace.getConfiguration('copilotUsage');
    if (!cfg.get('trackInline', true)) return;
    if (e.reason !== undefined) return; // undo / redo
    if (e.contentChanges.length !== 1) return; // formatting, multi-cursor, refactors
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document !== e.document) return;
    if (!['file', 'untitled', 'vscode-remote'].includes(e.document.uri.scheme)) return;

    const ch = e.contentChanges[0];
    const text = ch.text;
    if (text.trim().length < cfg.get('inlineMinChars', 15)) return;
    if (ch.rangeLength > text.length) return; // replaces more than it inserts

    try {
      const clip = await vscode.env.clipboard.readText();
      if (clip && clip.trim() === text.trim()) return; // a paste
    } catch { /* clipboard unavailable: keep the event */ }

    const folder = vscode.workspace.getWorkspaceFolder(e.document.uri);
    const ws = folder ? folder.name : (vscode.workspace.name || '(no folder open)');
    const wsPath = folder ? folder.uri.fsPath : '';
    const now = new Date();
    const rec = { t: now.getTime(), ws, wsPath, lang: e.document.languageId, chars: text.length, lines: text.split('\n').length };
    const file = path.join(this.dir, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}.jsonl`);
    fs.appendFile(file, JSON.stringify(rec) + '\n', () => this.onChange && this.onChange());
  }

  records() {
    const out = [];
    let files = [];
    try { files = fs.readdirSync(this.dir).filter(f => f.endsWith('.jsonl')); } catch { return out; }
    for (const f of files) {
      const text = fs.readFileSync(path.join(this.dir, f), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch { /* partial line */ }
      }
    }
    return out;
  }

  reset() {
    for (const f of fs.readdirSync(this.dir)) fs.rmSync(path.join(this.dir, f), { force: true });
  }
}

module.exports = { InlineTracker };
