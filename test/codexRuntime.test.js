"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCodexArgs,
  formatSafeFailureReason,
  formatFailureLog,
  truncateForLog
} = require("../lib/codexRuntime");

test("formatSafeFailureReason exposes only stable allowlisted identifiers", () => {
  const error = new Error("private C:/secret/note.md");
  error.code = "EXECUTABLE_NOT_FOUND";
  error.phase = "preflight";
  assert.equal(
    formatSafeFailureReason(error),
    "extension validation failure (preflight; code: EXECUTABLE_NOT_FOUND)"
  );

  error.code = "PRIVATE_C:/secret";
  error.phase = "private phase";
  assert.equal(formatSafeFailureReason(error), "process error (unclassified)");
});

test("buildCodexArgs creates an isolated read-only structured exec", () => {
  const args = buildCodexArgs("C:/workspace", {
    enableWebSearch: true,
    outputSchemaPath: "C:/tmp/note-output.schema.json"
  });

  assert.deepEqual(args, [
    "--search",
    "--sandbox",
    "read-only",
    "--ask-for-approval",
    "never",
    "--disable",
    "shell_tool",
    "--disable",
    "apps",
    "--disable",
    "multi_agent",
    "--disable",
    "hooks",
    "-C",
    "C:/workspace",
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
    "--output-schema",
    "C:/tmp/note-output.schema.json",
    "-"
  ]);
  assert.equal(args.includes("workspace-write"), false);
});

test("buildCodexArgs can keep authentication while opting into user config", () => {
  const args = buildCodexArgs("C:/workspace", {
    enableWebSearch: false,
    ignoreCodexUserConfiguration: false,
    outputSchemaPath: "C:/tmp/schema.json",
    showCodexProgress: false
  });

  assert.equal(args.includes("--search"), false);
  assert.equal(args.includes("--ignore-user-config"), false);
  assert.equal(args.includes("--json"), true);
  assert.equal(args.at(-1), "-");
});

test("buildCodexArgs requires a schema path", () => {
  assert.throws(
    () => buildCodexArgs("C:/workspace"),
    /outputSchemaPath is required/
  );
});

test("truncateForLog keeps short text and marks bounded text", () => {
  assert.equal(truncateForLog("abc", 10), "abc");
  assert.equal(truncateForLog("", 10), "");
  assert.equal(
    truncateForLog("abcdefghij", 4),
    "abcd... [truncated 6 chars]"
  );
});

test("formatFailureLog excludes model and filesystem secrets at every level", () => {
  const error = new Error("private error C:/secret/note.md");
  error.stack = "private stack";
  error.codex = {
    code: 7,
    stdout: "private stdout",
    stderr: "private stderr",
    stdoutTruncated: true,
    stderrTruncated: false
  };
  const log = formatFailureLog({
    timestamp: "2026-06-01T00:00:00.000Z",
    logLevel: "debug",
    workspaceDir: "C:/secret",
    filePath: "C:/secret/note.md",
    command: "C:/secret/codex.exe",
    args: ["--secret"],
    targetSections: [{ title: "秘密の見出し", lineNumber: 20 }],
    error,
    stdout: "private stdout",
    stderr: "private stderr",
    prompt: "private prompt"
  });

  assert.match(log, /Codex exited with code 7/);
  assert.match(log, /target heading count: 1/);
  assert.match(log, /Codex process started: yes/);
  assert.match(log, /stdout truncated: true/);
  for (const secret of [
    "C:/secret",
    "note.md",
    "codex.exe",
    "--secret",
    "秘密の見出し",
    "private error",
    "private stack",
    "private stdout",
    "private stderr",
    "private prompt"
  ]) {
    assert.equal(log.includes(secret), false);
  }
});

test("formatFailureLog caps the complete entry", () => {
  const log = formatFailureLog({
    timestamp: "x".repeat(1000),
    error: { code: "E".repeat(1000) },
    maxLogChars: 128
  });

  assert.equal(log.startsWith("\n========================================"), true);
  assert.equal(log.length < 180, true);
  assert.match(log, /truncated/);
});

test("formatFailureLog records only allowlisted extension codes and phases", () => {
  const error = new Error("private error C:/secret/note.md");
  error.stack = "private stack C:/secret/note.md";
  error.code = "EXECUTABLE_NOT_FOUND";
  error.phase = "preflight";
  const log = formatFailureLog({
    timestamp: "2026-06-01T00:00:00.000Z",
    error,
    command: "C:/secret/codex.exe",
    stdout: "private stdout",
    stderr: "private stderr"
  });

  assert.match(
    log,
    /extension validation failure \(preflight; code: EXECUTABLE_NOT_FOUND\)/u
  );
  assert.doesNotMatch(log, /process error/u);
  assert.match(log, /Codex process started: no/u);
  assert.doesNotMatch(log, /stdout truncated:/u);
  assert.doesNotMatch(log, /stderr truncated:/u);
  for (const secret of [
    "C:/secret",
    "note.md",
    "codex.exe",
    "private error",
    "private stack",
    "private stdout",
    "private stderr"
  ]) {
    assert.equal(log.includes(secret), false);
  }
});

test("formatFailureLog never falls back to unknown codes or phases", () => {
  const error = new Error("private message");
  error.code = "SECRET_CODE_C:/private/path";
  error.phase = "private-phase\nC:/private/path";
  error.stack = "private stack";
  const log = formatFailureLog({ error });

  assert.match(log, /reason: process error \(unclassified\)/u);
  assert.match(log, /Codex process started: no/u);
  for (const secret of [
    "SECRET_CODE",
    "private-phase",
    "C:/private/path",
    "private message",
    "private stack"
  ]) {
    assert.equal(log.includes(secret), false);
  }
});

test("formatFailureLog omits process-only fields when spawning failed", () => {
  const error = new Error("spawn failed at C:/private/codex.exe");
  error.name = "ProcessRunError";
  error.code = "ENOENT";
  error.codex = {
    code: null,
    signal: null,
    stdout: "private stdout",
    stderr: "private stderr",
    stdoutTruncated: true,
    stderrTruncated: true
  };
  const log = formatFailureLog({ error });

  assert.match(log, /reason: process error \(code: ENOENT\)/u);
  assert.match(log, /Codex process started: no/u);
  assert.doesNotMatch(log, /stdout truncated:/u);
  assert.doesNotMatch(log, /stderr truncated:/u);
  assert.doesNotMatch(log, /private/u);
});

test("formatFailureLog trusts an explicit not-started marker for unknown spawn errors", () => {
  const error = new Error("private synchronous spawn failure");
  error.name = "ProcessRunError";
  error.code = "EINVAL";
  error.codex = {
    code: null,
    signal: null,
    started: false,
    stdout: "private stdout",
    stderr: "private stderr",
    stdoutTruncated: true,
    stderrTruncated: true
  };
  const log = formatFailureLog({ error });

  assert.match(log, /reason: process error \(unclassified\)/u);
  assert.match(log, /Codex process started: no/u);
  assert.doesNotMatch(log, /stdout truncated:/u);
  assert.doesNotMatch(log, /stderr truncated:/u);
  assert.doesNotMatch(log, /EINVAL|private/u);
});
