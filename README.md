# Codex Note Helper

![Codex Note Helper icon](media/icon.png)

Codex Note Helper is a VS Code extension that generates updates for selected
Markdown heading sections with the Codex CLI. Codex returns a structured
proposal; the extension validates it and applies accepted section ranges
through VS Code's `TextEditor.edit` API.

Codex does not edit the workspace directly. It runs in a read-only sandbox, and
a successful process exit alone is never treated as proof that a note changed.

## Requirements

- VS Code 1.85.0 or newer.
- Codex CLI available as `codex`, or an executable path configured in
  `codexNoteHelper.codexCommand`.
- A trusted VS Code window and a file-backed local or remote Markdown document.
  The document may be a standalone file outside a workspace folder.
- Codex authentication configured on the local or remote extension host.
- Node.js 22 or newer only for development, tests, and packaging.

The extension runs on the local or remote extension host. In Remote SSH, WSL,
Dev Containers, and Codespaces, install and authenticate the Codex CLI in the
remote environment. Only `file` and `vscode-remote` documents are accepted;
untitled documents, Git/diff documents, and virtual workspace providers are
rejected.

## Quick Start

1. Open a local or remote Markdown file in a trusted VS Code window.
2. Add a heading such as `# Hamiltonian simulation`.
3. Run `Codex Notes: Generate and Review Target Heading Updates` from the
   Command Palette.
4. Review and accept the mandatory first-run data notice.
5. Review the target summary when prompted.
6. Inspect the VS Code diff, then explicitly apply or discard the proposal.

Version 0.3.0 deliberately has no default keyboard shortcut. Earlier releases
used `Ctrl+K Ctrl+Q`, which conflicts with VS Code's Go to Last Edit Location
command. Assign a shortcut from VS Code's Keyboard Shortcuts editor if wanted.

## Safe Update Flow

Each run follows these stages:

1. Resolve the active `file` or `vscode-remote` Markdown document. A standalone
   file does not need to belong to a workspace folder.
2. Capture the open document instance, URI, in-memory version, and text, then
   find target heading sections. This snapshot does not save the document and
   is not source-control versioning.
3. Enforce the configured document-size, heading-count, output-size, and
   timeout limits.
4. Show mandatory first-run data consent. The notice's Privacy Details action
   opens the `SECURITY.md` packaged with the installed extension.
5. According to `confirmBeforeRun`, show a target summary containing the file,
   target count, localized mode and policy, and web-search state. Web search or
   Codex user configuration forces this confirmation on every run, including
   when the setting is `never`.
6. Resolve the machine-scoped executable. A command name searches `PATH` first;
   when the command is the default `codex`, an enabled OpenAI-extension bundle
   is used only if `codex` is absent from `PATH`. Resolved executables and shim
   components inside an open workspace, or directly beside the active note,
   are rejected, including when the note is opened without a workspace folder.
7. Ask for explicit approval of the resolved executable fingerprint before its
   first probe or generation run. A changed fingerprint requires approval
   again. The extension resolves and fingerprints it again after approval and
   immediately before generation, so a replacement during either gap is
   rejected instead of executed.
8. Start one Codex process for the document. Concurrent runs for the same
   document are refused, and at most three documents run concurrently.
9. Run Codex from an isolated directory under extension global storage, with
   an ephemeral session, repository rules ignored, a read-only sandbox, and a
   fixed JSON output schema.
10. Inspect every JSON event even when progress notifications are disabled.
    Only the expected lifecycle events, reasoning/todo items, the final agent
    message, and opt-in web search are allowed. Unknown events, failed turns,
    extra output after completion, and command, file, MCP, computer, dynamic,
    or collaboration tool events abort the run.
11. Require a final agent message followed by a successful `turn.completed`,
    then parse the proposal
    `{ "updates": [{ "targetIndex": number, "markdown": string }], "warnings": string[] }`.
    Warnings are limited to three strings of at most 160 characters and all are
    shown in the apply decision.
12. Reject malformed, duplicate, missing, oversized, stale, unsafe, or
    out-of-range updates. Unsafe output includes control/bidirectional text,
    raw HTML, damaged fences, and obfuscated link destinations or explicit URI
    schemes other than HTTP(S). Relative and fragment links remain allowed.
    Ownership markers isolate generated blocks, including independently
    targeted human-authored parent and child headings.
13. Recheck the same open document instance, version, and text, open a mandatory
    VS Code diff, and ask the user to apply or discard the proposal.
14. Recheck the snapshot and apply only the validated target ranges with one
    `TextEditor.edit` undo step. The result remains a normal unsaved editor edit
    until the user saves it.

Cancellation, timeout, invalid output, policy violation, Codex failure, and the
Discard action do not apply generated edits. A preview already opened in VS Code
may remain visible until its editor is closed; no complete in-memory erasure is
claimed. Use `Codex Notes: Cancel Active Run` even when progress notifications
are disabled. Editing or closing the source note cancels the run immediately
instead of spending the remaining generation budget on a proposal that can no
longer be applied.

## Commands

- `Codex Notes: Generate and Review Target Heading Updates`
  - Generates and validates a preview, then applies it only after explicit
    review and approval.
- `Codex Notes: Cancel Active Run`
  - Cancels the active Codex process. If no run is active, it reports that
    state without changing files.
- `Codex Notes: List Target Headings`
  - Lists the sections selected by the current heading level and target policy,
    then jumps to the chosen heading.
- `Codex Notes: Set Generation Mode`
  - Selects `research`, `general`, or `jobHunting`.
- `Codex Notes: Set Target Policy`
  - Selects which heading sections are eligible.
- `Codex Notes: Delete Diagnostic Log`
  - Deletes only the extension-owned diagnostic log.
- `Codex Notes: Run Diagnostics`
  - Reports the extension version, trust and host state, validates current
    settings and extension storage, resolves and permission-checks the Codex
    executable, probes its version and required flags, and reports user-config
    isolation plus diagnostic-log presence in an Output channel.

The old command IDs `codexNoteHelper.listEmptyHeadings` and
`codexNoteHelper.runSelfTest` remain runtime aliases for compatibility, but are
not shown in the Command Palette.

## Modes and Target Policies

Modes:

- `research`: concise research notes with a paper reference only when it can be
  verified. Web search remains opt-in.
- `general`: concise explanatory notes without mandatory references.
- `jobHunting`: company, role-fit, selection, and interview notes.

Target policies:

- `emptyOnly`: sections with no meaningful body content.
- `emptyOrBulletsOnly`: empty sections and sections containing only Markdown
  list source notes.
- `appendAlways`: every matching heading. Existing user content is preserved;
  the generated block with that section's ID is replaced on subsequent runs.
  Parent and human-authored child headings have separate ownership blocks.

Generated blocks are opaque to target discovery: headings emitted by Codex are
not offered as new targets and do not change their owner's section boundary.
The marker ID remains the stable ownership identity when a user safely renames
the owning heading or inserts another same-named heading earlier in the note.
Malformed, nested, ambiguous, or boundary-crossing markers fail closed. Close
unclosed fences/HTML blocks and repair damaged marker pairs before retrying; do
not hand-author or duplicate the reserved `codex-note-helper:generated` markers.

`headingLevel` selects one exact Markdown heading level. ATX H1–H6 and Setext
H1–H2 are supported. Headings inside fenced code blocks are ignored, and a
section ends at the next heading of the same or a higher level.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `codexNoteHelper.mode` | `research` | Generation profile. |
| `codexNoteHelper.fillPolicy` | `emptyOnly` | Eligible heading sections. |
| `codexNoteHelper.researchField` | empty | Optional research context. |
| `codexNoteHelper.outputLanguage` | `Japanese` | Requested output language. |
| `codexNoteHelper.noteStyle` | empty | Optional style instruction. |
| `codexNoteHelper.headingLevel` | `1` | Exact Markdown heading level, H1–H6. |
| `codexNoteHelper.codexCommand` | `codex` | Machine-scoped CLI executable name or absolute path; arguments are not allowed. The resolved executable must be outside open workspace roots. |
| `codexNoteHelper.allowBundledCodexFromOpenAIExtension` | `false` | If the default `codex` command is absent from `PATH`, allow fallback to a compatible executable bundled with the OpenAI ChatGPT/Codex extension. |
| `codexNoteHelper.enableWebSearch` | `false` | Allow additional network search for source verification; enabled runs always require confirmation. |
| `codexNoteHelper.showCodexProgress` | `true` | Show throttled fixed-stage progress without raw commands, paths, or note text. |
| `codexNoteHelper.timeoutSeconds` | `300` | Abort a run after 30–1800 seconds. |
| `codexNoteHelper.maxTargetHeadings` | `25` | Refuse batches above the configured 1–200 target limit. |
| `codexNoteHelper.maxInputCharacters` | `500000` | Refuse larger active documents before starting Codex. |
| `codexNoteHelper.maxOutputBytes` | `1048576` | Abort and discard oversized CLI output. |
| `codexNoteHelper.confirmBeforeRun` | `appendAlways` | Confirm `always`, only for `appendAlways`, or skip routine confirmation. Web search and Codex user configuration still force confirmation. |
| `codexNoteHelper.ignoreCodexUserConfiguration` | `true` | Pass `--ignore-user-config` while retaining current CLI authentication; disabling it forces confirmation on every run. |

The extension always uses `--ephemeral`, `--ignore-rules`, a fixed output
schema, and a read-only sandbox. Disabling
`ignoreCodexUserConfiguration` allows supported user Codex defaults to affect
generation, but does not relax the sandbox, output schema, validation, or
application checks.

Executable-related settings are machine-scoped. A command name is resolved from
`PATH` before the optional bundled fallback. The extension resolves real paths,
rejects executable and supported npm-shim components inside open workspace
roots or directly beside the active note, and asks for explicit approval of a
fingerprint derived from their
resolved paths, sizes, modification times, and SHA-256 content digests. The
identity is rechecked after approval and immediately before generation. Any
change stops the run and requires a new resolution and approval.

Settings and Command Palette labels are localized in English and Japanese.

## Data and Consent

Before its first generation run, the extension explains that Codex receives:

- target indexes and heading titles,
- the existing Markdown in each selected section, including source bullets,
- mode, target policy, research field, requested language, and style,
- and the instruction needed to produce the structured proposal.

The workspace path, file path, and full note are not sent to Codex and are not
used as its working directory. Codex runs from an isolated directory under
extension-owned global storage; only the selected sections listed above are
placed on stdin. The CLI or configured provider may attach metadata about that
isolated runtime according to its own policy. Web search adds further network
activity and is disabled by default. Declining first-run consent makes no
changes and starts no process.

Before any CLI compatibility probe or generation process, a separate modal
identifies the resolved executable path and explains that generation can pass it
selected sections and that the process may receive Codex credentials from the
allowlisted environment. Approval is remembered only for that executable
fingerprint. Diagnostics uses the same executable approval gate.

See [SECURITY.md](SECURITY.md) before using confidential notes.

## Diagnostic Logs

Logs are stored under VS Code's extension-owned global storage, never in the
workspace. Error actions can open the current diagnostic log, and Diagnostics
reports whether an owned log is present; neither promises to print its exact
platform-specific path.

Logs always contain only bounded timestamps, sanitized status, counts, and
errors. Prompts, generated output, stderr, stack traces, heading titles,
arguments, and paths are never recorded.

Use `Codex Notes: Delete Diagnostic Log` to remove the owned log. The removed
v0.2 workspace-log setting is ignored; delete it from old settings files after
upgrading.

## Reproducible Development

Install dependencies from the committed lockfile:

```powershell
npm ci
npm run verify
npm run smoke:codex
npm run package:strict
```

`npm run verify` syntax-checks every repository JavaScript file and runs all
offline tests. `npm run test:vscode -- --version stable --vsix <file>` installs
the completed VSIX into an isolated VS Code profile and activates it.
`npm run smoke:codex` performs one small, isolated live CLI generation
against a synthetic heading; it requires Codex authentication and provider
network access. `vscode:prepublish` and `prepublishOnly` run the offline
verification before packaging or publication.
The extension has no production npm dependencies, so VSIX packaging disables
dependency discovery and includes only the explicitly listed extension files.

On Windows, a repository-local Node.js 22.22.3 runtime can be installed:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-local-node.ps1
.\scripts\npm-local.cmd ci
.\scripts\npm-local.cmd run verify
```

The setup script downloads the exact Windows x64 archive and verifies the
pinned SHA-256 before replacing `.tools/node`. To intentionally use another
version, pass both `-Version` and its trusted `-ExpectedSha256`.

GitHub Actions uses the same exact Node.js version, `npm ci`, verification, and
strict VSIX packaging on Linux, Windows, and macOS. It also installs and
activates the packaged VSIX on both VS Code 1.85.0 and the latest stable VS
Code. The manifest records npm 10.9.8 as the development package manager. Build
artifacts and local tools remain outside the VSIX.

## Release Checklist

1. Run `npm ci`.
2. Run `npm run verify`.
3. Run `npm run smoke:codex` once with the release Codex CLI.
4. Run `npm run package:strict`.
5. Install the generated VSIX in a disposable local workspace and a disposable
   remote workspace.
6. Test data and executable consent accept/decline, fingerprint changes,
   cancellation, timeout, forbidden-event rejection, invalid structured output,
   stale-document rejection, standalone files, diff/undo, and diagnostic-log
   deletion.
7. Confirm the Marketplace publisher, repository, issue tracker, English and
   Japanese labels, and privacy wording.
