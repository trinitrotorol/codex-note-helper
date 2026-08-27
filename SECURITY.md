# Security Notes

Codex Note Helper starts an external Codex CLI process and sends it information
from the active note. Treat it as an automation wrapper around the provider
configured for Codex, not as an offline or local-only model.

## Supported Versions

Security fixes are provided for the latest released version only. Version 0.3.4
uses the structured-proposal and validated-application design introduced in
0.3.0, retains recoverable pending reviews and allowlisted preflight reason
codes, and adds layout-preserving text-only Apply plus fail-closed save-state
reporting without weakening the review or logging boundaries. Its icon update
does not change the extension runtime or data-handling boundaries.

## Trust and Workspace Requirements

- The extension is disabled in untrusted workspaces.
- Virtual workspaces are unsupported.
- Only file-backed Markdown documents with a `file` or `vscode-remote` URI are
  accepted. A local or remote standalone file may be used without belonging to
  a workspace folder.
- Untitled, Git, diff, notebook-cell, and other virtual documents are rejected
  before Codex starts.
- The extension runs on the local or remote extension host. In Remote SSH, WSL,
  Dev Containers, and Codespaces, the remote environment must provide and
  authenticate Codex.

Workspace trust is not a statement that every note is harmless. Markdown
headings and note text are treated as untrusted data when the prompt is built.
Repository instruction files are ignored, and model output is not applied
until it passes structural and document-state validation.

## Data Sent to Codex

After mandatory first-run data consent, a generation run can send:

- target indexes and heading titles,
- existing Markdown from every selected section, including source bullets,
- configured mode, target policy, research field, output language, and style,
- and fixed instructions for the structured update proposal.

Workspace and file paths plus unselected note text are not placed in the prompt
or used as the working directory. Every selected section is placed on stdin; if
the target policy selects every matching section, their combined content can
contain most of the note. Codex runs in an isolated directory under
extension-owned global storage. The CLI or provider may attach metadata about
that isolated runtime under its own policy. It may send selected-section data to
its configured provider, whose retention and privacy policy are outside this
extension's control. Do not run it on confidential notes until that provider and
policy are acceptable.

Declining data consent starts no generation process and changes no file. The
Privacy Details action opens the `SECURITY.md` packaged with the installed
extension, rather than a mutable online copy. The target-summary confirmation
policy does not bypass first-run consent.

## Process Isolation

The extension fixes the following controls for every generation run:

- `codex exec` uses `--sandbox read-only`, so Codex cannot directly edit the
  note or other workspace files.
- the process working directory is an isolated runtime folder under extension
  global storage, not the workspace;
- `--ephemeral` prevents the run from persisting a normal Codex session.
- `--ignore-rules` prevents repository rule files from changing the task.
- `--json` and a fixed `--output-schema` constrain the response contract.
- approval mode is fixed to `never`;
- shell tools, apps, hooks, and multi-agent delegation are disabled;
- the executable is spawned without a shell;
- the child receives an allowlisted environment instead of the extension
  host's complete environment;
- document size, target count, captured output, and runtime are bounded;
- only one run per document is allowed.

The JSON event stream is checked whether or not progress notifications are
shown. Only expected lifecycle events, reasoning/todo items, one completed
agent message, and opt-in web search are accepted. Unknown events, failed
turns, errors, command execution, file changes, MCP, computer, dynamic, and
collaboration tool activity are rejected. Web-search events are rejected unless
web search is enabled. A structured final agent message is accepted only when
it is followed by a successful `turn.completed`, and later output is rejected;
a failed, incomplete, or ambiguous stream never produces an applicable
proposal.

`codexNoteHelper.ignoreCodexUserConfiguration` defaults to `true` and adds
`--ignore-user-config` while retaining the current Codex authentication. If the
setting is disabled, supported provider/model defaults may affect generation.
The read-only sandbox, ignored repository rules, schema, limits, and validation
remain fixed. Disabling this isolation, or enabling web search, forces a modal
target-summary confirmation on every run even when `confirmBeforeRun` is
`never`.

`codexNoteHelper.codexCommand`, the bundled-fallback switch, web-search access,
and user-configuration isolation are machine-scoped settings. The command
accepts only an executable name or absolute executable path; command-line
arguments are rejected. A name is resolved from `PATH` first. When the name is
the default `codex`, the optional bundled executable is considered only if no
PATH executable is found. The fallback is disabled by default and supports only
compatible platform/architecture combinations present in the OpenAI extension
bundle.

Resolved real paths are checked before execution. Executables and supported npm
shim, package, script, and Node components inside any open workspace root are
rejected. Executables directly beside the active note are also rejected for
standalone files without treating the user's entire home directory as a
workspace, so normal user-level CLI installations remain usable. Windows batch
and PowerShell scripts are not launched through a
shell; only a validated official `@openai/codex` npm command shim is converted
to its Node entry point. Before the first CLI probe or generation, a modal shows
the resolved entry path and asks the user to approve its fingerprint. The
fingerprint is derived from the resolved component paths, sizes, and
modification times plus SHA-256 content digests; an identity change requires
approval again. Every artifact is stat-checked around hashing, then the complete
identity is resolved again after a consent wait and immediately before
generation. A changed or transient executable is rejected before the next
process starts. Diagnostics is subject to the same executable approval gate.
The CLI-source chooser changes only machine-scoped extension settings. Selecting
the official OpenAI extension bundle requires a separate modal opt-in, and the
resolved executable still requires fingerprint approval and compatibility
probing. Missing-CLI remediation may open the bundled-fallback setting, but it
never enables that setting automatically.

Each run's temporary schema is kept in that isolated runtime folder, not the
workspace or shared operating-system temp directory. It contains only the
schema and target-index bounds, not note content, and is removed in a `finally`
cleanup after success, failure, or cancellation. Cleanup failure is reported
in the Diagnostics Output channel and never causes an unvalidated proposal to
be applied.

## Structured Output Validation

Codex returns a proposal shaped as:

```json
{
  "updates": [
    { "targetIndex": 0, "markdown": "generated Markdown" }
  ],
  "warnings": []
}
```

Before constructing a text-only `WorkspaceEdit`, the extension checks:

- JSON and schema validity;
- output byte and update-count limits;
- unique, in-range target indexes;
- required updates and allowed string values;
- control/bidirectional characters, raw HTML, malformed block structure, and
  obfuscated link destinations or explicit URI schemes other than HTTP(S)
  (relative and fragment links remain allowed);
- the current document URI, version, text, and target sections;
- generated-region marker integrity;
- and that edits are confined to the selected sections of the active document.

At most three warnings of at most 160 characters each are accepted, and all
accepted warnings are displayed beside the apply decision. Generated regions
use section ownership markers. Human-authored parent and child headings keep
separate owned blocks, while headings inside generated regions remain opaque to
target discovery. A safe rename or earlier duplicate-title insertion preserves
the existing marker as the stable identity; malformed, nested, ambiguous, or
boundary-crossing markers are rejected.

Malformed, duplicate, stale, incomplete, oversized, or out-of-scope proposals
are not applied. A zero exit code does not imply success. Cancellation, timeout,
process error, validation error, or a concurrent user edit applies nothing.

The extension captures the same open document instance, its in-memory version,
and its complete text before generation, then checks all three again before
review and application. This snapshot does not save the document, create a
source-control revision, or read repository history. Accepted changes replace
only the validated target ranges through one text-only `WorkspaceEdit`, which
uses VS Code's all-or-nothing application behavior and participates in normal
undo without opening, moving, or focusing an editor. The default
`codexNoteHelper.applySaveBehavior` leaves the result unsaved. Its opt-in mode
calls VS Code's normal document save only when the note was clean immediately
before Apply; it never writes around VS Code's save pipeline. VS Code Auto Save
and save-time formatters, code actions, listeners, or file watchers remain in
effect. The completion notice rechecks the same open document after diff cleanup;
if that document was closed or replaced, the extension treats its persisted state
as unknown and warns instead of reporting it as saved. A diff is mandatory before
the apply action is offered. Generated
Markdown can still contain inaccurate statements or misleading citations;
review it as untrusted generated content even after structural safety checks.

The Apply and Discard decision is stored only in extension-host memory while a
review is pending. Hiding, closing, or clearing the notification is not a
decision. The same proposal can be reopened through the status bar, editor-title
actions, or Command Palette without another Codex request. Each pending review
remains bound to the original document object, URI, in-memory version, complete
text snapshot, and preview URIs. Editing, closing, reopening, cancelling, or
deactivating invalidates it and removes the extension-owned preview content and
pending state. Apply performs the snapshot check again immediately before the
single workspace edit. When the review ends, only a diff tab whose two random
preview URIs exactly match that review is closed; unrelated tabs and editor
groups are not changed.

## Progress and Cancellation

Progress notifications use throttled, fixed stage names. Raw commands, paths,
prompts, model reasoning, and generated note text are not shown. Percentage
values are not presented as a provider guarantee.

`Codex Notes: Cancel Active Run` remains available when progress notifications
are disabled. Cancellation and Discard prevent generated edits from being
applied. If a preview has already opened, its VS Code editor may remain visible
until closed; the extension does not claim complete erasure from VS Code memory.

## Network Use

- The extension itself does not call the OpenAI API directly.
- The extension itself sends no separate analytics or usage telemetry.
- Codex may contact its configured provider.
- `codexNoteHelper.enableWebSearch` is disabled by default.
- Enabling web search permits additional search requests and data disclosure
  and forces confirmation on every run.
- Research mode does not require an unverifiable reference; a citation should
  be omitted or warned about when it cannot be checked.

## Diagnostic Logs

Diagnostic logs are stored only in extension-owned global storage. They always
contain bounded timestamps, process-start state, allowlisted phase/reason codes,
counts, and truncation flags only when a process started. Prompts, model output,
stdout, stderr, stack traces, paths, command arguments, headings, unknown error
codes, and raw error messages are never written. Version 0.3.4 does not create
or append a log in the workspace; the removed workspace-log setting is ignored.

- Log and notification strings are bounded.
- `Codex Notes: Delete Diagnostic Log` deletes only the extension-owned log.
- Error actions can open the current log, and Diagnostics reports whether it is
  present; the exact platform-specific storage path is not printed.

Review the diagnostic log before attaching it to an issue even though sensitive
fields are excluded by design.

## Reporting a Vulnerability

Use GitHub Security Advisories for private reports when available. If private
reporting is unavailable, open a minimal GitHub issue describing impact and
affected version without sharing notes, prompts, logs, tokens, paths, or
credentials.

Include:

- extension, VS Code, Codex CLI, and operating-system versions;
- local or remote workspace type;
- whether web search and user Codex configuration were enabled;
- confirmation, timeout, and size-limit settings;
- whether diagnostic-log truncation was reported; and
- whether the proposal was rejected before or after validation.

Before sharing any artifact, review the configured provider's retention policy,
the generated diff, diagnostic output, and the extension-owned log.
