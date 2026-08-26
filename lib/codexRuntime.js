"use strict";

const DEFAULT_MAX_LOG_CHARS = 4096;
const DEFAULT_MAX_LOG_FIELD_CHARS = 256;

function buildCodexArgs(workspaceDir, options = {}) {
  if (typeof workspaceDir !== "string" || !workspaceDir.trim()) {
    throw new TypeError("workspaceDir must be a non-empty string.");
  }

  const outputSchemaPath = String(options.outputSchemaPath || "").trim();
  if (!outputSchemaPath) {
    throw new TypeError("outputSchemaPath is required.");
  }

  const args = [];

  if (options.enableWebSearch) {
    args.push("--search");
  }

  args.push(
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
    workspaceDir,
    "exec",
    "--json",
    "--ephemeral"
  );

  if (options.ignoreCodexUserConfiguration !== false) {
    args.push("--ignore-user-config");
  }

  args.push(
    "--ignore-rules",
    "--skip-git-repo-check",
    "--output-schema",
    outputSchemaPath,
    "-"
  );

  return args;
}

function truncateForLog(value, maxLength = DEFAULT_MAX_LOG_FIELD_CHARS) {
  if (!value || maxLength <= 0) {
    return "";
  }

  const text = String(value);
  if (text.length <= maxLength) {
    return text;
  }

  const suffix = `... [truncated ${text.length - maxLength} chars]`;
  return `${text.slice(0, maxLength)}${suffix}`;
}

function getFailureReason(error) {
  if (!error || typeof error !== "object") {
    return "unknown failure";
  }
  if (error.cancelled || error.name === "AbortError" || error.code === "ABORT_ERR") {
    return "cancelled";
  }
  if (error.timedOut || error.code === "ETIMEDOUT") {
    return "timed out";
  }

  const exitCode = error.codex && error.codex.code;
  if (Number.isInteger(exitCode)) {
    return `Codex exited with code ${exitCode}`;
  }

  if (typeof error.phase === "string" && error.phase) {
    return `extension validation failure (${truncateForLog(error.phase, 64)})`;
  }

  const code = typeof error.code === "string" ? error.code : "PROCESS_ERROR";
  return `process error (${truncateForLog(code, 64)})`;
}

function formatFailureLog(details = {}) {
  const targetSections = details.targetSections || details.emptySections || [];
  const error = details.error || {};
  const codex = error.codex || {};
  const timestamp = details.timestamp || new Date().toISOString();
  const entry = [
    "",
    "========================================",
    `[${timestamp}] Codex Note Helper failure`,
    `reason: ${getFailureReason(error)}`,
    `target heading count: ${targetSections.length}`,
    `cancelled: ${Boolean(error.cancelled || error.code === "ABORT_ERR")}`,
    `timed out: ${Boolean(error.timedOut || error.code === "ETIMEDOUT")}`,
    `stdout truncated: ${Boolean(codex.stdoutTruncated)}`,
    `stderr truncated: ${Boolean(codex.stderrTruncated)}`,
    ""
  ].join("\n");

  // Prompts, model output, stderr, paths, arguments, headings, and stack traces
  // are intentionally never written.
  return truncateForLog(entry, details.maxLogChars || DEFAULT_MAX_LOG_CHARS);
}

module.exports = {
  buildCodexArgs,
  formatFailureLog,
  truncateForLog
};
