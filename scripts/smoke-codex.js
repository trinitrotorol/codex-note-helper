"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { probeCodexCli } = require("../lib/cliProbe");
const { assertCodexEventPolicy } = require("../lib/codexProgress");
const { resolveCodexExecutable } = require("../lib/executableResolver");
const { buildOutputSchema, parseGeneratedUpdates } = require("../lib/generation");
const { buildCodexArgs } = require("../lib/codexRuntime");
const {
  applyGeneratedSectionUpdates,
  buildCodexExecPrompt,
  findTargetHeadingSections
} = require("../lib/noteParser");
const { runProcess } = require("../lib/processRunner");
const { validateOptions } = require("../lib/settings");

async function main() {
  const requestedCommand = process.argv[2] || "codex";
  const tempRoot = path.resolve(os.tmpdir());
  const runtimeDir = await fs.promises.mkdtemp(
    path.join(tempRoot, "codex-note-helper-smoke-")
  );
  const resolvedRuntime = path.resolve(runtimeDir);
  if (
    path.dirname(resolvedRuntime) !== tempRoot ||
    !path.basename(resolvedRuntime).startsWith("codex-note-helper-smoke-")
  ) {
    throw new Error("Refusing to use an unexpected smoke-test directory.");
  }

  try {
    const options = validateOptions({
      mode: "general",
      fillPolicy: "emptyOnly",
      headingLevel: 1,
      outputLanguage: "English",
      noteStyle: "Return exactly one short, factual sentence.",
      timeoutSeconds: 120,
      maxTargetHeadings: 1,
      maxInputCharacters: 10000,
      maxOutputBytes: 1048576,
      ignoreCodexUserConfiguration: true
    });
    const source = "# Release smoke test\n";
    const targets = findTargetHeadingSections(source, 1, "emptyOnly");
    const schemaPath = path.join(runtimeDir, "output.schema.json");
    await fs.promises.writeFile(
      schemaPath,
      JSON.stringify(buildOutputSchema(targets.length, 2000)),
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );

    const executable = await resolveCodexExecutable({
      command: requestedCommand,
      cwd: runtimeDir,
      workspaceRoots: [process.cwd()]
    });

    const probe = await probeCodexCli({
      command: executable.command,
      prefixArgs: executable.argsPrefix,
      cwd: runtimeDir,
      runProcess,
      ignoreUserConfiguration: true
    });
    const result = await runProcess({
      command: executable.command,
      args: [
        ...executable.argsPrefix,
        ...buildCodexArgs(runtimeDir, {
          ...options,
          outputSchemaPath: schemaPath
        })
      ],
      cwd: runtimeDir,
      input: buildCodexExecPrompt(targets, options),
      timeoutMs: options.timeoutSeconds * 1000,
      maxOutputBytes: options.maxOutputBytes,
      maxLineBytes: options.maxOutputBytes,
      onEvent: (event) => assertCodexEventPolicy(event, options)
    });
    const generated = parseGeneratedUpdates(result.stdout, targets, {
      maxMarkdownCharacters: 2000,
      enableWebSearch: options.enableWebSearch
    });
    const applied = applyGeneratedSectionUpdates(
      source,
      targets,
      generated.updates.map((update) => ({
        id: targets[update.targetIndex].id,
        content: update.markdown
      }))
    );
    if (
      applied.updatedCount !== 1 ||
      !applied.text.includes("codex-note-helper:generated:start")
    ) {
      throw new Error("The smoke-test proposal was not applied as expected.");
    }
    console.log(`Codex smoke test passed (${probe.version}; 1 target).`);
  } finally {
    await fs.promises.rm(resolvedRuntime, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error && error.message ? error.message : "Codex smoke test failed.");
  process.exitCode = 1;
});
