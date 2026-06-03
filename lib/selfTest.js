const assert = require("node:assert/strict");
const manifest = require("../package.json");
const {
  buildCodexExecPrompt,
  findEmptyHeadingSections,
  findTargetHeadingSections,
  parseHeadingSections
} = require("./noteParser");
const {
  buildCodexArgs,
  formatFailureLog,
  truncateForLog
} = require("./codexRuntime");
const {
  MARKDOWN_PREVIEW_REFRESH_COMMAND
} = require("./vscodeCommands");
const {
  describeCodexEvent,
  estimateProgressPercent,
  parseJsonLine
} = require("./codexProgress");

function runCheck(name, fn) {
  try {
    fn();
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, error };
  }
}

function runSelfTests() {
  const checks = [
    runCheck("detects only empty top-level headings", () => {
      const text = [
        "# Filled",
        "",
        "本文あり",
        "# Empty",
        "",
        "<!-- later -->",
        "",
        "# Also filled",
        "参考文献: example"
      ].join("\n");
      const empty = findEmptyHeadingSections(text, 1);

      assert.deepEqual(
        empty.map((section) => ({
          title: section.title,
          lineNumber: section.lineNumber
        })),
        [{ title: "Empty", lineNumber: 4 }]
      );
    }),
    runCheck("supports CRLF and heading levels", () => {
      const text = [
        "# Parent",
        "parent body",
        "## Empty child",
        "",
        "## Filled child",
        "child body"
      ].join("\r\n");
      const sections = parseHeadingSections(text, 2);

      assert.equal(sections.length, 2);
      assert.equal(sections[0].title, "Empty child");
      assert.equal(sections[0].lineNumber, 3);
      assert.equal(sections[0].isEmpty, true);
      assert.equal(sections[1].isEmpty, false);
    }),
    runCheck("supports bullets-only target policy", () => {
      const text = [
        "# Empty",
        "",
        "# Bullets",
        "- source note",
        "- another source note",
        "",
        "# Prose",
        "already explained"
      ].join("\n");
      const targets = findTargetHeadingSections(
        text,
        1,
        "emptyOrBulletsOnly"
      );

      assert.deepEqual(
        targets.map((section) => section.title),
        ["Empty", "Bullets"]
      );
      assert.equal(targets[1].isBulletsOnly, true);
    }),
    runCheck("prompt includes research note constraints", () => {
      const prompt = buildCodexExecPrompt(
        "C:/notes/note.md",
        [{ title: "量子フーリエ変換", lineNumber: 12, isEmpty: true }],
        {
          mode: "research",
          fillPolicy: "emptyOnly",
          researchField: "量子コンピュータ",
          outputLanguage: "Japanese",
          noteStyle: "説明1段落 + 参考文献1本"
        }
      );

      assert.match(prompt, /量子フーリエ変換 \(line 12\)/);
      assert.match(prompt, /Research field: 量子コンピュータ/);
      assert.match(prompt, /Output language: Japanese/);
      assert.match(prompt, /Add exactly one reference per heading/);
      assert.match(prompt, /edit listed headings only if they are still empty/);
    }),
    runCheck("prompt supports job hunting mode", () => {
      const prompt = buildCodexExecPrompt(
        "C:/notes/companies.md",
        [{ title: "Example Inc.", lineNumber: 3, isBulletsOnly: true }],
        {
          mode: "jobHunting",
          fillPolicy: "emptyOrBulletsOnly",
          outputLanguage: "Japanese"
        }
      );

      assert.match(prompt, /Mode: jobHunting/);
      assert.match(prompt, /Fill policy: emptyOrBulletsOnly/);
      assert.match(prompt, /job hunting notes/);
      assert.match(prompt, /Preserve existing bullets and append after them/);
    }),
    runCheck("codex args are valid for exec", () => {
      const args = buildCodexArgs("C:/workspace", {
        enableWebSearch: true,
        showCodexProgress: true
      });

      assert.deepEqual(args, [
        "--search",
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--sandbox",
        "workspace-write",
        "-C",
        "C:/workspace",
        "-"
      ]);
      assert.equal(args.includes("--ask-for-approval"), false);
    }),
    runCheck("codex progress events are summarized safely", () => {
      const event = parseJsonLine(
        '{"type":"exec_command_begin","command":"Get-Content -LiteralPath C:\\\\private\\\\note.md"}'
      );

      assert.equal(
        describeCodexEvent(event),
        "Codex is running: Get-Content -LiteralPath [path]"
      );
      assert.equal(
        estimateProgressPercent({ type: "turn_complete" }, 60),
        90
      );
    }),
    runCheck("failure logs include useful context", () => {
      const log = formatFailureLog({
        timestamp: "2026-06-01T00:00:00.000Z",
        logLevel: "debug",
        workspaceDir: "C:/workspace",
        fileName: "note.md",
        filePath: "C:/research/note.md",
        command: "codex",
        args: ["exec", "-"],
        emptySections: [{ title: "量子誤り訂正", lineNumber: 20 }],
        error: new Error("boom"),
        stderr: "stderr text",
        stdout: "stdout text",
        prompt: "prompt text"
      });

      assert.match(log, /Research Note Helper failure/);
      assert.match(log, /量子誤り訂正 \(line 20\)/);
      assert.match(log, /Error: boom/);
      assert.match(log, /stderr text/);
      assert.match(log, /stdout text/);
    }),
    runCheck("minimal failure logs avoid prompt and process output", () => {
      const log = formatFailureLog({
        timestamp: "2026-06-01T00:00:00.000Z",
        logLevel: "minimal",
        workspaceName: "workspace",
        workspaceDir: "C:/workspace",
        fileName: "note.md",
        filePath: "C:/workspace/note.md",
        command: "codex",
        emptySections: [{ title: "Private heading", lineNumber: 20 }],
        error: new Error("boom"),
        stderr: "secret stderr",
        stdout: "secret stdout",
        prompt: "secret prompt"
      });

      assert.match(log, /Research Note Helper failure/);
      assert.match(log, /workspace: workspace/);
      assert.match(log, /target heading count: 1/);
      assert.doesNotMatch(log, /C:\/workspace/);
      assert.doesNotMatch(log, /Private heading/);
      assert.doesNotMatch(log, /secret prompt/);
      assert.doesNotMatch(log, /secret stdout/);
      assert.doesNotMatch(log, /secret stderr/);
    }),
    runCheck("log truncation is explicit", () => {
      assert.equal(truncateForLog("abcdefghij", 4), "abcd\n... [truncated 6 chars]");
    }),
    runCheck("manifest contributes shortcut and self-test command", () => {
      const commands = manifest.contributes.commands.map((item) => item.command);
      const keybindings = manifest.contributes.keybindings;
      const paletteCommands = manifest.contributes.menus.commandPalette.map(
        (item) => item.command
      );
      const properties = manifest.contributes.configuration.properties;

      assert.equal(manifest.publisher, "trinitrotorol");
      assert.equal(manifest.license, "MIT");
      assert.deepEqual(manifest.repository, {
        type: "git",
        url: "https://github.com/trinitrotorol/research-note-helper.git"
      });
      assert.deepEqual(manifest.bugs, {
        url: "https://github.com/trinitrotorol/research-note-helper/issues"
      });
      assert.equal(
        manifest.homepage,
        "https://github.com/trinitrotorol/research-note-helper#readme"
      );
      assert.equal(
        manifest.capabilities.untrustedWorkspaces.supported,
        false
      );
      assert.match(
        manifest.capabilities.untrustedWorkspaces.description,
        /external Codex CLI process/
      );
      assert.equal(
        manifest.scripts.package,
        "vsce package --allow-missing-repository"
      );
      assert.equal(manifest.scripts["package:strict"], "vsce package");
      assert.equal(manifest.devDependencies["@vscode/vsce"], "3.9.1");
      assert.equal(manifest.scripts.package.includes("npx"), false);
      assert.equal(commands.includes("researchNoteHelper.fillWithCodex"), true);
      assert.equal(commands.includes("researchNoteHelper.runSelfTest"), true);
      assert.equal(commands.includes("researchNoteHelper.deleteFailureLog"), true);
      assert.equal(commands.includes("researchNoteHelper.setMode"), true);
      assert.equal(commands.includes("researchNoteHelper.setFillPolicy"), true);
      assert.equal(commands.includes("researchNoteHelper.openCodexRequest"), false);
      assert.equal(paletteCommands.includes("researchNoteHelper.runSelfTest"), true);
      assert.equal(
        paletteCommands.includes("researchNoteHelper.deleteFailureLog"),
        true
      );
      assert.equal(paletteCommands.includes("researchNoteHelper.setMode"), true);
      assert.equal(
        paletteCommands.includes("researchNoteHelper.setFillPolicy"),
        true
      );
      assert.equal(
        properties["researchNoteHelper.showCodexProgress"].default,
        true
      );
      assert.deepEqual(keybindings[0], {
        command: "researchNoteHelper.fillWithCodex",
        key: "ctrl+k ctrl+q",
        mac: "cmd+k cmd+q",
        when: "editorTextFocus && editorLangId == markdown"
      });
    }),
    runCheck("uses the VS Code Markdown preview refresh command", () => {
      assert.equal(
        MARKDOWN_PREVIEW_REFRESH_COMMAND,
        "markdown.preview.refresh"
      );
    })
  ];

  const failed = checks.filter((item) => !item.ok).length;
  return {
    passed: checks.length - failed,
    failed,
    results: checks
  };
}

module.exports = {
  runSelfTests
};
