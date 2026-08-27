# TODO

## Make preflight failures actionable without leaking sensitive data

The `v0.3.0` failure log reduces every extension-side failure with a phase to a
generic entry such as `extension validation failure (preflight)`. This protects
private note data, but also discards the safe error code needed to distinguish a
missing Codex CLI from a rejected executable or an incompatible CLI.

- [x] Record only an allowlisted, stable error code and phase for extension-side
      failures (for example, `EXECUTABLE_NOT_FOUND` plus `preflight`). Never log
      raw error messages, stack traces, paths, arguments, headings, prompts,
      model output, `stdout`, or `stderr`.
- [x] When `codex` is absent from `PATH`, but the official `openai.chatgpt`
      extension contains a compatible bundled CLI and fallback is disabled,
      show a specific action that opens the
      `codexNoteHelper.allowBundledCodexFromOpenAIExtension` setting. Do not
      enable the fallback automatically or bypass executable fingerprint
      consent.
- [x] State whether a Codex process was started. Do not emit misleading
      `stdout truncated: false` and `stderr truncated: false` fields when no
      process existed.
- [x] Keep the user-facing notification, diagnostics channel, and owned failure
      log consistent about the safe reason and suggested remediation.
- [x] Add regression tests proving that the safe code and remediation survive
      logging while secrets, note content, paths, raw process output, and stack
      traces never do.

Verification status for 0.3.1:

- [x] Cross-platform unit and packaged-extension gates, plus installed-VSIX
      activation on Windows with VS Code 1.85.0 and current stable.
- [ ] Run one manual diagnostics check on Windows with `codex` absent from
      `PATH` and available only through a real installed official OpenAI VS Code
      extension. The automated tests use a synthetic bundle layout and prove
      that opt-in never starts a process or bypasses fingerprint consent.

## Keep review actions visible and recoverable

The `v0.3.0` review flow exposes `Apply changes` and `Discard` only as actions
on a non-modal information notification. VS Code can automatically hide that
toast while the user is reading the diff, leaving the critical decision hard to
find in the Notification Center. Closing or clearing the notification also
looks like an intentional discard even though no explicit decision was made.

- [x] Add persistent `Apply` and `Discard` actions associated with the generated
      diff, such as editor-title actions or an equivalent review UI that remains
      visible while the diff is open. Do not use a blocking modal that prevents
      the user from inspecting the diff.
- [x] Keep explicit commands available for the active pending review so it can
      be recovered from the Command Palette or a status-bar entry after a toast
      is hidden.
- [x] Treat notification hiding, closing, or clearing as dismissal of the toast,
      not as an implicit `Discard`. Applying and discarding must be explicit
      user decisions.
- [x] Bind each pending proposal to the original document URI, text, and version;
      invalidate it immediately if the document changes, closes, or is reopened.
      Never apply a stale proposal.
- [x] Remove preview content and pending in-memory state after apply, discard,
      invalidation, cancellation, or extension deactivation.
- [x] Add integration tests for automatic toast hiding, Notification Center
      recovery, explicit command recovery, explicit discard, stale-document
      rejection, and cleanup. Verify that recovering a pending review does not
      start another Codex generation or consume additional usage.

The separate Marketplace authentication migration remains tracked in
[RELEASE_AUTH.md](RELEASE_AUTH.md#direct-marketplace-oidc-migration-todo).
