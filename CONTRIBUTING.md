# Contributing

Contributions are welcome when they preserve Codex Note Helper's fail-closed,
review-before-apply design. Open an issue before a large behavior or security
change so the threat model can be agreed first.

## Prerequisites

- Node.js 22.22.3
- npm 10.9.8
- VS Code 1.85.0 or newer for installed-extension tests

Install exactly the committed dependency graph:

```powershell
npm ci --ignore-scripts
```

On Windows, the repository-local pinned runtime can be installed with:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-local-node.ps1
.\scripts\npm-local.cmd ci --ignore-scripts
```

The setup script verifies the pinned Node.js archive checksum before replacing
`.tools/node`.

## Offline verification

```powershell
npm run verify
npm run package:strict -- --out codex-note-helper-test.vsix
```

`verify` checks every repository JavaScript file and runs the offline test suite.
`package:strict` runs the same prepublish gate and applies the repository's
`.vscodeignore` denylist. It is not a file allowlist, so inspect the printed VSIX
file list for unexpected files before installing it.

Test the installed package in an isolated VS Code profile:

```powershell
npm run test:vscode -- --version stable --vsix codex-note-helper-test.vsix
```

GitHub Actions repeats verification and strict packaging on Linux, Windows, and
macOS, then installs the VSIX on VS Code 1.85.0 and current stable.

## Optional live smoke test

```powershell
npm run smoke:codex
```

This command submits one small synthetic generation request through the
configured Codex CLI. It needs provider network access and may consume Codex
usage allowance. Never run it merely as an offline verification step, and never
replace the synthetic fixture with real note content.

## Security-sensitive changes

Changes to process execution, prompts, generated-output validation, logging,
review state, settings, workflows, or dependencies require tests proving that:

- untrusted, virtual, and unsupported documents fail before Codex starts;
- paths, credentials, note text, prompts, model output, stdout, stderr, and stack
  traces do not enter owned logs;
- executable resolution remains outside workspaces and requires fingerprint
  approval after every identity change;
- Codex cannot execute shell, file-change, app, hook, MCP, computer, dynamic, or
  multi-agent activity;
- stale or closed documents cannot be edited;
- notification dismissal is not interpreted as Apply or Discard; and
- cleanup removes proposal content and in-memory review state after every
  terminal outcome.

Use synthetic paths and content in tests and screenshots. Review every frame of
Marketplace media; do not capture account names, email addresses, local paths,
tokens, notifications, real notes, or provider output. The committed media
generator produces synthetic, metadata-free assets.

## Release checklist

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` to the same
   version.
2. Run `npm ci --ignore-scripts` from the committed lockfile.
3. Run `npm run verify` and strict VSIX packaging.
4. Inspect and test the completed VSIX in disposable local and remote
   workspaces.
5. Deliberately run the live smoke test once only when its network request and
   usage are authorized.
6. Test data and executable consent accept/decline, CLI-source remediation,
   cancellation, timeout, policy rejection, stale-document rejection,
   persistent review recovery, explicit Apply/Discard, undo, and owned-log
   deletion.
7. Confirm publisher, Marketplace copy, English/Japanese catalogs, pricing
   wording, demo media, repository metadata, and security disclosures.
8. Push the reviewed commit to `main`, create a new immutable `vX.Y.Z` tag, and
   let the pinned release workflow build and publish the tagged source.
9. Verify the public Marketplace package matches the tested VSIX before making
   the GitHub draft public.

Marketplace authentication is time-bounded and documented separately in
[`.github/RELEASE_AUTH.md`](.github/RELEASE_AUTH.md). Do not invent or broaden
credentials, print tokens, move an existing tag, or bypass the workflow's draft
and payload-comparison gates.

## Reporting issues

Include extension, VS Code, Codex CLI, operating-system, and local/remote host
versions plus a minimal synthetic reproduction. Never attach note content,
prompts, full paths, raw output, credentials, or tokens. Use GitHub Security
Advisories when private reporting is available; otherwise open a minimal issue
without sensitive data.
