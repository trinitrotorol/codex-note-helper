"use strict";

const DEFAULT_MAX_LOG_CHARS = 4096;
const DEFAULT_MAX_LOG_FIELD_CHARS = 256;

// Only stable identifiers owned by this extension (plus the small set of
// process-runner codes it deliberately creates or forwards) may enter the
// diagnostic log. Error messages, unknown codes, and arbitrary phase strings
// can contain paths or other attacker-controlled text and must never be used as
// a fallback description.
const SAFE_FAILURE_CODES = new Set([
  "ABORT_ERR",
  "APPLY_REJECTED",
  "CODEX_CLI_INCOMPATIBLE",
  "CODEX_EXIT",
  "CODEX_POLICY_VIOLATION",
  "CODEX_PROCESS_ERROR",
  "DIFF_UNAVAILABLE",
  "DOCUMENT_CHANGED",
  "EACCES",
  "ENOENT",
  "ENOTDIR",
  "EPERM",
  "ETIMEDOUT",
  "EXECUTABLE_CHANGED",
  "EXECUTABLE_IN_WORKSPACE",
  "EXECUTABLE_NOT_EXECUTABLE",
  "EXECUTABLE_NOT_FOUND",
  "EXECUTABLE_NOT_REGULAR",
  "EXECUTABLE_UNREADABLE",
  "INPUT_LIMIT",
  "INVALID_CODEX_PACKAGE",
  "INVALID_EXECUTABLE_NAME",
  "INVALID_STRUCTURED_OUTPUT",
  "NODE_EXECUTABLE_NOT_FOUND",
  "OUTPUT_LIMIT",
  "STORAGE_UNAVAILABLE",
  "TARGET_LIMIT",
  "UNSAFE_COMMAND_SHIM",
  "UNSAFE_NODE_EXECUTABLE",
  "UNSUPPORTED_WINDOWS_SCRIPT",
  "WORKSPACE_ROOT_UNREADABLE"
]);
const SAFE_FAILURE_PHASES = new Set([
  "apply",
  "cancel",
  "configuration",
  "generation",
  "parse",
  "preflight",
  "review",
  "storage",
  "validation"
]);
const PROCESS_NOT_STARTED_CODES = new Set([
  "EACCES",
  "ENOENT",
  "ENOTDIR",
  "EPERM"
]);

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

function safeFailureCode(error) {
  const code = error && typeof error.code === "string" ? error.code : "";
  return SAFE_FAILURE_CODES.has(code) ? code : "";
}

function safeFailurePhase(error) {
  const phase = error && typeof error.phase === "string" ? error.phase : "";
  return SAFE_FAILURE_PHASES.has(phase) ? phase : "";
}

function classifiedReason(label, error) {
  const phase = safeFailurePhase(error);
  const code = safeFailureCode(error);
  const fields = [];
  if (phase) {
    fields.push(`phase: ${phase}`);
  }
  if (code) {
    fields.push(`code: ${code}`);
  }
  return fields.length > 0 ? `${label} (${fields.join("; ")})` : label;
}

function extensionFailureReason(error) {
  const phase = safeFailurePhase(error);
  const code = safeFailureCode(error);
  if (!phase) {
    return code
      ? `extension validation failure (code: ${code})`
      : "extension validation failure";
  }
  return code
    ? `extension validation failure (${phase}; code: ${code})`
    : `extension validation failure (${phase})`;
}

function didCodexProcessStart(details, error) {
  if (typeof details.processStarted === "boolean") {
    return details.processStarted;
  }

  const codex = error && error.codex;
  if (!codex || typeof codex !== "object") {
    return false;
  }
  if (typeof codex.started === "boolean") {
    return codex.started;
  }

  const code = safeFailureCode(error);
  if (PROCESS_NOT_STARTED_CODES.has(code)) {
    return false;
  }

  // runProcess attaches a result object to its failures. The only result it can
  // create without spawning is an already-aborted run, which has no exit code,
  // signal, or captured output.
  if (
    code === "ABORT_ERR" &&
    codex.code === null &&
    codex.signal === null &&
    !codex.stdout &&
    !codex.stderr
  ) {
    return false;
  }
  return true;
}

function getFailureReason(error) {
  if (!error || typeof error !== "object") {
    return "unknown failure";
  }
  if (error.cancelled || error.name === "AbortError" || error.code === "ABORT_ERR") {
    return classifiedReason("cancelled", error);
  }
  if (error.timedOut || error.code === "ETIMEDOUT") {
    return classifiedReason("timed out", error);
  }

  const exitCode = error.codex && error.codex.code;
  if (Number.isInteger(exitCode)) {
    return `Codex exited with code ${exitCode}`;
  }

  if (safeFailurePhase(error)) {
    return extensionFailureReason(error);
  }

  const code = safeFailureCode(error);
  return code ? `process error (code: ${code})` : "process error (unclassified)";
}

function formatSafeFailureReason(error) {
  return getFailureReason(error);
}

function formatFailureLog(details = {}) {
  const targetSections = details.targetSections || details.emptySections || [];
  const error = details.error || {};
  const codex = error.codex || {};
  const timestamp = details.timestamp || new Date().toISOString();
  const processStarted = didCodexProcessStart(details, error);
  const entry = [
    "",
    "========================================",
    `[${timestamp}] Codex Note Helper failure`,
    `reason: ${getFailureReason(error)}`,
    `target heading count: ${targetSections.length}`,
    `cancelled: ${Boolean(error.cancelled || error.code === "ABORT_ERR")}`,
    `timed out: ${Boolean(error.timedOut || error.code === "ETIMEDOUT")}`,
    `Codex process started: ${processStarted ? "yes" : "no"}`
  ];
  if (processStarted) {
    entry.push(
      `stdout truncated: ${Boolean(codex.stdoutTruncated)}`,
      `stderr truncated: ${Boolean(codex.stderrTruncated)}`
    );
  }
  entry.push("");

  // Prompts, model output, stderr, paths, arguments, headings, and stack traces
  // are intentionally never written.
  return truncateForLog(
    entry.join("\n"),
    details.maxLogChars || DEFAULT_MAX_LOG_CHARS
  );
}

module.exports = {
  buildCodexArgs,
  formatSafeFailureReason,
  formatFailureLog,
  truncateForLog
};
