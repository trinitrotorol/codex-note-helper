"use strict";

const { StringDecoder } = require("node:string_decoder");

const MAX_MESSAGE_LENGTH = 140;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024;

const ITEM_CATEGORIES = Object.freeze({
  agent_message: {
    key: "result",
    message: "Codex prepared structured note updates"
  },
  reasoning: {
    key: "reasoning",
    message: "Codex is reasoning"
  },
  command_execution: {
    key: "inspection",
    message: "Codex is inspecting the note"
  },
  file_change: {
    key: "file-change",
    message: "Codex reported a file operation"
  },
  mcp_tool_call: {
    key: "tool",
    message: "Codex is using an external tool"
  },
  web_search: {
    key: "web-search",
    message: "Codex is searching the web"
  },
  todo_list: {
    key: "planning",
    message: "Codex is planning"
  }
});

function truncateMessage(value, maxLength = MAX_MESSAGE_LENGTH) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= maxLength) {
    return text;
  }
  if (maxLength <= 0) {
    return "";
  }
  if (maxLength <= 3) {
    return ".".repeat(maxLength);
  }
  return `${text.slice(0, maxLength - 3).trim()}...`;
}

function getEventType(event) {
  if (!event || typeof event !== "object") {
    return "";
  }
  return typeof event.type === "string" ? event.type.trim().toLowerCase() : "";
}

function getItemType(event) {
  if (!event || !event.item || typeof event.item !== "object") {
    return "";
  }
  return typeof event.item.type === "string"
    ? event.item.type.trim().toLowerCase()
    : "";
}

function assertCodexEventPolicy(event, options = {}) {
  const type = getEventType(event);
  const itemType = getItemType(event);
  let violation;

  if (type === "turn.failed" || type === "error") {
    violation = "Codex reported a failed turn.";
  } else if (
    type === "thread.started" ||
    type === "turn.started" ||
    type === "turn.completed"
  ) {
    // These are the only non-item lifecycle events used by `codex exec --json`.
  } else if (
    type === "item.started" ||
    type === "item.updated" ||
    type === "item.completed"
  ) {
    if (itemType === "web_search") {
      if (!options.enableWebSearch) {
        violation = "Codex attempted web search while it was disabled.";
      }
    } else if (itemType === "agent_message") {
      if (type !== "item.completed") {
        violation = "Codex emitted an incomplete agent response.";
      }
    } else if (itemType !== "reasoning" && itemType !== "todo_list") {
      violation = "Codex attempted a disabled or unknown tool operation.";
    }
  } else {
    violation = "Codex emitted an unknown event type.";
  }

  if (violation) {
    const error = new Error(violation);
    error.code = "CODEX_POLICY_VIOLATION";
    throw error;
  }
}

function classifyCodexEvent(event) {
  const type = getEventType(event);

  if (type === "thread.started") {
    return {
      key: "thread",
      message: "Codex session started",
      terminal: false,
      error: false
    };
  }
  if (type === "turn.started") {
    return {
      key: "turn",
      message: "Codex is analyzing the note",
      terminal: false,
      error: false
    };
  }
  if (type === "turn.completed") {
    return {
      key: "complete",
      message: "Codex finished",
      terminal: true,
      error: false
    };
  }
  if (type === "turn.failed" || type === "error") {
    return {
      key: "error",
      message: "Codex reported an error",
      terminal: true,
      error: true
    };
  }

  if (
    type === "item.started" ||
    type === "item.updated" ||
    type === "item.completed"
  ) {
    const category = ITEM_CATEGORIES[getItemType(event)] || {
      key: "item",
      message: "Codex is processing the note"
    };
    return {
      ...category,
      terminal: false,
      error: false
    };
  }

  return undefined;
}

function describeCodexEvent(event) {
  const category = classifyCodexEvent(event);
  return category ? category.message : "";
}

function createProgressEventFilter() {
  let lastKey;

  return {
    accept(event) {
      const category = classifyCodexEvent(event);
      if (!category || category.key === lastKey) {
        return undefined;
      }
      lastKey = category.key;
      return category;
    },
    reset() {
      lastKey = undefined;
    },
    get lastKey() {
      return lastKey;
    }
  };
}

function parseJsonLine(line, maxLineBytes = DEFAULT_MAX_LINE_BYTES) {
  const text = String(line || "").trim();
  if (!text || Buffer.byteLength(text, "utf8") > maxLineBytes) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch (_error) {
    return undefined;
  }
}

function takeUtf8Prefix(value, maxBytes) {
  if (maxBytes <= 0 || !value) {
    return { text: "", bytes: 0, truncated: Boolean(value) };
  }

  let bytes = 0;
  let text = "";
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) {
      return { text, bytes, truncated: true };
    }
    text += character;
    bytes += characterBytes;
  }
  return { text, bytes, truncated: false };
}

function createLineCollector(onLine, options = {}) {
  if (typeof onLine !== "function") {
    throw new TypeError("onLine must be a function.");
  }

  const maxLineBytes =
    Number.isInteger(options.maxLineBytes) && options.maxLineBytes > 0
      ? options.maxLineBytes
      : DEFAULT_MAX_LINE_BYTES;
  const decoder = new StringDecoder("utf8");
  let buffered = "";
  let bufferedBytes = 0;
  let truncated = false;

  function append(value) {
    if (!value || truncated) {
      return;
    }
    const prefix = takeUtf8Prefix(value, maxLineBytes - bufferedBytes);
    buffered += prefix.text;
    bufferedBytes += prefix.bytes;
    truncated = prefix.truncated;
  }

  function emit() {
    const line = buffered.endsWith("\r") ? buffered.slice(0, -1) : buffered;
    onLine(line, { truncated });
    buffered = "";
    bufferedBytes = 0;
    truncated = false;
  }

  function consume(text) {
    let start = 0;
    for (let index = 0; index < text.length; index += 1) {
      if (text[index] !== "\n") {
        continue;
      }
      append(text.slice(start, index));
      emit();
      start = index + 1;
    }
    append(text.slice(start));
  }

  return {
    push(chunk) {
      if (Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk)) {
        consume(decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
        return;
      }
      consume(String(chunk || ""));
    },
    flush() {
      consume(decoder.end());
      if (buffered || truncated) {
        emit();
      }
    }
  };
}

module.exports = {
  assertCodexEventPolicy,
  classifyCodexEvent,
  createLineCollector,
  createProgressEventFilter,
  describeCodexEvent,
  parseJsonLine,
  truncateMessage
};
