const MAX_MESSAGE_LENGTH = 140;

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(number)));
}

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

  return String(event.type || event.event || event.kind || "").trim();
}

function getNestedValue(value, path) {
  return path.reduce((current, key) => {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    return current[key];
  }, value);
}

function getFirstString(event, paths) {
  for (const itemPath of paths) {
    const value = getNestedValue(event, itemPath);
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }

  return "";
}

function safeCommandLabel(command) {
  if (!command) {
    return "";
  }

  const text = truncateMessage(command, 80);
  return text.replace(/[A-Za-z]:\\[^\s]+/g, "[path]");
}

function describeCodexEvent(event) {
  const type = getEventType(event);
  const lowerType = type.toLowerCase();

  if (!type) {
    return "";
  }

  if (lowerType.includes("session")) {
    return "Codex session ready";
  }

  if (lowerType.includes("reasoning") || lowerType.includes("thinking")) {
    return "Codex is thinking";
  }

  if (lowerType.includes("plan") || lowerType.includes("todo")) {
    return "Codex is planning the edit";
  }

  if (
    lowerType.includes("exec") ||
    lowerType.includes("command") ||
    lowerType.includes("tool")
  ) {
    const command = getFirstString(event, [
      ["command"],
      ["cmd"],
      ["item", "command"],
      ["tool_call", "command"],
      ["call", "command"]
    ]);
    const label = safeCommandLabel(command);
    return label ? `Codex is running: ${label}` : "Codex is using a tool";
  }

  if (
    lowerType.includes("patch") ||
    lowerType.includes("file") ||
    lowerType.includes("edit")
  ) {
    return "Codex is editing the note";
  }

  if (
    lowerType.includes("agent_message") ||
    lowerType.includes("message") ||
    lowerType.includes("answer")
  ) {
    return "Codex is writing the result";
  }

  if (lowerType.includes("complete") || lowerType.includes("done")) {
    return "Codex is finishing";
  }

  return `Codex event: ${type}`;
}

function estimateProgressPercent(event, currentPercent = 0) {
  const type = getEventType(event).toLowerCase();
  let target = 35;

  if (type.includes("session")) {
    target = 18;
  } else if (type.includes("plan") || type.includes("todo")) {
    target = 30;
  } else if (type.includes("reasoning") || type.includes("thinking")) {
    target = Math.min(70, Math.max(35, currentPercent + 4));
  } else if (
    type.includes("exec") ||
    type.includes("command") ||
    type.includes("tool")
  ) {
    target = Math.min(78, Math.max(45, currentPercent + 6));
  } else if (
    type.includes("patch") ||
    type.includes("file") ||
    type.includes("edit")
  ) {
    target = Math.min(85, Math.max(70, currentPercent + 5));
  } else if (
    type.includes("agent_message") ||
    type.includes("message") ||
    type.includes("answer")
  ) {
    target = Math.min(88, Math.max(75, currentPercent + 3));
  } else if (type.includes("complete") || type.includes("done")) {
    target = 90;
  }

  return clampPercent(Math.max(currentPercent, target));
}

function parseJsonLine(line) {
  const text = String(line || "").trim();
  if (!text) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch (_error) {
    return undefined;
  }
}

function createLineCollector(onLine) {
  let buffered = "";

  return {
    push(chunk) {
      buffered += chunk;
      const lines = buffered.split(/\r?\n/);
      buffered = lines.pop() || "";
      lines.forEach((line) => onLine(line));
    },
    flush() {
      if (buffered) {
        onLine(buffered);
        buffered = "";
      }
    }
  };
}

module.exports = {
  clampPercent,
  createLineCollector,
  describeCodexEvent,
  estimateProgressPercent,
  parseJsonLine,
  truncateMessage
};
