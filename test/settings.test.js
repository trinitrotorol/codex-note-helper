"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isSupportedDocumentScheme,
  normalizeCodexCommand,
  shouldConfirmRun,
  validateOptions
} = require("../lib/settings");

test("validateOptions supplies safe defaults", () => {
  const options = validateOptions({});
  assert.equal(options.headingLevel, 1);
  assert.equal(options.timeoutSeconds, 300);
  assert.equal(options.maxTargetHeadings, 25);
  assert.equal(options.outputLanguage, "English");
  assert.equal(options.ignoreCodexUserConfiguration, true);
  assert.equal(options.showCodexProgress, true);
  assert.equal(options.showDiffAfterRun, undefined);
  assert.equal(options.logLevel, undefined);
});

test("validateOptions rejects fractional heading levels and invalid ranges", () => {
  assert.throws(() => validateOptions({ headingLevel: 2.5 }), /headingLevel/u);
  assert.throws(() => validateOptions({ timeoutSeconds: 5 }), /timeoutSeconds/u);
  assert.throws(
    () => validateOptions({ maxTargetHeadings: 0 }),
    /maxTargetHeadings/u
  );
});

test("normalizeCodexCommand permits a name or absolute path only", () => {
  assert.equal(normalizeCodexCommand("codex"), "codex");
  assert.equal(
    normalizeCodexCommand('"C:\\Program Files\\Codex\\codex.exe"'),
    "C:\\Program Files\\Codex\\codex.exe"
  );
  assert.throws(() => normalizeCodexCommand("codex --version"), /executable/u);
  assert.throws(() => normalizeCodexCommand("tools/codex"), /executable/u);
});

test("confirmation policy is explicit", () => {
  assert.equal(shouldConfirmRun("always", "emptyOnly"), true);
  assert.equal(shouldConfirmRun("appendAlways", "appendAlways"), true);
  assert.equal(shouldConfirmRun("appendAlways", "emptyOnly"), false);
  assert.equal(shouldConfirmRun("never", "appendAlways"), false);
});

test("only local and remote file-backed documents are supported", () => {
  assert.equal(isSupportedDocumentScheme("file"), true);
  assert.equal(isSupportedDocumentScheme("vscode-remote"), true);
  assert.equal(isSupportedDocumentScheme("git"), false);
  assert.equal(isSupportedDocumentScheme("untitled"), false);
  assert.equal(isSupportedDocumentScheme("vscode-vfs"), false);
});
