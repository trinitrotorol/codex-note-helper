"use strict";

const REQUIRED_EXEC_FLAGS = [
  "--ephemeral",
  "--ignore-rules",
  "--output-schema",
  "--skip-git-repo-check",
  "--json"
];

const REQUIRED_GLOBAL_FLAGS = [
  "--ask-for-approval",
  "--disable",
  "--sandbox",
  "--search",
  "--cd"
];

function safeVersionText(value) {
  const text = String(value || "").slice(0, 1024);
  const match = text.match(
    /\b(codex(?:-cli)?)\s+v?(\d{1,5}\.\d{1,5}\.\d{1,5})(?=$|[\s(+-])/iu
  );
  if (!match) {
    return "Codex CLI";
  }
  return `${match[1].toLowerCase()} ${match[2]}`;
}

async function probeCodexCli(options) {
  const {
    command,
    cwd,
    runProcess,
    env,
    prefixArgs = [],
    signal,
    ignoreUserConfiguration = true
  } = options;

  if (typeof runProcess !== "function") {
    throw new TypeError("runProcess is required.");
  }
  if (!Array.isArray(prefixArgs)) {
    throw new TypeError("prefixArgs must be an array.");
  }

  const common = {
    command,
    cwd,
    env,
    signal,
    timeoutMs: 15000,
    maxOutputBytes: 256 * 1024
  };
  const versionResult = await runProcess({
    ...common,
    args: [...prefixArgs, "--version"]
  });
  const globalHelpResult = await runProcess({
    ...common,
    args: [...prefixArgs, "--help"]
  });
  const helpResult = await runProcess({
    ...common,
    args: [...prefixArgs, "exec", "--help"]
  });
  const globalHelpText = `${globalHelpResult.stdout || ""}\n${globalHelpResult.stderr || ""}`;
  const helpText = `${helpResult.stdout || ""}\n${helpResult.stderr || ""}`;
  const required = ignoreUserConfiguration
    ? [...REQUIRED_EXEC_FLAGS, "--ignore-user-config"]
    : REQUIRED_EXEC_FLAGS;
  const missing = [
    ...REQUIRED_GLOBAL_FLAGS.filter((flag) => !globalHelpText.includes(flag)),
    ...required.filter((flag) => !helpText.includes(flag))
  ];

  if (missing.length > 0) {
    const error = new Error(
      `The installed Codex CLI is missing required options: ${missing.join(", ")}.`
    );
    error.code = "CODEX_CLI_INCOMPATIBLE";
    error.missingFlags = missing;
    throw error;
  }

  const version = safeVersionText(
    versionResult.stdout || versionResult.stderr || "Codex CLI"
  );
  return { version: version || "Codex CLI", supported: true };
}

module.exports = {
  REQUIRED_EXEC_FLAGS,
  REQUIRED_GLOBAL_FLAGS,
  probeCodexCli,
  safeVersionText
};
