# Security Notes

Research Note Helper is a VS Code extension that starts an external Codex CLI
process. Treat it as an automation wrapper around Codex, not as an offline or
local-only model.

## Supported Versions

Security fixes are provided for the latest released version only. If you are
using an older VSIX, upgrade to the latest release before reporting an issue
unless the vulnerability is specific to an older version.

## Reporting a Vulnerability

Use GitHub Security Advisories for this repository when private reporting is
available. If private reporting is not enabled yet, open a minimal GitHub issue
that describes the impact and affected version without sharing private notes,
logs, prompts, tokens, or credentials.

Please include:

- extension version,
- VS Code version,
- operating system,
- Codex CLI version,
- whether `researchNoteHelper.enableWebSearch` was enabled,
- whether `researchNoteHelper.logLevel` was `minimal` or `debug`.

Do not attach `research-note-helper.log` or a generated `.vsix` until the
maintainer explicitly asks for it.

## Data Flow

- The extension reads the active Markdown editor text to find target headings
  according to `researchNoteHelper.fillPolicy`.
- The extension sends Codex a prompt containing:
  - the target file path,
  - target heading titles, line numbers, and section state,
  - configured mode, fill policy, research field, language, and style settings.
- Codex is instructed to reread and edit the target Markdown file directly.
- Codex runs with `--sandbox workspace-write`, so it should be limited to the
  opened workspace by the Codex sandbox, but the model can still inspect files
  that Codex is allowed to read.
- When `researchNoteHelper.showCodexProgress` is enabled, the extension runs
  `codex exec --json` and uses JSONL event types to show approximate progress.
  Notifications intentionally show only safe activity summaries, not generated
  note text.

## Network Use

- The extension itself does not make network requests.
- Codex may contact its configured provider.
- `researchNoteHelper.enableWebSearch` is disabled by default. Turning it on
  passes `--search` to Codex and permits additional web search behavior.

## Logs

- Logs are written only on failure.
- Default `researchNoteHelper.logLevel` is `minimal`.
- Minimal logs avoid prompt text, stdout, stderr, and heading titles.
- `debug` logs include prompt, stdout, stderr, heading titles, and full paths;
  use it only for troubleshooting. When progress is enabled, stdout may include
  Codex JSONL events.
- Use `Research Notes: Delete Failure Log` to remove the configured log file.

## Local Execution

- The extension is disabled in untrusted workspaces.
- `researchNoteHelper.codexCommand` is treated as an executable name or path.
  Do not put shell arguments in this setting.
- The extension starts Codex without a shell to reduce command-injection risk.
- Fallback to a bundled `codex.exe` from the OpenAI ChatGPT/Codex extension is
  disabled by default and must be explicitly enabled.

## Before Publishing or Sharing Logs

- Do not publish workspace notes, generated logs, `.vsix` files, or temporary
  packaging folders unless you intend to share them.
- Review `research-note-helper.log` or any custom log path before attaching it
  to issues.
- Review the configured Codex provider and retention policy before using this
  extension with confidential research notes.
