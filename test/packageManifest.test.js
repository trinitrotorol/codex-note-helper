const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

function readPackageJson() {
  const packagePath = path.join(__dirname, "..", "package.json");
  return JSON.parse(fs.readFileSync(packagePath, "utf8"));
}

test("package manifest contributes the fill command and keybinding", () => {
  const manifest = readPackageJson();
  const commands = manifest.contributes.commands.map((item) => item.command);
  const keybindings = manifest.contributes.keybindings;
  const paletteCommands = manifest.contributes.menus.commandPalette.map(
    (item) => item.command
  );

  assert.equal(manifest.name, "codex-note-helper");
  assert.equal(manifest.displayName, "Codex Note Helper");
  assert.equal(manifest.publisher, "trinitrotorol");
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
  assert.deepEqual(manifest.keywords, [
    "codex",
    "markdown",
    "notes",
    "research",
    "vscode-extension"
  ]);
  assert.equal(manifest.activationEvents, undefined);
  assert.equal(commands.includes("codexNoteHelper.fillWithCodex"), true);
  assert.equal(commands.includes("codexNoteHelper.deleteFailureLog"), true);
  assert.equal(commands.includes("codexNoteHelper.setMode"), true);
  assert.equal(commands.includes("codexNoteHelper.setFillPolicy"), true);
  assert.equal(commands.includes("codexNoteHelper.openCodexRequest"), false);
  assert.equal(paletteCommands.includes("codexNoteHelper.runSelfTest"), true);
  assert.equal(
    paletteCommands.includes("codexNoteHelper.deleteFailureLog"),
    true
  );
  assert.equal(paletteCommands.includes("codexNoteHelper.setMode"), true);
  assert.equal(
    paletteCommands.includes("codexNoteHelper.setFillPolicy"),
    true
  );
  assert.deepEqual(keybindings[0], {
    command: "codexNoteHelper.fillWithCodex",
    key: "ctrl+k ctrl+q",
    mac: "cmd+k cmd+q",
    when: "editorTextFocus && editorLangId == markdown"
  });
});

test("package manifest keeps release tooling pinned and local", () => {
  const manifest = readPackageJson();

  assert.equal(manifest.scripts.test, "node --test");
  assert.equal(
    manifest.scripts.package,
    "vsce package --allow-missing-repository"
  );
  assert.equal(manifest.scripts["package:strict"], "vsce package");
  assert.equal(manifest.devDependencies["@vscode/vsce"], "3.9.1");
  assert.equal(manifest.scripts.package.includes("npx"), false);
});

test("package manifest disables untrusted workspaces", () => {
  const manifest = readPackageJson();
  const untrusted = manifest.capabilities.untrustedWorkspaces;

  assert.equal(untrusted.supported, false);
  assert.match(untrusted.description, /external Codex CLI process/);
  assert.match(untrusted.description, /disabled in untrusted workspaces/);
});

test("package manifest exposes logging configuration", () => {
  const manifest = readPackageJson();
  const properties = manifest.contributes.configuration.properties;

  assert.equal(
    properties["codexNoteHelper.logFileName"].default,
    "codex-note-helper.log"
  );
  assert.equal(properties["codexNoteHelper.mode"].default, "research");
  assert.deepEqual(properties["codexNoteHelper.mode"].enum, [
    "research",
    "general",
    "jobHunting"
  ]);
  assert.equal(
    properties["codexNoteHelper.fillPolicy"].default,
    "emptyOnly"
  );
  assert.deepEqual(properties["codexNoteHelper.fillPolicy"].enum, [
    "emptyOnly",
    "emptyOrBulletsOnly",
    "appendAlways"
  ]);
  assert.equal(properties["codexNoteHelper.enableWebSearch"].default, false);
  assert.equal(properties["codexNoteHelper.showCodexProgress"].default, true);
  assert.equal(properties["codexNoteHelper.logLevel"].default, "minimal");
  assert.equal(
    properties["codexNoteHelper.allowBundledCodexFromOpenAIExtension"].default,
    false
  );
});
