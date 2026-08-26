# Changelog

## 0.3.0

- Replace direct Codex file editing with a fixed structured-output contract,
  strict validation, and target-range application through VS Code
  `TextEditor.edit`.
- Open the mandatory diff beside the source preview and reacquire a live source
  editor before apply, avoiding preview-tab replacement and stale editor edits.
- Run Codex in a read-only, ephemeral sandbox with repository rules ignored;
  ignore user Codex configuration by default while retaining authentication.
- Use an isolated extension-storage runtime directory instead of the workspace
  as Codex's working directory; send only selected section data on stdin.
- Add mandatory first-run data consent with packaged privacy details,
  configurable target-summary confirmation, bounded input/targets/output/runtime,
  per-document run locking, cancellation, stale-document rejection, and a
  mandatory pre-apply diff with an explicit apply/discard decision. Web search
  or Codex user configuration now forces confirmation on every run.
- Resolve the machine-scoped Codex executable from `PATH` before an optional
  OpenAI-extension fallback, reject resolved executable components inside open
  workspaces or directly beside a standalone note, and require explicit
  fingerprint approval again when its identity changes.
- Validate every Codex JSON event even when progress UI is disabled, reject
  unknown events, failed turns, prohibited tool activity, and output after
  completion, and require the final agent message to precede a successful
  `turn.completed` event.
- Limit warnings to three strings of 160 characters and show all of them at the
  apply decision. Use section-ID ownership markers so parent and child headings
  keep independent generated blocks; generated headings are opaque, and safe
  user heading renames preserve the marker as a stable ownership identity.
- Reject generated raw HTML, control/bidirectional characters (including in
  warnings), damaged block structure, obfuscated destinations, and explicit
  URI schemes other than HTTP(S). Fail closed on
  malformed, nested, ambiguous, or boundary-crossing ownership markers with a
  document-specific recovery message.
- Move diagnostic logs from the workspace to extension-owned global storage,
  make sanitization unconditional, and remove the old log settings.
- Run on local and remote extension hosts for file-backed Markdown documents,
  including standalone files; explicitly reject untrusted, virtual, untitled,
  Git, and diff documents.
- Rename the visible commands to `Generate and Review Target Heading Updates`,
  `List Target Headings`, and `Run Diagnostics`,
  retain their old command IDs as hidden runtime aliases, and add
  `Cancel Active Run`.
- Remove the conflicting `Ctrl+K Ctrl+Q` / `Cmd+K Cmd+Q` default keybinding.
- Localize manifest commands and settings in English and Japanese, add readable
  enum labels and descriptions, and constrain `headingLevel` to integer H1–H6.
- Add a dedicated high-contrast Marketplace and extension-list icon.
- Add pinned, hash-verified local Node.js setup, repository-wide JavaScript
  syntax verification, prepublish checks, immutable GitHub Actions, Dependabot,
  cross-platform verification, strict VSIX packaging, and installed-VSIX tests
  on VS Code 1.85.0 and latest stable.
- Make tagged publication single-flight and immutable: tags must point into
  `main`, every retry rebuilds the tagged source and compares its payload with
  any draft asset, partial or mismatched drafts are repaired, the remote tag is
  revalidated, and an existing Marketplace version must have the same extension
  payload before the GitHub draft can be published.
- Bound the active generation deadline across executable resolution, probing,
  and generation while excluding user consent/review time. Fingerprint all
  executable artifacts with SHA-256 and revalidate after consent and before
  generation to reject content replacement races.
- Bound Windows process-tree teardown and its `taskkill` helper so cancellation
  or timeout cannot remain blocked by a hung termination subprocess.
- Restrict runtime Diagnostics to settings, extension storage, executable
  permission and CLI compatibility, isolation state, and diagnostic-log
  presence; diagnostics is single-flight and cancelled during extension
  deactivation. Temporary schema cleanup failures are written to its Output
  channel.
- Release per-document concurrency slots before terminal notifications are
  dismissed, so an unattended success/error message cannot block another run
  or extension deactivation.
- Cancel an active run as soon as its source document changes or closes, while
  ignoring the extension's own validated apply edit. Concurrent cancellation
  choices now show a shortened parent location for duplicate filenames.

## 0.2.2

- Rename the extension to Codex Note Helper to reflect non-research note modes.
- Add progress notifications for `codex exec --json`.
- Add privacy-preserving minimal failure logs.
- Add commands for deleting failure logs, changing mode, changing fill policy,
  and running self tests.
- Add job-hunting note mode and bullets-only append support.
