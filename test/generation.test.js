"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildOutputSchema,
  containsDisallowedHeading,
  containsUnsafeMarkdown,
  extractFinalAgentMessage,
  parseGeneratedUpdates
} = require("../lib/generation");

function jsonlMessage(value) {
  return [
    JSON.stringify({ type: "thread.started", thread_id: "redacted" }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: JSON.stringify(value) }
    }),
    JSON.stringify({ type: "turn.completed" })
  ].join("\n");
}

test("buildOutputSchema constrains target indexes and item count", () => {
  const schema = buildOutputSchema(3, 5000);
  assert.equal(schema.properties.updates.minItems, 3);
  assert.equal(schema.properties.updates.maxItems, 3);
  assert.deepEqual(
    schema.properties.updates.items.properties.targetIndex.enum,
    [0, 1, 2]
  );
  assert.equal(
    schema.properties.updates.items.properties.markdown.maxLength,
    5000
  );
  assert.equal(schema.properties.warnings.maxItems, 3);
  assert.equal(schema.properties.warnings.items.maxLength, 160);
});

test("extractFinalAgentMessage uses the last completed agent message", () => {
  const stdout = [
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "first" }
    }),
    JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: "last" }
    }),
    JSON.stringify({ type: "turn.completed" })
  ].join("\n");
  assert.equal(extractFinalAgentMessage(stdout), "last");
});

test("extractFinalAgentMessage requires a successful terminal event", () => {
  assert.throws(
    () =>
      extractFinalAgentMessage(
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: "result" }
        })
      ),
    /complete successfully/u
  );
  assert.throws(
    () =>
      extractFinalAgentMessage(
        [
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "result" }
          }),
          JSON.stringify({ type: "turn.failed" })
        ].join("\n")
      ),
    /failed turn/u
  );
  assert.throws(
    () =>
      extractFinalAgentMessage(
        [
          JSON.stringify({
            type: "item.completed",
            item: { type: "agent_message", text: "result" }
          }),
          JSON.stringify({ type: "turn.completed" }),
          JSON.stringify({ type: "turn.started" })
        ].join("\n")
      ),
    /after its terminal event/u
  );
});

test("structured parsing rejects unknown future event types", () => {
  const stdout = [
    JSON.stringify({
      type: "item.completed",
      item: { type: "future_network_tool" }
    }),
    jsonlMessage({
      updates: [{ targetIndex: 0, markdown: "Safe" }],
      warnings: []
    })
  ].join("\n");
  assert.throws(
    () => parseGeneratedUpdates(stdout, [{ title: "A", level: 1 }]),
    { code: "CODEX_POLICY_VIOLATION" }
  );
});

test("structured parsing rejects hidden tool events even before a valid result", () => {
  const stdout = [
    JSON.stringify({
      type: "item.completed",
      item: { type: "command_execution", output: "x".repeat(70_000) }
    }),
    jsonlMessage({
      updates: [{ targetIndex: 0, markdown: "Safe" }],
      warnings: []
    })
  ].join("\n");
  assert.throws(
    () => parseGeneratedUpdates(stdout, [{ title: "A", level: 1 }]),
    { code: "CODEX_POLICY_VIOLATION" }
  );
});

test("parseGeneratedUpdates validates and orders structured output", () => {
  const stdout = jsonlMessage({
    updates: [
      { targetIndex: 1, markdown: "Second body" },
      { targetIndex: 0, markdown: "First body" }
    ],
    warnings: ["  verify   this  "]
  });
  const result = parseGeneratedUpdates(stdout, [
    { title: "A", level: 1 },
    { title: "B", level: 1 }
  ]);

  assert.deepEqual(result.updates, [
    { targetIndex: 0, markdown: "First body" },
    { targetIndex: 1, markdown: "Second body" }
  ]);
  assert.deepEqual(result.warnings, ["verify this"]);
});

test("parseGeneratedUpdates rejects missing, duplicate, and escaping output", () => {
  const targets = [{ title: "A", level: 2 }, { title: "B", level: 2 }];

  assert.throws(
    () =>
      parseGeneratedUpdates(
        jsonlMessage({
          updates: [{ targetIndex: 0, markdown: "Only one" }],
          warnings: []
        }),
        targets
      ),
    /1 updates for 2 targets/u
  );

  assert.throws(
    () =>
      parseGeneratedUpdates(
        jsonlMessage({
          updates: [
            { targetIndex: 0, markdown: "One" },
            { targetIndex: 0, markdown: "Duplicate" }
          ],
          warnings: []
        }),
        targets
      ),
    /more than once/u
  );

  assert.throws(
    () =>
      parseGeneratedUpdates(
        jsonlMessage({
          updates: [
            { targetIndex: 0, markdown: "## Escapes" },
            { targetIndex: 1, markdown: "Safe" }
          ],
          warnings: []
        }),
        targets
      ),
    /escape its section/u
  );
});

test("heading checks ignore fenced examples but reject Setext headings", () => {
  assert.equal(
    containsDisallowedHeading("```md\n# example\n```", 1),
    false
  );
  assert.equal(containsDisallowedHeading("Heading\n=======", 3), true);
  assert.equal(containsDisallowedHeading("Subheading\n-------", 1), false);
});

test("reserved ownership markers cannot be injected", () => {
  assert.throws(
    () =>
      parseGeneratedUpdates(
        jsonlMessage({
          updates: [
            {
              targetIndex: 0,
              markdown: "<!-- codex-note-helper:generated:start -->"
            }
          ],
          warnings: []
        }),
        [{ title: "A", level: 1 }]
      ),
    /reserved ownership markers/u
  );
});

test("active Markdown payloads are rejected outside code fences", () => {
  assert.equal(containsUnsafeMarkdown("[run](command:workbench.action.closeWindow)"), true);
  assert.equal(containsUnsafeMarkdown("<script>alert(1)</script>"), true);
  assert.equal(containsUnsafeMarkdown("[run][action]\n[action]: vscode:open"), true);
  assert.equal(containsUnsafeMarkdown("<command:workbench.action.closeWindow>"), true);
  assert.equal(containsUnsafeMarkdown("<img src=\"https://example.com/pixel\">"), true);
  assert.equal(containsUnsafeMarkdown("![pixel](https://example.com/pixel)"), true);
  assert.equal(containsUnsafeMarkdown("![pixel]\n\n[pixel]: https://example.com"), true);
  assert.equal(containsUnsafeMarkdown("```bad`info\n<script>alert(1)</script>"), true);
  assert.equal(containsUnsafeMarkdown("```md\nunclosed"), true);
  assert.equal(containsUnsafeMarkdown("<!-- unclosed"), true);
  assert.equal(
    containsUnsafeMarkdown("```md\n[example](javascript:alert(1))\n```"),
    false
  );
});

test("structured validation preserves meaningful indentation and hard-break spaces", () => {
  const markdown = "    const answer = 42;\nline with break  ";
  const result = parseGeneratedUpdates(
    jsonlMessage({
      updates: [{ targetIndex: 0, markdown }],
      warnings: []
    }),
    [{ title: "A", level: 1 }]
  );
  assert.equal(result.updates[0].markdown, markdown);
});

test("structured validation rejects extra fields and malformed warnings", () => {
  const target = [{ title: "A", level: 1 }];
  assert.throws(
    () =>
      parseGeneratedUpdates(
        jsonlMessage({
          updates: [{ targetIndex: 0, markdown: "Safe", path: "note.md" }],
          warnings: []
        }),
        target
      ),
    /unknown target index/u
  );
  assert.throws(
    () =>
      parseGeneratedUpdates(
        jsonlMessage({
          updates: [{ targetIndex: 0, markdown: "Safe" }],
          warnings: [42]
        }),
        target
      ),
    /invalid warning list/u
  );
  assert.throws(
    () =>
      parseGeneratedUpdates(
        jsonlMessage({
          updates: [{ targetIndex: 0, markdown: "Safe" }],
          warnings: ["a", "b", "c", "d"]
        }),
        target
      ),
    /invalid warning list/u
  );
  assert.throws(
    () =>
      parseGeneratedUpdates(
        jsonlMessage({
          updates: [{ targetIndex: 0, markdown: "Safe" }],
          warnings: [],
          path: "note.md"
        }),
        target
      ),
    /expected schema/u
  );
});

test("structured validation rejects control and bidi characters in warnings", () => {
  const target = [{ title: "A", level: 1 }];
  const unsafeWarnings = [
    "hidden\u0001control",
    "hidden\u0085control",
    "spoofed\u202e warning",
    "isolated\u2066 warning"
  ];

  for (const warning of unsafeWarnings) {
    assert.throws(
      () =>
        parseGeneratedUpdates(
          jsonlMessage({
            updates: [{ targetIndex: 0, markdown: "Safe" }],
            warnings: [warning]
          }),
          target
        ),
      /invalid warning list/u
    );
  }
});
