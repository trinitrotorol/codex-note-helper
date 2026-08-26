"use strict";

const {
  containsUnsafeGeneratedMarkdown,
  discoverHeadings
} = require("./noteParser");
const { assertCodexEventPolicy } = require("./codexProgress");

const UNSAFE_CONTROL_OR_BIDI_PATTERN =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;

function structuredOutputError(message) {
  const error = new Error(message);
  error.name = "StructuredOutputError";
  error.code = "INVALID_STRUCTURED_OUTPUT";
  return error;
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
}

function buildOutputSchema(targetCount, maxMarkdownCharacters = 100000) {
  assertPositiveInteger(targetCount, "targetCount");
  assertPositiveInteger(maxMarkdownCharacters, "maxMarkdownCharacters");

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
      updates: {
        type: "array",
        minItems: targetCount,
        maxItems: targetCount,
        items: {
          type: "object",
          properties: {
            targetIndex: {
              type: "integer",
              enum: Array.from({ length: targetCount }, (_, index) => index)
            },
            markdown: {
              type: "string",
              minLength: 1,
              maxLength: maxMarkdownCharacters
            }
          },
          required: ["targetIndex", "markdown"],
          additionalProperties: false
        }
      },
      warnings: {
        type: "array",
        maxItems: 3,
        items: {
          type: "string",
          maxLength: 160
        }
      }
    },
    required: ["updates", "warnings"],
    additionalProperties: false
  };
}

function extractFinalAgentMessage(stdout, options = {}) {
  let finalMessage;
  let completedAfterFinalMessage = false;
  let terminalSeen = false;

  for (const line of String(stdout || "").split(/\r?\n/u)) {
    if (!line.trim()) {
      continue;
    }

    if (terminalSeen) {
      throw structuredOutputError(
        "Codex emitted output after its terminal event."
      );
    }

    let event;
    try {
      event = JSON.parse(line);
    } catch (_error) {
      throw structuredOutputError("Codex emitted a non-JSON output line.");
    }

    assertCodexEventPolicy(event, {
      enableWebSearch: Boolean(options.enableWebSearch)
    });

    if (
      event &&
      event.type === "item.completed" &&
      event.item &&
      event.item.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      finalMessage = event.item.text;
      completedAfterFinalMessage = false;
    } else if (event && event.type === "turn.completed") {
      terminalSeen = true;
      completedAfterFinalMessage = Boolean(finalMessage);
    }
  }

  if (!finalMessage) {
    throw structuredOutputError(
      "Codex did not return a structured final response."
    );
  }
  if (!completedAfterFinalMessage) {
    throw structuredOutputError(
      "Codex did not complete successfully after its final response."
    );
  }

  return finalMessage;
}

function stripJsonFence(value) {
  const trimmed = String(value || "").trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(trimmed);
  return match ? match[1].trim() : trimmed;
}

function containsDisallowedHeading(markdown, parentLevel) {
  return discoverHeadings(String(markdown)).headings.some(
    (heading) => heading.level <= parentLevel
  );
}

function containsUnsafeMarkdown(markdown) {
  return containsUnsafeGeneratedMarkdown(markdown);
}

function parseGeneratedUpdates(stdout, targetSections, options = {}) {
  if (!Array.isArray(targetSections) || targetSections.length === 0) {
    throw new TypeError("targetSections must contain at least one section.");
  }

  const maxMarkdownCharacters = Number.isInteger(options.maxMarkdownCharacters)
    ? options.maxMarkdownCharacters
    : 100000;
  if (maxMarkdownCharacters < 1) {
    throw new TypeError("maxMarkdownCharacters must be a positive integer.");
  }
  const finalMessage = extractFinalAgentMessage(stdout, {
    enableWebSearch: Boolean(options.enableWebSearch)
  });
  let parsed;

  try {
    parsed = JSON.parse(stripJsonFence(finalMessage));
  } catch (_error) {
    throw structuredOutputError("Codex returned invalid structured JSON.");
  }

  if (!hasExactKeys(parsed, ["updates", "warnings"])) {
    throw structuredOutputError(
      "Codex response does not match the expected schema."
    );
  }
  if (!Array.isArray(parsed.updates) || !Array.isArray(parsed.warnings)) {
    throw structuredOutputError(
      "Codex response does not match the expected schema."
    );
  }

  if (parsed.updates.length !== targetSections.length) {
    throw structuredOutputError(
      `Codex returned ${parsed.updates.length} updates for ${targetSections.length} targets.`
    );
  }

  if (
    parsed.warnings.length > 3 ||
    parsed.warnings.some(
      (warning) =>
        typeof warning !== "string" ||
        warning.length > 160 ||
        UNSAFE_CONTROL_OR_BIDI_PATTERN.test(warning)
    )
  ) {
    throw structuredOutputError("Codex returned an invalid warning list.");
  }

  const updates = new Array(targetSections.length);
  for (const update of parsed.updates) {
    if (
      !hasExactKeys(update, ["markdown", "targetIndex"]) ||
      !Number.isInteger(update.targetIndex) ||
      update.targetIndex < 0 ||
      update.targetIndex >= targetSections.length
    ) {
      throw structuredOutputError("Codex returned an unknown target index.");
    }

    if (updates[update.targetIndex]) {
      throw structuredOutputError(
        `Codex returned target ${update.targetIndex} more than once.`
      );
    }

    if (typeof update.markdown !== "string" || !update.markdown.trim()) {
      throw structuredOutputError(
        `Codex returned empty Markdown for target ${update.targetIndex}.`
      );
    }

    if (update.markdown.length > maxMarkdownCharacters) {
      throw structuredOutputError(
        `Codex output for target ${update.targetIndex} is too large.`
      );
    }

    if (
      update.markdown.includes("codex-note-helper:generated:")
    ) {
      throw structuredOutputError(
        "Codex output contains reserved ownership markers."
      );
    }

    if (containsUnsafeMarkdown(update.markdown)) {
      throw structuredOutputError(
        "Codex output contains unsafe active Markdown or HTML."
      );
    }

    const target = targetSections[update.targetIndex];
    const targetLevel = target.level || target.headingLevel || 1;
    if (containsDisallowedHeading(update.markdown, targetLevel)) {
      throw structuredOutputError(
        `Codex output for target ${update.targetIndex} contains a heading that would escape its section.`
      );
    }

    updates[update.targetIndex] = {
      targetIndex: update.targetIndex,
      markdown: update.markdown
    };
  }

  if (updates.some((update) => !update)) {
    throw structuredOutputError("Codex response omitted one or more targets.");
  }

  const warnings = parsed.warnings
    .map((warning) => warning.replace(/\s+/gu, " ").trim())
    .filter(Boolean);

  return { updates, warnings };
}

module.exports = {
  buildOutputSchema,
  containsDisallowedHeading,
  containsUnsafeMarkdown,
  extractFinalAgentMessage,
  parseGeneratedUpdates
};
