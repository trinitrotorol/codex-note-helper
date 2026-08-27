const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const repoRoot = path.join(__dirname, "..");

function readJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(repoRoot, relativePath), "utf8")
  );
}

function readPackageJson() {
  return readJson("package.json");
}

function collectLocalizationKeys(value, result = new Set()) {
  if (typeof value === "string") {
    const match = value.match(/^%([^%]+)%$/);
    if (match) {
      result.add(match[1]);
    }
    return result;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectLocalizationKeys(item, result));
    return result;
  }

  if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectLocalizationKeys(item, result));
  }

  return result;
}

test("package manifest contributes the v0.3 commands without a conflicting keybinding", () => {
  const manifest = readPackageJson();
  const commandItems = manifest.contributes.commands;
  const commands = commandItems.map((item) => item.command);
  const paletteCommands = manifest.contributes.menus.commandPalette.map(
    (item) => item.command
  );

  assert.equal(manifest.name, "codex-note-helper");
  assert.equal(manifest.version, "0.3.4");
  assert.equal(manifest.displayName, "%extension.displayName%");
  assert.equal(manifest.l10n, "./l10n");
  assert.equal(manifest.icon, "media/icon.png");
  assert.deepEqual(manifest.galleryBanner, {
    color: "#0b1020",
    theme: "dark"
  });
  assert.equal(manifest.publisher, "trinitrotorol");
  assert.equal(manifest.pricing, "Free");
  assert.deepEqual(manifest.categories, ["AI", "Education", "Other"]);
  for (const keyword of [
    "ai-notes",
    "codex-cli",
    "markdown-notes",
    "note-taking",
    "research-notes"
  ]) {
    assert.ok(manifest.keywords.includes(keyword), `missing keyword: ${keyword}`);
  }
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "https://github.com/trinitrotorol/codex-note-helper.git"
  });
  assert.deepEqual(manifest.bugs, {
    url: "https://github.com/trinitrotorol/codex-note-helper/issues"
  });
  assert.equal(
    manifest.homepage,
    "https://github.com/trinitrotorol/codex-note-helper#readme"
  );
  assert.deepEqual(manifest.activationEvents, [
    "onCommand:codexNoteHelper.listEmptyHeadings",
    "onCommand:codexNoteHelper.runSelfTest"
  ]);
  assert.equal(manifest.contributes.keybindings, undefined);

  assert.deepEqual(commands, [
    "codexNoteHelper.fillWithCodex",
    "codexNoteHelper.cancelRun",
    "codexNoteHelper.reopenPendingReview",
    "codexNoteHelper.applyPendingReview",
    "codexNoteHelper.discardPendingReview",
    "codexNoteHelper.listTargetHeadings",
    "codexNoteHelper.deleteFailureLog",
    "codexNoteHelper.setMode",
    "codexNoteHelper.setFillPolicy",
    "codexNoteHelper.runDiagnostics",
    "codexNoteHelper.chooseCliSource"
  ]);
  assert.equal(commands.includes("codexNoteHelper.listEmptyHeadings"), false);
  assert.equal(commands.includes("codexNoteHelper.runSelfTest"), false);
  assert.equal(commands.includes("codexNoteHelper.openCodexRequest"), false);
  assert.deepEqual(paletteCommands, commands);

  const fillCommand = commandItems.find(
    (item) => item.command === "codexNoteHelper.fillWithCodex"
  );
  assert.match(fillCommand.enablement, /editorLangId == markdown/);
  assert.match(fillCommand.enablement, /resourceExtname == \.md/);
  assert.match(fillCommand.enablement, /resourceScheme == file/);
  assert.match(fillCommand.enablement, /resourceScheme == vscode-remote/);
  assert.match(fillCommand.enablement, /isWorkspaceTrusted/);
  const cancelCommand = commandItems.find(
    (item) => item.command === "codexNoteHelper.cancelRun"
  );
  assert.equal(cancelCommand.enablement, undefined);
  const cancelPaletteItem = manifest.contributes.menus.commandPalette.find(
    (item) => item.command === "codexNoteHelper.cancelRun"
  );
  assert.equal(cancelPaletteItem.when, undefined);

  const reviewCommands = [
    "codexNoteHelper.reopenPendingReview",
    "codexNoteHelper.applyPendingReview",
    "codexNoteHelper.discardPendingReview"
  ];
  for (const command of reviewCommands) {
    const paletteItem = manifest.contributes.menus.commandPalette.find(
      (item) => item.command === command
    );
    assert.equal(paletteItem.when, "codexNoteHelper.hasPendingReview");
    const editorTitleItem = manifest.contributes.menus["editor/title"].find(
      (item) => item.command === command
    );
    assert.match(
      editorTitleItem.when,
      /codexNoteHelper\.activeEditorHasPendingReview/u
    );
    assert.match(editorTitleItem.when, /codex-note-helper-preview/u);
  }

  const [walkthrough] = manifest.contributes.walkthroughs;
  assert.equal(walkthrough.id, "codexNoteHelper.gettingStarted");
  assert.equal(walkthrough.steps.length, 4);
  for (const step of walkthrough.steps) {
    const mediaPath = step.media.markdown || step.media.image;
    assert.ok(fs.existsSync(path.join(repoRoot, mediaPath)), mediaPath);
    assert.ok(step.completionEvents.length > 0);
  }

  const icon = fs.readFileSync(path.join(repoRoot, manifest.icon));
  assert.equal(icon.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(icon.readUInt32BE(16), 256);
  assert.equal(icon.readUInt32BE(20), 256);
});

test("package manifest runs syntax checks and tests before publication", () => {
  const manifest = readPackageJson();
  const setupScript = fs.readFileSync(
    path.join(repoRoot, "scripts", "setup-local-node.ps1"),
    "utf8"
  );
  const workflow = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "ci.yml"),
    "utf8"
  );
  const releaseWorkflow = fs.readFileSync(
    path.join(repoRoot, ".github", "workflows", "release.yml"),
    "utf8"
  );

  assert.equal(manifest.scripts.test, "node --test");
  assert.equal(
    manifest.scripts["test:vscode"],
    "node test/vscode/run-vscode-tests.js"
  );
  assert.equal(
    manifest.scripts["check:syntax"],
    "node scripts/verify.js --syntax-only"
  );
  assert.equal(manifest.scripts.verify, "node scripts/verify.js");
  assert.equal(manifest.scripts["vscode:prepublish"], "npm run verify");
  assert.equal(manifest.scripts.prepublishOnly, "npm run verify");
  assert.equal(
    manifest.scripts.package,
    "vsce package --allow-missing-repository --no-dependencies"
  );
  assert.equal(
    manifest.scripts["package:strict"],
    "vsce package --no-dependencies"
  );
  assert.equal(manifest.packageManager, "npm@10.9.8");
  assert.equal(manifest.engines.node, ">=22");
  assert.equal(manifest.devDependencies["@vscode/vsce"], "3.9.1");
  assert.equal(manifest.devDependencies["@vscode/test-electron"], "3.1.0");
  assert.equal(manifest.devDependencies.jszip, "3.10.1");
  assert.equal(manifest.scripts.package.includes("npx"), false);
  assert.match(setupScript, /Version = "22\.22\.3"/u);
  assert.match(
    setupScript,
    /6c8d54f635feff4df76c2ca80f45332eb2ff57d25226edce36592e51a177ee33/u
  );
  assert.match(setupScript, /expected 10\.9\.8/u);
  assert.match(workflow, /node-version: "22\.22\.3"/u);
  assert.match(workflow, /npm ci --ignore-scripts/u);
  assert.match(workflow, /npm run verify/u);
  assert.match(workflow, /npm run package:strict/u);
  assert.match(workflow, /os: \[ubuntu-latest, windows-latest, macos-latest\]/u);
  assert.match(workflow, /vscode-version: \["1\.85\.0", "stable"\]/u);
  assert.match(workflow, /npm run test:vscode/u);
  for (const workflowSource of [workflow, releaseWorkflow]) {
    assert.doesNotMatch(
      workflowSource,
      /uses:\s+[^\s@]+@v\d+/u,
      "GitHub Actions must be pinned to immutable commit SHAs"
    );
    assert.match(workflowSource, /persist-credentials: false/u);
  }
  assert.match(
    workflow,
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u
  );
  assert.match(releaseWorkflow, /VSCE_PAT must be configured/u);
  assert.match(releaseWorkflow, /--packagePath/u);
  assert.match(releaseWorkflow, /npm run test:vscode/u);
  assert.match(releaseWorkflow, /needs: \[verify-platforms, verify-extension-host\]/u);
  assert.match(
    releaseWorkflow,
    /os: \[ubuntu-latest, windows-latest, macos-latest\]/u
  );
  assert.match(releaseWorkflow, /vscode-version: \["1\.85\.0", "stable"\]/u);
  assert.match(releaseWorkflow, /--draft/u);
  assert.match(releaseWorkflow, /--draft=false/u);
  assert.match(releaseWorkflow, /gh release create/u);
  assert.match(releaseWorkflow, /group: release-\$\{\{ github\.ref \}\}/u);
  assert.match(releaseWorkflow, /git merge-base --is-ancestor/u);
  assert.match(releaseWorkflow, /mode=resume-draft/u);
  assert.match(releaseWorkflow, /mode=repair-draft/u);
  assert.match(releaseWorkflow, /public GitHub release already exists and is immutable/u);
  assert.match(releaseWorkflow, /gh release upload/u);
  assert.match(releaseWorkflow, /--clobber/u);
  assert.match(releaseWorkflow, /--compressed/u);
  assert.match(releaseWorkflow, /marketplace-existing\.vsix/u);
  assert.match(releaseWorkflow, /compare-vsix-payload\.js/u);
  assert.match(releaseWorkflow, /test "\$GITHUB_REF_NAME" = "v\$\{version\}"/u);
  assert.ok(
    releaseWorkflow.indexOf("--draft") <
      releaseWorkflow.indexOf("vsce publish"),
    "the GitHub release must remain a draft until Marketplace publication"
  );
  assert.ok(
    releaseWorkflow.indexOf("vsce publish") <
      releaseWorkflow.indexOf("--draft=false"),
    "the GitHub release must be published only after Marketplace publication"
  );
});

test("package manifest runs beside file-backed workspaces only", () => {
  const manifest = readPackageJson();

  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, false);
  assert.equal(manifest.capabilities.virtualWorkspaces.supported, false);
  assert.equal(
    manifest.capabilities.untrustedWorkspaces.description,
    "%capabilities.untrustedWorkspaces.description%"
  );
  assert.equal(
    manifest.capabilities.virtualWorkspaces.description,
    "%capabilities.virtualWorkspaces.description%"
  );
});

test("package manifest exposes bounded and reviewable generation settings", () => {
  const manifest = readPackageJson();
  const properties = manifest.contributes.configuration.properties;

  assert.equal(properties["codexNoteHelper.mode"].default, "research");
  assert.deepEqual(properties["codexNoteHelper.mode"].enum, [
    "research",
    "general",
    "jobHunting"
  ]);
  assert.equal(
    properties["codexNoteHelper.mode"].enumDescriptions.length,
    properties["codexNoteHelper.mode"].enum.length
  );

  assert.equal(properties["codexNoteHelper.fillPolicy"].default, "emptyOnly");
  assert.deepEqual(properties["codexNoteHelper.fillPolicy"].enum, [
    "emptyOnly",
    "emptyOrBulletsOnly",
    "appendAlways"
  ]);
  assert.equal(properties["codexNoteHelper.headingLevel"].type, "integer");
  assert.equal(
    properties["codexNoteHelper.outputLanguage"].default,
    "%configuration.outputLanguage.default%"
  );
  assert.deepEqual(
    properties["codexNoteHelper.headingLevel"].enum,
    [1, 2, 3, 4, 5, 6]
  );

  assert.equal(properties["codexNoteHelper.timeoutSeconds"].default, 300);
  assert.equal(properties["codexNoteHelper.maxTargetHeadings"].default, 25);
  assert.equal(properties["codexNoteHelper.maxInputCharacters"].default, 500000);
  assert.equal(properties["codexNoteHelper.maxOutputBytes"].default, 1048576);
  assert.deepEqual(properties["codexNoteHelper.confirmBeforeRun"].enum, [
    "always",
    "appendAlways",
    "never"
  ]);
  assert.equal(
    properties["codexNoteHelper.confirmBeforeRun"].default,
    "appendAlways"
  );
  assert.equal(
    properties["codexNoteHelper.applySaveBehavior"].default,
    "leaveUnsaved"
  );
  assert.deepEqual(properties["codexNoteHelper.applySaveBehavior"].enum, [
    "leaveUnsaved",
    "saveIfCleanBeforeApply"
  ]);
  assert.equal(
    properties["codexNoteHelper.applySaveBehavior"].scope,
    "resource"
  );
  assert.equal(properties["codexNoteHelper.showDiffAfterRun"], undefined);
  assert.equal(
    properties["codexNoteHelper.ignoreCodexUserConfiguration"].default,
    true
  );
  assert.equal(properties["codexNoteHelper.enableWebSearch"].default, false);
  assert.equal(properties["codexNoteHelper.showCodexProgress"].default, true);
  assert.equal(
    properties["codexNoteHelper.allowBundledCodexFromOpenAIExtension"].default,
    false
  );
  for (const setting of [
    "codexNoteHelper.codexCommand",
    "codexNoteHelper.allowBundledCodexFromOpenAIExtension",
    "codexNoteHelper.enableWebSearch",
    "codexNoteHelper.ignoreCodexUserConfiguration"
  ]) {
    assert.equal(properties[setting].scope, "machine");
  }
  assert.equal(properties["codexNoteHelper.logFileName"], undefined);
  assert.equal(properties["codexNoteHelper.logLevel"], undefined);

  Object.values(properties).forEach((property) => {
    assert.equal(typeof property.markdownDescription, "string");
    if (property.enum) {
      assert.equal(property.enumDescriptions.length, property.enum.length);
      if (property.enumItemLabels) {
        assert.equal(property.enumItemLabels.length, property.enum.length);
      }
    }
  });
});

test("English and Japanese package localization catalogs are complete", () => {
  const manifest = readPackageJson();
  const english = readJson("package.nls.json");
  const japanese = readJson("package.nls.ja.json");
  const referencedKeys = [...collectLocalizationKeys(manifest)].sort();

  assert.deepEqual(Object.keys(japanese).sort(), Object.keys(english).sort());
  assert.deepEqual(Object.keys(english).sort(), referencedKeys);
  referencedKeys.forEach((key) => {
    assert.equal(typeof english[key], "string", `missing English key: ${key}`);
    assert.equal(typeof japanese[key], "string", `missing Japanese key: ${key}`);
    assert.notEqual(english[key].trim(), "", `empty English key: ${key}`);
    assert.notEqual(japanese[key].trim(), "", `empty Japanese key: ${key}`);
  });
});
