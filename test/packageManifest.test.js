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

  assert.equal(manifest.name, "research-note-helper");
  assert.equal(manifest.displayName, "Research Note Helper");
  assert.equal(manifest.publisher, "trinitrotorol");
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "https://github.com/trinitrotorol/research-note-helper.git"
  });
  assert.deepEqual(manifest.bugs, {
    url: "https://github.com/trinitrotorol/research-note-helper/issues"
  });
  assert.equal(
    manifest.homepage,
    "https://github.com/trinitrotorol/research-note-helper#readme"
  );
  assert.deepEqual(manifest.keywords, [
    "codex",
    "markdown",
    "notes",
    "research",
    "vscode-extension"
  ]);
  assert.equal(commands.includes("researchNoteHelper.fillWithCodex"), true);
  assert.equal(commands.includes("researchNoteHelper.deleteFailureLog"), true);
  assert.equal(commands.includes("researchNoteHelper.setMode"), true);
  assert.equal(commands.includes("researchNoteHelper.setFillPolicy"), true);
  assert.equal(commands.includes("researchNoteHelper.openCodexRequest"), false);
  assert.equal(paletteCommands.includes("researchNoteHelper.runSelfTest"), true);
  assert.equal(
    paletteCommands.includes("researchNoteHelper.deleteFailureLog"),
    true
  );
  assert.equal(paletteCommands.includes("researchNoteHelper.setMode"), true);
  assert.equal(
    paletteCommands.includes("researchNoteHelper.setFillPolicy"),
    true
  );
  assert.deepEqual(keybindings[0], {
    command: "researchNoteHelper.fillWithCodex",
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
    properties["researchNoteHelper.logFileName"].default,
    "research-note-helper.log"
  );
  assert.equal(properties["researchNoteHelper.mode"].default, "research");
  assert.deepEqual(properties["researchNoteHelper.mode"].enum, [
    "research",
    "general",
    "jobHunting"
  ]);
  assert.equal(
    properties["researchNoteHelper.fillPolicy"].default,
    "emptyOnly"
  );
  assert.deepEqual(properties["researchNoteHelper.fillPolicy"].enum, [
    "emptyOnly",
    "emptyOrBulletsOnly",
    "appendAlways"
  ]);
  assert.equal(properties["researchNoteHelper.enableWebSearch"].default, false);
  assert.equal(properties["researchNoteHelper.showCodexProgress"].default, true);
  assert.equal(properties["researchNoteHelper.logLevel"].default, "minimal");
  assert.equal(
    properties["researchNoteHelper.allowBundledCodexFromOpenAIExtension"].default,
    false
  );
});
