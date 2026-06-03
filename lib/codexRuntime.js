function buildCodexArgs(workspaceDir, options = {}) {
  const args = [];

  if (options.enableWebSearch) {
    args.push("--search");
  }

  args.push("exec");

  if (options.showCodexProgress) {
    args.push("--json");
  }

  args.push(
    "--skip-git-repo-check",
    "--sandbox",
    "workspace-write",
    "-C",
    workspaceDir
  );

  args.push("-");
  return args;
}

function truncateForLog(value, maxLength = 60000) {
  if (!value) {
    return "";
  }

  const text = String(value);
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}\n... [truncated ${text.length - maxLength} chars]`;
}

function formatFailureLog(details = {}) {
  const targetSections = details.targetSections || details.emptySections || [];
  const error = details.error || {};
  const timestamp = details.timestamp || new Date().toISOString();
  const logLevel = details.logLevel || "minimal";

  if (logLevel !== "debug") {
    return [
      "",
      "========================================",
      `[${timestamp}] Codex Note Helper failure`,
      `workspace: ${details.workspaceName || ""}`,
      `file: ${details.fileName || ""}`,
      `command: ${details.command || ""}`,
      `target heading count: ${targetSections.length}`,
      "",
      "error:",
      error.message || String(error),
      ""
    ].join("\n");
  }

  const headings = targetSections
    .map((section) => `- ${section.title} (line ${section.lineNumber})`)
    .join("\n");

  return [
    "",
    "========================================",
    `[${timestamp}] Codex Note Helper failure`,
    `workspace: ${details.workspaceDir || ""}`,
    `file: ${details.filePath || ""}`,
    `command: ${details.command || ""}`,
    `args: ${(details.args || []).join(" ")}`,
    "empty headings:",
    headings || "(none)",
    "",
    "error:",
    error.stack || error.message || String(error),
    "",
    "stderr:",
    truncateForLog(details.stderr),
    "",
    "stdout:",
    truncateForLog(details.stdout),
    "",
    "prompt:",
    truncateForLog(details.prompt),
    ""
  ].join("\n");
}

module.exports = {
  buildCodexArgs,
  formatFailureLog,
  truncateForLog
};
