# Research Note Helper

VS Code extension that fills empty Markdown headings in research notes by
calling a configurable Codex CLI executable.

## Requirements

- VS Code 1.85.0 or newer.
- Codex CLI available as `codex`, or a full executable path set in
  `researchNoteHelper.codexCommand`.
- Node.js 20 or newer for tests and packaging. Node.js 22 is pinned in
  `.node-version` for local development.

This extension is disabled in untrusted workspaces because it starts an
external Codex CLI process and can edit workspace files.

## Commands

- `Research Notes: Fill/Append Headings with Codex`
  - Finds target Markdown headings in the active note.
  - Saves the note, then runs `codex exec`.
  - Codex rereads the file and fills or appends only headings that still match
    the configured fill policy.
  - Shows approximate progress and the current safe Codex activity while it is
    running.
  - Refreshes open Markdown preview tabs after the note is updated.
  - Default shortcut: `Ctrl+K Ctrl+Q`.

- `Research Notes: List Empty Headings`
  - Shows empty headings and jumps to the selected one.

- `Research Notes: Delete Failure Log`
  - Deletes the configured failure log after a confirmation dialog.

- `Research Notes: Set Mode`
  - Switches the prompt mode: `research`, `general`, or `jobHunting`.

- `Research Notes: Set Fill Policy`
  - Switches which headings are updated.

- `Research Notes: Run Self Test`
  - Runs lightweight manifest, prompt, logging, and command checks inside VS Code.

## Intended Flow

1. Add a heading such as `# Hamiltonian simulation`.
2. Press `Ctrl+K Ctrl+Q`.
3. Codex fills only the empty heading.

For job-hunting notes:

1. Run `Research Notes: Set Mode` and choose `jobHunting`.
2. Run `Research Notes: Set Fill Policy` and choose `emptyOrBulletsOnly`.
3. Use headings as company names and rough `-` bullets as source notes.
4. Press `Ctrl+K Ctrl+Q` to append short company/job-hunting notes without
   deleting the existing bullets.

## Settings

- `researchNoteHelper.mode`
  - Prompt mode. Options: `research`, `general`, `jobHunting`.
- `researchNoteHelper.fillPolicy`
  - `emptyOnly`: update only empty headings.
  - `emptyOrBulletsOnly`: update empty headings and headings that contain only
    bullet lines.
  - `appendAlways`: append to every heading section.
- `researchNoteHelper.researchField`
  - Optional field context, such as `quantum computing`.
- `researchNoteHelper.outputLanguage`
  - Output language for generated note text. Default: `Japanese`.
- `researchNoteHelper.noteStyle`
  - Optional prompt style instruction. When empty, the selected mode supplies a
    default style.
- `researchNoteHelper.headingLevel`
  - Markdown heading level to fill. Default: `1`.
- `researchNoteHelper.codexCommand`
  - Executable name or full executable path for Codex. Do not include arguments.
- `researchNoteHelper.allowBundledCodexFromOpenAIExtension`
  - Allows fallback to a bundled `codex.exe` from the OpenAI ChatGPT/Codex
    extension. Disabled by default.
- `researchNoteHelper.enableWebSearch`
  - Adds `--search` to the Codex command. Disabled by default.
- `researchNoteHelper.showCodexProgress`
  - Shows approximate progress from `codex exec --json` events. Enabled by
    default. The percentage is a best-effort stage estimate, not a Codex API
    guarantee.
- `researchNoteHelper.logFileName`
  - Workspace-relative failure log path. Default: `research-note-helper.log`.
- `researchNoteHelper.logLevel`
  - `minimal` avoids prompt/stdout/stderr. `debug` includes them for debugging.

## Privacy

This extension does not call the OpenAI API directly and does not read the
clipboard, environment variables, or arbitrary files by itself. It starts the
configured Codex CLI process and sends a prompt containing the target file path
and empty headings.

Codex may read the target Markdown file and may send data to its configured
provider according to your Codex setup. Enabling `researchNoteHelper.enableWebSearch`
also allows Codex to perform web search. See `SECURITY.md` before
using this on confidential notes.

Do not enable this extension in workspaces you do not trust. Codex is launched
with `--sandbox workspace-write`, but it may still inspect and edit files that
the Codex sandbox allows within the workspace.

## Logs

Failure logs are written only when the Codex command fails. The default
`minimal` log level avoids recording the prompt, stdout, stderr, and heading
titles. Use `Research Notes: Delete Failure Log` to remove the log from the
workspace.

## Local Development

Node dependencies are local to this folder. There is no Python-style virtual
environment for Node.js, but `node_modules/` and the pinned dev tools stay
inside the project.

If Node.js is already installed:

```powershell
npm install
npm test
```

If you want a folder-local Node.js runtime on Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-local-node.ps1
.\scripts\npm-local.cmd install
.\scripts\npm-local.cmd test
```

The local runtime is installed under `.tools/node`, which is ignored by Git and
excluded from VSIX packages.

## Tests

Inside VS Code, run:

- `Research Notes: Run Self Test`

Run unit tests from this directory:

```powershell
npm test
```

The tests use Node's built-in `node:test` runner and do not require extra
runtime packages.

Build a VSIX:

```powershell
npm run package
```

`npm run package` uses the pinned local `@vscode/vsce` devDependency and allows
a missing repository URL for local VSIX builds. After the GitHub repository URL
is added to `package.json`, use the stricter release check:

```powershell
npm run package:strict
```

## Release Checklist

1. Confirm `publisher` in `package.json` matches the real VS Code Marketplace
   publisher ID.
2. Add the final GitHub `repository`, `bugs`, and `homepage` URLs to
   `package.json` after the public repository exists.
3. Run `npm install`, commit `package-lock.json`, then run `npm test`.
4. Run `npm run package:strict` once repository metadata is present.
5. Install the generated VSIX locally and test the main commands on a disposable
   Markdown workspace.
