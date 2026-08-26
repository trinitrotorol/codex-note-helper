"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
  runTests
} = require("@vscode/test-electron");

const repoRoot = path.resolve(__dirname, "..", "..");

function argumentValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return fallback;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function installVsix(vscodeExecutablePath, vsixPath) {
  const [cli, ...cliPrefix] = resolveCliArgsFromVSCodeExecutablePath(
    vscodeExecutablePath
  );
  const result = spawnSync(
    cli,
    [...cliPrefix, "--install-extension", vsixPath, "--force"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      shell: process.platform === "win32",
      stdio: "inherit",
      windowsHide: true
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`VSIX installation failed with exit code ${result.status}.`);
  }
}

async function main() {
  const manifest = require(path.join(repoRoot, "package.json"));
  const version = argumentValue("--version", "stable");
  const vsixPath = path.resolve(
    repoRoot,
    argumentValue("--vsix", `codex-note-helper-${manifest.version}.vsix`)
  );
  if (!fs.statSync(vsixPath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`VSIX was not found: ${vsixPath}`);
  }

  const vscodeExecutablePath = await downloadAndUnzipVSCode({
    version,
    timeout: 60_000
  });
  installVsix(vscodeExecutablePath, vsixPath);

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath: path.join(__dirname, "driver"),
    extensionTestsPath: path.join(__dirname, "suite", "index.js"),
    launchArgs: [path.join(__dirname, "workspace")],
    extensionTestsEnv: {
      CNH_EXPECTED_VERSION: manifest.version,
      CNH_TEST_WORKSPACE: path.join(__dirname, "workspace")
    }
  });
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
