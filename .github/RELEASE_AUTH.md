# Release authentication

This document applies to releases after `v0.3.0`. The existing `v0.3.0` tag is
immutable and must not be moved or recreated to pick up workflow-only changes.

## Current mode: short-lived Global PAT

Automated Marketplace publication currently uses a Visual Studio Marketplace
Global Personal Access Token. Global PATs are retired on December 1, 2026, so
this is a time-bounded compatibility mode rather than the long-term design.

Configure GitHub as follows:

1. Use the publisher owner's existing Azure DevOps organization. Do not create
   a new organization, Azure subscription, or paid resource for release
   authentication.
2. For each release, create a new Global PAT with **Organization** set to
   **All accessible organizations** and only the Marketplace **Manage** scope.
   Its lifetime must be no more than 48 hours and its expiry must never be
   later than November 30, 2026.
3. Add that PAT as the `VSCE_PAT` **repository secret**, not an organization
   secret, immediately before the release. Record its expiry outside the
   repository.
4. After the Marketplace payload and GitHub release are verified, immediately
   revoke the PAT in Azure DevOps and delete the `VSCE_PAT` repository secret.
   Create a fresh short-lived PAT only when the next release needs one.
5. Require CODEOWNERS review for workflow, lockfile, and release-authentication
   changes through the default-branch ruleset.

If direct Marketplace OIDC has not replaced the PAT path, stop all publication
on December 1, 2026. Do not mint, renew, or extend a Global PAT beyond the
deadline. A stopped publication must leave the GitHub release as a draft.

The workflow maps `VSCE_PAT` only into the conditional Marketplace publication
step, after a secret-free lookup establishes that publication is necessary.
`vsce` reads it from the environment; the token is not passed as a command-line
argument. The pre-publication lookup and post-publication GET and payload
comparison receive no secret. The PAT must never be printed, copied to an
output, placed in an artifact, or used as a fallback after another
authentication method fails. If the secret is absent or expired, publication
must fail closed and leave the GitHub release as a draft. Revoke and delete the
PAT after a failed attempt as well; never retain it for a later release.

The workflow-level token has `contents: read`. Only the release job receives
`contents: write`, which it needs to prepare and publish the GitHub release.
No job currently receives `id-token: write`.

## Direct Marketplace OIDC migration TODO

Direct Marketplace trusted publishing is the intended end state because it
does not require an Azure subscription, Azure CLI session, client secret, or
stored PAT. Do not use an unreleased `@vscode/vsce` build or source from its
default branch in the release workflow.

Migrate only after all of these readiness gates are met:

- [ ] A pinned stable `@vscode/vsce` version exposes `publish --oidc` in its
      installed CLI and documents Marketplace trusted publishing.
- [ ] The stable Visual Studio Marketplace UI exposes trusted-publishing policy
      configuration and it can be bound to the exact repository and workflow.
- [ ] The documented GA policy shape is reviewed before adding any GitHub
      Environment or Marketplace policy fields; do not guess them in advance.
- [ ] Marketplace publication is moved into a dedicated job with only
      `contents: read` and `id-token: write`.
- [ ] GitHub Release finalization is kept in a separate job with
      `contents: write` and no `id-token` permission.
- [ ] The Marketplace job verifies the downloaded VSIX checksum and payload
      before requesting an OIDC token.
- [ ] The `VSCE_PAT` workflow mapping and GitHub repository secret are removed
      in the same reviewed change, and any remaining Global PAT is revoked or
      deleted in Azure DevOps. There is no PAT fallback.
- [ ] A new version tag, never a moved existing tag, exercises the new path.

Dependabot already checks stable npm updates weekly. Review each
`@vscode/vsce` update for the documented stable OIDC capability and inspect the
installed `publish --help` output. An automated flag-only readiness check is
not sufficient: it cannot verify the remote Marketplace policy, repository and
workflow binding, Environment protection, or end-to-end token exchange.

The current pinned `@vscode/vsce` 3.9.1 supports `--azure-credential` but not
direct `--oidc`. The Entra/Azure credential path is intentionally not adopted
for this repository because the owner does not have an Azure subscription.

Authoritative references:

- [Publish a VS Code extension and create the Marketplace PAT](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token)
- [Global PAT retirement schedule](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/)

## Release invariants

- Build and test the tagged commit, not the default branch tip.
- Require the tag commit to be contained in `main` and revalidate the remote tag
  immediately before external publication.
- Compare an existing Marketplace version's extension payload with the tested
  VSIX; never treat a duplicate version as success without comparison.
- Publish the GitHub draft only after Marketplace publication is verified.
- Keep actions pinned to immutable commit SHAs and install npm dependencies from
  the committed lockfile with lifecycle scripts disabled.
