const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCodexArgs,
  formatFailureLog,
  truncateForLog
} = require("../lib/codexRuntime");

test("buildCodexArgs builds the workspace-write exec command", () => {
  const args = buildCodexArgs("C:/workspace", {
    enableWebSearch: true,
    showCodexProgress: true
  });

  assert.deepEqual(args, [
    "--search",
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "-C",
    "C:/workspace",
    "-"
  ]);
  assert.equal(args.includes("--ask-for-approval"), false);
});

test("buildCodexArgs can disable web search", () => {
  const args = buildCodexArgs("C:/workspace", { enableWebSearch: false });

  assert.equal(args.includes("--search"), false);
  assert.equal(args.at(-1), "-");
});

test("buildCodexArgs can disable JSON progress events", () => {
  const args = buildCodexArgs("C:/workspace", {
    enableWebSearch: false,
    showCodexProgress: false
  });

  assert.equal(args.includes("--json"), false);
  assert.equal(args[0], "exec");
});

test("truncateForLog keeps short text and marks truncated text", () => {
  assert.equal(truncateForLog("abc", 10), "abc");
  assert.equal(truncateForLog("", 10), "");

  const truncated = truncateForLog("abcdefghij", 4);
  assert.equal(truncated, "abcd\n... [truncated 6 chars]");
});

test("formatFailureLog records useful failure context", () => {
  const error = new Error("boom");
  const log = formatFailureLog({
    timestamp: "2026-06-01T00:00:00.000Z",
    logLevel: "debug",
    workspaceDir: "C:/workspace",
    fileName: "note.md",
    filePath: "C:/research/note.md",
    command: "codex",
    args: ["exec", "-"],
    emptySections: [{ title: "量子誤り訂正", lineNumber: 20 }],
    error,
    stderr: "stderr text",
    stdout: "stdout text",
    prompt: "prompt text"
  });

  assert.match(log, /Research Note Helper failure/);
  assert.match(log, /file: C:\/research\/note\.md/);
  assert.match(log, /command: codex/);
  assert.match(log, /- 量子誤り訂正 \(line 20\)/);
  assert.match(log, /Error: boom/);
  assert.match(log, /stderr text/);
  assert.match(log, /stdout text/);
  assert.match(log, /prompt text/);
});

test("formatFailureLog keeps minimal logs privacy-preserving", () => {
  const log = formatFailureLog({
    timestamp: "2026-06-01T00:00:00.000Z",
    logLevel: "minimal",
    workspaceName: "workspace",
    workspaceDir: "C:/workspace",
    fileName: "note.md",
    filePath: "C:/workspace/note.md",
    command: "codex",
    args: ["exec", "-"],
    targetSections: [{ title: "private heading", lineNumber: 20 }],
    error: new Error("boom"),
    stderr: "private stderr",
    stdout: "private stdout",
    prompt: "private prompt"
  });

  assert.match(log, /Research Note Helper failure/);
  assert.match(log, /workspace: workspace/);
  assert.match(log, /file: note\.md/);
  assert.match(log, /target heading count: 1/);
  assert.doesNotMatch(log, /C:\/workspace/);
  assert.doesNotMatch(log, /private heading/);
  assert.doesNotMatch(log, /private prompt/);
  assert.doesNotMatch(log, /private stdout/);
  assert.doesNotMatch(log, /private stderr/);
});
