"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  REQUIRED_EXEC_FLAGS,
  REQUIRED_GLOBAL_FLAGS,
  probeCodexCli,
  safeVersionText
} = require("../lib/cliProbe");

test("probeCodexCli verifies the required automation contract", async () => {
  const calls = [];
  const runProcess = async (options) => {
    calls.push(options.args);
    if (options.args[0] === "--version") {
      return { stdout: "codex-cli 1.2.3\n", stderr: "" };
    }
    if (options.args.length === 1) {
      return { stdout: REQUIRED_GLOBAL_FLAGS.join(" "), stderr: "" };
    }
    return {
      stdout: `${REQUIRED_EXEC_FLAGS.join(" ")} --ignore-user-config`,
      stderr: ""
    };
  };

  const result = await probeCodexCli({
    command: "codex",
    cwd: "/safe/runtime",
    runProcess
  });
  assert.deepEqual(calls, [
    ["--version"],
    ["--help"],
    ["exec", "--help"]
  ]);
  assert.deepEqual(result, { version: "codex-cli 1.2.3", supported: true });
});

test("probeCodexCli reports missing required flags", async () => {
  const runProcess = async (options) =>
    options.args[0] === "--version"
      ? { stdout: "old codex", stderr: "" }
      : options.args.length === 1
        ? { stdout: REQUIRED_GLOBAL_FLAGS.join(" "), stderr: "" }
        : { stdout: "--json", stderr: "" };

  await assert.rejects(
    () =>
      probeCodexCli({
        command: "codex",
        cwd: "/safe/runtime",
        runProcess
      }),
    (error) =>
      error.code === "CODEX_CLI_INCOMPATIBLE" &&
      error.missingFlags.includes("--output-schema")
  );
});

test("safeVersionText exposes only an allowlisted Codex name and semver", () => {
  assert.equal(safeVersionText("codex-cli 1.2.3\n"), "codex-cli 1.2.3");
  assert.equal(
    safeVersionText("Codex v0.123.0-beta.1+windows.x64"),
    "codex 0.123.0"
  );
});

test("safeVersionText never returns paths, tokens, controls, or arbitrary output", () => {
  const cases = [
    "C:/private/note.md sk-private-token",
    "codex\\r\\nC:/private/note.md",
    "codex \u00001.2.3 private",
    "codex-cli sk-private-token",
    "old codex without a version"
  ];
  for (const value of cases) {
    assert.equal(safeVersionText(value), "Codex CLI");
  }

  const mixed = safeVersionText(
    "warning C:/private/note.md sk-private-token\ncodex-cli 1.2.3-sk-private-token\nmore private output"
  );
  assert.equal(mixed, "codex-cli 1.2.3");
  assert.equal(mixed.includes("private"), false);
  assert.equal(/[\r\n\t\u0000-\u001f\u007f]/u.test(mixed), false);
});

test("an unrecognized version stays compatible when the required flags exist", async () => {
  const result = await probeCodexCli({
    command: "codex",
    cwd: "/safe/runtime",
    runProcess: async (options) => {
      if (options.args[0] === "--version") {
        return {
          stdout: "C:/private/note.md sk-private-token\n",
          stderr: ""
        };
      }
      return options.args.length === 1
        ? { stdout: REQUIRED_GLOBAL_FLAGS.join(" "), stderr: "" }
        : {
            stdout: `${REQUIRED_EXEC_FLAGS.join(" ")} --ignore-user-config`,
            stderr: ""
          };
    }
  });

  assert.deepEqual(result, { version: "Codex CLI", supported: true });
});

test("probeCodexCli prepends a resolved npm entry point and forwards cancellation", async () => {
  const calls = [];
  const signal = new AbortController().signal;
  await probeCodexCli({
    command: "node.exe",
    prefixArgs: ["C:/npm/node_modules/@openai/codex/bin/codex.js"],
    cwd: "C:/safe/runtime",
    signal,
    runProcess: async (options) => {
      calls.push(options);
      if (options.args.at(-1) === "--version") {
        return { stdout: "codex-cli 1.2.3", stderr: "" };
      }
      return {
        stdout:
          options.args.at(-1) === "--help" && options.args.at(-2) === "exec"
            ? `${REQUIRED_EXEC_FLAGS.join(" ")} --ignore-user-config`
            : REQUIRED_GLOBAL_FLAGS.join(" "),
        stderr: ""
      };
    }
  });
  assert.deepEqual(
    calls.map((call) => call.args),
    [
      ["C:/npm/node_modules/@openai/codex/bin/codex.js", "--version"],
      ["C:/npm/node_modules/@openai/codex/bin/codex.js", "--help"],
      ["C:/npm/node_modules/@openai/codex/bin/codex.js", "exec", "--help"]
    ]
  );
  assert.equal(calls.every((call) => call.signal === signal), true);
});
