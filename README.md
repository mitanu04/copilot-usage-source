# Copilot Usage Dashboard

**Author:** Mergea Sergiu-Octavian

Local statistics about how you use GitHub Copilot in VS Code. Nothing leaves your machine.

## What it shows
- Usage per day and per hour (chat vs inline)
- Projects you define yourself (each unassigned folder is shown under its own name)
- Chat vs inline completions
- Models (% of chat prompts)
- Chat modes (Ask / Edit / Agent) and agents / @participants
- Prompt types (debug, explain, tests, refactor, generate, docs, …; EN + RO keywords)
- Skills (SKILL.md), custom agents (.agent.md), prompt files (.prompt.md), slash commands
- Tools the agent called, and inline completions per language
- **Folders** table: every folder where you used Copilot, with full path, project, chat prompts,
  sessions, inline count, top model, first and last use. Sortable (click a header), filterable,
  and **Open ↗** opens that folder in a new window. Follows the period/project filters (use *All time* for full history).

## "This workspace" tab
Open a folder in VS Code, then open the dashboard and switch to **🧩 This workspace**
(or run **Copilot Usage: Show AI Setup of This Workspace**). It lists everything AI-related that applies to that folder:

- **Custom agents** – `*.agent.md` / `*.chatmode.md` (description, model, tools)
- **Skills** – `**/SKILL.md` (project `.github/skills`, plus personal `~/.copilot/skills`, `~/.claude/skills`)
- **Instructions** – `.github/copilot-instructions.md`, `*.instructions.md` (with `applyTo`), `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`
- **Prompt files** – `*.prompt.md` (project and personal ones from your VS Code `User/prompts` folder)
- **MCP servers** – `.vscode/mcp.json` and your user `mcp.json`
- **AI settings** – `github.copilot.*` / `chat.*` keys in `.vscode/settings.json`
- **Models** – models used in this folder (%, last used) and the models Copilot currently offers you

Every item shows **how many times it was used here** and when it was last used, so you can spot
skills or agents you configured but never use. Click a name to open the file. The tab rescans
automatically when one of these files changes.

## Install
1. In VS Code: Extensions view → `…` menu → **Install from VSIX…** → pick `copilot-usage-dashboard-0.5.0.vsix`.
   (or: `code --install-extension copilot-usage-dashboard-0.5.0.vsix`)
2. Reload the window.

## Use
- Click the `📈 N chat · M inline` item in the status bar, or run **Copilot Usage: Open Dashboard** from the Command Palette (`Ctrl+Shift+P`).
- Use the dropdowns to filter by period (7 / 30 / 90 days / all) and by project. ⟳ rescans.
- **Copilot Usage: Export Data as JSON** – dump all records for your own analysis.
- **Copilot Usage: Reset Inline Completion History** – clear the inline tracker.

## Projects
No projects are predefined. Until you create one, usage is grouped by workspace folder name.
- In the dashboard click **+ Project**, type a name, then tick the folders that belong to it
  (every folder Copilot was used in is listed, with its record count).
- Optionally choose **Add a name pattern…** (e.g. `*sailpoint*`) so future folders join automatically.
- Select a project in the dropdown and click **Edit** or **Delete** to change it.
- Same actions from the Command Palette: **Copilot Usage: Add or Edit Project**, **Copilot Usage: Delete Project**.
- A folder belongs to one project; picking it for a new project moves it. Deleting a project never deletes usage data.

## Where the data comes from
- **Chat**: read from VS Code's own chat history (`<User>/workspaceStorage/*/chatSessions`). Your existing history is included immediately.
- **Inline**: VS Code doesn't expose accepted suggestions to other extensions, so the extension counts
  large single insertions that are not pastes or undo/redo. It's an estimate, and it only starts counting after installation.
  Stored in the extension's global storage as monthly JSONL files.

## Settings (`copilotUsage.*`)
| Setting | Purpose |
|---|---|
| `projectGroups` | Your projects (managed from the dashboard; editable by hand too) |
| `trackInline` | Turn inline estimation on/off |
| `inlineMinChars` | Minimum insertion size counted as a completion (default 15) |
| `statusBar` | Show/hide the status bar counter |
| `extraChatFolders` | Extra VS Code `User` folders to scan (e.g. Code - Insiders) |

## Notes
VS Code's chat file format is internal and changes between releases. If a chart shows `(unknown)`,
run **Export Data as JSON** and adjust the field lookups in `src/parser.js`.

## Security & privacy
- **Local only.** No network requests, no telemetry. The only external call is VS Code's own
  `vscode.lm` API to list which Copilot models are available.
- **No prompt text or code is stored or displayed.** Chat records keep only metadata (time, model,
  mode, agent, word count, prompt category, file names referenced). Inline tracking stores time,
  folder, language and size — never the inserted code. The clipboard is read only to tell a paste
  from a completion, compared in memory, and discarded.
- **Webview hardening.** Strict Content-Security-Policy (nonce-only scripts, no inline or remote
  code, Chart.js bundled locally), all values HTML-escaped, and the dashboard can only ask the
  extension to open files/folders the extension itself discovered (no arbitrary paths, no remote URIs).
- **Robust parsing.** Chat files are parsed defensively: prototype-pollution keys are rejected,
  oversized files are skipped, and file-reference detection is linear-time (no ReDoS).
- **Workspace trust.** All settings are user-level only (a cloned repo's `.vscode/settings.json`
  cannot change them). In untrusted workspaces, folder-specific `chat.*FilesLocations` are ignored.
- **Secrets.** MCP `env` and `headers` are never read; tokens in MCP URLs/arguments are masked (`•••`).
