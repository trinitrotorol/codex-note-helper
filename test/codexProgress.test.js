const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createLineCollector,
  describeCodexEvent,
  estimateProgressPercent,
  parseJsonLine,
  truncateMessage
} = require("../lib/codexProgress");

test("parseJsonLine reads JSONL events and ignores plain text", () => {
  assert.deepEqual(parseJsonLine('{"type":"session_configured"}'), {
    type: "session_configured"
  });
  assert.equal(parseJsonLine("not json"), undefined);
  assert.equal(parseJsonLine(""), undefined);
});

test("describeCodexEvent summarizes activity without note content", () => {
  assert.equal(
    describeCodexEvent({ type: "agent_reasoning_delta", delta: "private note" }),
    "Codex is thinking"
  );
  assert.equal(
    describeCodexEvent({ type: "apply_patch_begin", text: "private edit" }),
    "Codex is editing the note"
  );
  assert.equal(
    describeCodexEvent({
      type: "exec_command_begin",
      command: "Get-Content -LiteralPath C:\\secret\\note.md"
    }),
    "Codex is running: Get-Content -LiteralPath [path]"
  );
});

test("estimateProgressPercent moves forward and stays bounded", () => {
  let percent = estimateProgressPercent({ type: "session_configured" }, 12);
  assert.equal(percent, 18);

  percent = estimateProgressPercent({ type: "agent_reasoning_delta" }, percent);
  assert.equal(percent > 18, true);

  percent = estimateProgressPercent({ type: "turn_complete" }, percent);
  assert.equal(percent, 90);
});

test("createLineCollector emits complete lines and flushes remainder", () => {
  const lines = [];
  const collector = createLineCollector((line) => lines.push(line));

  collector.push('{"type":"a"}\n{"type"');
  collector.push(':"b"}\npartial');
  collector.flush();

  assert.deepEqual(lines, [
    '{"type":"a"}',
    '{"type":"b"}',
    "partial"
  ]);
});

test("truncateMessage normalizes whitespace and limits length", () => {
  const text = truncateMessage("a\n  b\tc", 10);
  assert.equal(text, "a b c");
  assert.equal(truncateMessage("abcdefghij", 6), "abc...");
});
