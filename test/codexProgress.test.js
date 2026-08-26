const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertCodexEventPolicy,
  classifyCodexEvent,
  createLineCollector,
  createProgressEventFilter,
  describeCodexEvent,
  parseJsonLine,
  truncateMessage
} = require("../lib/codexProgress");

test("runtime policy rejects failed turns and disabled tool activity", () => {
  assert.throws(
    () => assertCodexEventPolicy({ type: "turn.failed" }),
    { code: "CODEX_POLICY_VIOLATION" }
  );
  for (const itemType of [
    "command_execution",
    "file_change",
    "mcp_tool_call",
    "computer_tool_call",
    "dynamic_tool_call",
    "collab_tool_call"
  ]) {
    assert.throws(
      () =>
        assertCodexEventPolicy({
          type: "item.started",
          item: { type: itemType }
        }),
      { code: "CODEX_POLICY_VIOLATION" }
    );
  }
  for (const event of [
    { type: "session.configured" },
    { type: "item.completed", item: { type: "future_network_tool" } },
    { type: "item.completed", item: { type: "error" } },
    { type: "item.started", item: { type: "agent_message" } },
    { type: "item.completed" },
    null
  ]) {
    assert.throws(() => assertCodexEventPolicy(event), {
      code: "CODEX_POLICY_VIOLATION"
    });
  }
});

test("runtime policy permits web search only when configured", () => {
  const event = { type: "item.completed", item: { type: "web_search" } };
  assert.throws(() => assertCodexEventPolicy(event), {
    code: "CODEX_POLICY_VIOLATION"
  });
  assert.doesNotThrow(() =>
    assertCodexEventPolicy(event, { enableWebSearch: true })
  );
  assert.doesNotThrow(() =>
    assertCodexEventPolicy({
      type: "item.completed",
      item: { type: "agent_message" }
    })
  );
  for (const type of ["thread.started", "turn.started", "turn.completed"]) {
    assert.doesNotThrow(() => assertCodexEventPolicy({ type }));
  }
  for (const itemType of ["reasoning", "todo_list"]) {
    assert.doesNotThrow(() =>
      assertCodexEventPolicy({
        type: "item.updated",
        item: { type: itemType }
      })
    );
  }
});

test("parseJsonLine reads current JSONL events and ignores unsafe input", () => {
  assert.deepEqual(parseJsonLine('{"type":"thread.started"}'), {
    type: "thread.started"
  });
  assert.equal(parseJsonLine("not json"), undefined);
  assert.equal(parseJsonLine(""), undefined);
  assert.equal(parseJsonLine('{"type":"error"}', 4), undefined);
});

test("classifyCodexEvent interprets thread, turn, item, and error events", () => {
  assert.deepEqual(classifyCodexEvent({ type: "thread.started" }), {
    key: "thread",
    message: "Codex session started",
    terminal: false,
    error: false
  });
  assert.equal(
    classifyCodexEvent({
      type: "item.completed",
      item: { type: "agent_message", text: "private note" }
    }).key,
    "result"
  );
  assert.equal(
    classifyCodexEvent({
      type: "item.started",
      item: {
        type: "command_execution",
        command: "type C:\\secret\\note.md --token private"
      }
    }).key,
    "inspection"
  );
  assert.deepEqual(classifyCodexEvent({ type: "turn.failed", error: "private" }), {
    key: "error",
    message: "Codex reported an error",
    terminal: true,
    error: true
  });
});

test("progress messages never expose commands, paths, URLs, args, or content", () => {
  const secrets = [
    "C:\\secret\\note.md",
    "/home/alice/private.md",
    "https://example.test/?token=private",
    "--api-key=private",
    "private note"
  ];
  const events = secrets.map((secret) => ({
    type: "item.started",
    item: {
      type: "command_execution",
      command: secret,
      arguments: [secret],
      text: secret
    }
  }));

  for (const event of events) {
    const message = describeCodexEvent(event);
    assert.equal(message, "Codex is inspecting the note");
    for (const secret of secrets) {
      assert.equal(message.includes(secret), false);
    }
  }
  assert.equal(
    describeCodexEvent({ type: "future.event", value: secrets[0] }),
    ""
  );
});

test("createProgressEventFilter suppresses adjacent duplicate categories", () => {
  const filter = createProgressEventFilter();
  const reasoning = {
    type: "item.started",
    item: { type: "reasoning", text: "private" }
  };

  assert.equal(filter.accept(reasoning).key, "reasoning");
  assert.equal(filter.accept({ ...reasoning, type: "item.completed" }), undefined);
  assert.equal(filter.accept({ type: "turn.completed" }).key, "complete");
  filter.reset();
  assert.equal(filter.accept(reasoning).key, "reasoning");
});

test("createLineCollector preserves split UTF-8 and bounds oversized lines", () => {
  const lines = [];
  const collector = createLineCollector(
    (line, metadata) => lines.push({ line, truncated: metadata.truncated }),
    { maxLineBytes: 4 }
  );
  const japanese = Buffer.from("あ\nいろ", "utf8");

  collector.push(japanese.subarray(0, 1));
  collector.push(japanese.subarray(1, 4));
  collector.push(japanese.subarray(4));
  collector.flush();

  assert.deepEqual(lines, [
    { line: "あ", truncated: false },
    { line: "い", truncated: true }
  ]);
  assert.equal(lines.some((item) => item.line.includes("\ufffd")), false);
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
  assert.equal(truncateMessage("a\n  b\tc", 10), "a b c");
  assert.equal(truncateMessage("abcdefghij", 6), "abc...");
});
