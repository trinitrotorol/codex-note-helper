const vscode = require("vscode");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const {
  buildCodexExecPrompt,
  findTargetHeadingSections
} = require("./lib/noteParser");
const {
  buildCodexArgs,
  formatFailureLog
} = require("./lib/codexRuntime");
const {
  createLineCollector,
  describeCodexEvent,
  estimateProgressPercent,
  parseJsonLine,
  truncateMessage
} = require("./lib/codexProgress");
const { runSelfTests } = require("./lib/selfTest");
const {
  MARKDOWN_PREVIEW_REFRESH_COMMAND
} = require("./lib/vscodeCommands");

let testOutputChannel;
let extensionContext;

function getStoredSetting(name, fallback) {
  if (!extensionContext) {
    return fallback;
  }

  const workspaceValue = extensionContext.workspaceState.get(name);
  if (workspaceValue !== undefined) {
    return workspaceValue;
  }

  const globalValue = extensionContext.globalState.get(name);
  return globalValue !== undefined ? globalValue : fallback;
}

function getConfig() {
  const config = vscode.workspace.getConfiguration("researchNoteHelper");
  return {
    mode: getStoredSetting("mode", config.get("mode", "research")),
    fillPolicy: getStoredSetting(
      "fillPolicy",
      config.get("fillPolicy", "emptyOnly")
    ),
    researchField: config.get("researchField", ""),
    outputLanguage: config.get("outputLanguage", "Japanese"),
    noteStyle: config.get(
      "noteStyle",
      ""
    ),
    headingLevel: config.get("headingLevel", 1),
    codexCommand: config.get("codexCommand", "codex"),
    allowBundledCodexFromOpenAIExtension: config.get(
      "allowBundledCodexFromOpenAIExtension",
      false
    ),
    enableWebSearch: config.get("enableWebSearch", false),
    showCodexProgress: config.get("showCodexProgress", true),
    logFileName: config.get("logFileName", "research-note-helper.log"),
    logLevel: config.get("logLevel", "minimal")
  };
}

function getConfigurationTarget() {
  return vscode.workspace.workspaceFolders
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
}

function getStateStore() {
  if (!extensionContext) {
    return undefined;
  }

  return vscode.workspace.workspaceFolders
    ? extensionContext.workspaceState
    : extensionContext.globalState;
}

async function updateUserSetting(name, value) {
  const config = vscode.workspace.getConfiguration("researchNoteHelper");

  try {
    await config.update(name, value, getConfigurationTarget());
    const stateStore = getStateStore();
    if (stateStore) {
      await stateStore.update(name, undefined);
    }
    return "settings";
  } catch (error) {
    const stateStore = getStateStore();
    if (!stateStore) {
      throw error;
    }

    await stateStore.update(name, value);
    vscode.window.showWarningMessage(
      `Saved ${name} in extension state because VS Code has not registered the setting yet. Reload Window when convenient.`
    );
    return "state";
  }
}

function getActiveMarkdownEditor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage("No active editor.");
    return undefined;
  }

  const { document } = editor;
  const isMarkdown =
    document.languageId === "markdown" ||
    document.fileName.toLowerCase().endsWith(".md");

  if (!isMarkdown) {
    vscode.window.showWarningMessage("Open a Markdown note first.");
    return undefined;
  }

  return editor;
}

async function saveIfDirty(document) {
  if (!document.isDirty) {
    return true;
  }

  return document.save();
}

function getWorkspaceDir(document) {
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (folder) {
    return folder.uri.fsPath;
  }

  return path.dirname(document.uri.fsPath);
}

function normalizeCommand(command) {
  return String(command || "codex").trim().replace(/^"(.+)"$/, "$1");
}

function getCodexCommand(options) {
  const configured = normalizeCommand(options.codexCommand);

  if (configured !== "codex") {
    return configured;
  }

  if (!options.allowBundledCodexFromOpenAIExtension) {
    return configured;
  }

  const chatgpt = vscode.extensions.getExtension("openai.chatgpt");
  if (!chatgpt || process.platform !== "win32") {
    return configured;
  }

  const bundled = path.join(
    chatgpt.extensionPath,
    "bin",
    "windows-x86_64",
    "codex.exe"
  );

  return fs.existsSync(bundled) ? bundled : configured;
}

function assertPathInside(parentDir, targetPath) {
  const parent = path.resolve(parentDir);
  const target = path.resolve(targetPath);
  const relative = path.relative(parent, target);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Log file path must stay inside the workspace.");
  }
}

function getLogFilePathFromWorkspace(workspaceDir, options) {
  const name = options.logFileName || "research-note-helper.log";
  if (path.isAbsolute(name)) {
    throw new Error("Log file name must be workspace-relative.");
  }

  const logPath = path.resolve(workspaceDir, name);
  assertPathInside(workspaceDir, logPath);
  return logPath;
}

function getLogFilePath(document, options) {
  return getLogFilePathFromWorkspace(getWorkspaceDir(document), options);
}

async function appendFailureLog(document, options, details) {
  const logPath = getLogFilePath(document, options);
  const error = details.error || {};
  const codex = error.codex || {};
  const entry = formatFailureLog({
    logLevel: options.logLevel,
    workspaceName: path.basename(getWorkspaceDir(document)),
    workspaceDir: getWorkspaceDir(document),
    fileName: path.basename(document.uri.fsPath),
    filePath: document.uri.fsPath,
    command: codex.command || details.command || options.codexCommand,
    args: codex.args || details.args || [],
    targetSections: details.targetSections,
    error,
    stderr: codex.stderr,
    stdout: codex.stdout,
    prompt: details.prompt
  });

  await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
  await fs.promises.appendFile(logPath, entry, "utf8");
  return logPath;
}

async function openLogFile(logPath) {
  const doc = await vscode.workspace.openTextDocument(logPath);
  await vscode.window.showTextDocument(doc, { preview: false });
}

async function syncEditorFromDisk(editor) {
  const { document } = editor;
  if (document.isDirty) {
    vscode.window.showWarningMessage(
      "Codex updated the file, but the editor changed while Codex was running. Skipped preview sync to avoid overwriting edits."
    );
    return false;
  }

  const bytes = await vscode.workspace.fs.readFile(document.uri);
  const diskText = Buffer.from(bytes).toString("utf8");
  const editorText = document.getText();

  if (diskText === editorText) {
    return false;
  }

  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(editorText.length)
  );

  const applied = await editor.edit(
    (editBuilder) => {
      editBuilder.replace(fullRange, diskText);
    },
    {
      undoStopBefore: false,
      undoStopAfter: false
    }
  );

  if (applied && document.isDirty) {
    await document.save();
  }

  return applied;
}

async function refreshMarkdownPreviews() {
  try {
    await vscode.commands.executeCommand(MARKDOWN_PREVIEW_REFRESH_COMMAND);
    return true;
  } catch (error) {
    console.warn(`Research Note Helper could not refresh Markdown previews: ${error.message}`);
    return false;
  }
}

function createProgressReporter(progress) {
  let percent = 0;

  return (nextPercent, message) => {
    const normalizedPercent = Math.max(percent, Math.min(100, nextPercent));
    const increment = normalizedPercent - percent;
    percent = normalizedPercent;

    progress.report({
      increment,
      message: `${percent}% - ${truncateMessage(message)}`
    });
  };
}

function reportCodexProgress(event, state, report) {
  const message = describeCodexEvent(event);
  if (!message) {
    return;
  }

  state.percent = estimateProgressPercent(event, state.percent);
  report(state.percent, message);
}

function createCancellationError() {
  const error = new Error("Codex run cancelled.");
  error.cancelled = true;
  return error;
}

function runCodexExec(prompt, document, options, runOptions = {}) {
  return new Promise((resolve, reject) => {
    const workspaceDir = getWorkspaceDir(document);
    const args = buildCodexArgs(workspaceDir, options);
    const command = getCodexCommand(options);
    const progressState = { percent: 12 };
    const report = runOptions.reportProgress;
    const token = runOptions.token;
    const child = spawn(command, args, {
      cwd: workspaceDir,
      shell: false,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const stdoutLines = createLineCollector((line) => {
      const event = parseJsonLine(line);
      if (event && report) {
        reportCodexProgress(event, progressState, report);
      }
    });
    const stderrLines = createLineCollector(() => {});

    function rejectOnce(error) {
      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    }

    function resolveOnce(value) {
      if (settled) {
        return;
      }

      settled = true;
      resolve(value);
    }

    const cancellation = token && token.onCancellationRequested(() => {
      const error = createCancellationError();
      error.codex = { command, args, stdout, stderr };
      child.kill();
      rejectOnce(error);
    });

    if (report) {
      report(12, "Started Codex");
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stdoutLines.push(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      stderrLines.push(text);
    });
    child.on("error", (error) => {
      if (cancellation) {
        cancellation.dispose();
      }
      error.codex = { command, args, stdout, stderr };
      rejectOnce(error);
    });
    child.on("close", (code) => {
      if (cancellation) {
        cancellation.dispose();
      }
      stdoutLines.flush();
      stderrLines.flush();

      if (settled) {
        return;
      }

      if (code === 0) {
        resolveOnce({ command, args, stdout, stderr });
        return;
      }

      const processMessage = stderr.trim() || stdout.trim();
      const message =
        options.logLevel === "debug" && processMessage
          ? processMessage
          : `Codex exited with ${code}.`;
      const error = new Error(message);
      error.codex = { command, args, code, stdout, stderr };
      rejectOnce(error);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

async function fillWithCodex() {
  const editor = getActiveMarkdownEditor();
  if (!editor) {
    return;
  }

  const { document } = editor;
  const saved = await saveIfDirty(document);
  if (!saved) {
    vscode.window.showWarningMessage("Could not save the note before running Codex.");
    return;
  }

  const options = getConfig();
  const targetSections = findTargetHeadingSections(
    document.getText(),
    options.headingLevel,
    options.fillPolicy
  );

  if (targetSections.length === 0) {
    vscode.window.showInformationMessage(
      `No target headings found for policy '${options.fillPolicy}'.`
    );
    return;
  }

  const prompt = buildCodexExecPrompt(document.fileName, targetSections, options);

  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Updating ${targetSections.length} research note heading(s) with Codex`,
        cancellable: true
      },
      async (progress, token) => {
        const report = createProgressReporter(progress);
        report(5, `Found ${targetSections.length} target heading(s)`);
        await runCodexExec(prompt, document, options, {
          reportProgress: report,
          token
        });
        report(90, "Codex finished");
        report(94, "Syncing editor from disk");
        await syncEditorFromDisk(editor);
        report(97, "Refreshing Markdown previews");
        await refreshMarkdownPreviews();
        report(100, "Done");
      }
    );
  } catch (error) {
    if (error.cancelled) {
      let logPath;
      try {
        logPath = await appendFailureLog(document, options, {
          targetSections,
          error,
          prompt
        });
      } catch (_logError) {
        vscode.window.showWarningMessage("Codex run cancelled.");
        return;
      }

      vscode.window.showWarningMessage(
        `Codex run cancelled. Error log saved to ${path.basename(logPath)}.`
      );
      return;
    }

    let logPath;
    try {
      logPath = await appendFailureLog(document, options, {
        targetSections,
        error,
        prompt
      });
    } catch (logError) {
      vscode.window.showErrorMessage(
        `Codex failed, and writing the log also failed: ${logError.message}`
      );
      return;
    }

    const choice = await vscode.window.showErrorMessage(
      `Codex failed. Error log saved to ${path.basename(logPath)}.`,
      "Open Log"
    );

    if (choice === "Open Log") {
      await openLogFile(logPath);
    }
    return;
  }

  await vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
  vscode.window.showInformationMessage(
    `Updated ${targetSections.length} research note heading(s).`
  );
}

async function listEmptyHeadings() {
  const editor = getActiveMarkdownEditor();
  if (!editor) {
    return;
  }

  const options = getConfig();
  const targetSections = findTargetHeadingSections(
    editor.document.getText(),
    options.headingLevel,
    options.fillPolicy
  );

  if (targetSections.length === 0) {
    vscode.window.showInformationMessage(
      `No target headings found for policy '${options.fillPolicy}'.`
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    targetSections.map((section) => ({
      label: section.title,
      description: `line ${section.lineNumber}`,
      detail: section.isEmpty
        ? "empty"
        : section.isBulletsOnly
          ? "bullets-only"
          : "has content"
    })),
    { placeHolder: `Target headings (${options.fillPolicy})` }
  );

  if (!picked) {
    return;
  }

  const line = Number(picked.description.replace("line ", "")) - 1;
  const position = new vscode.Position(line, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position));
}

async function setModeCommand() {
  const config = vscode.workspace.getConfiguration("researchNoteHelper");
  const current = config.get("mode", "research");
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "research",
        description: "paper-based research notes",
        detail: "Concise explanation plus paper references."
      },
      {
        label: "general",
        description: "general note completion",
        detail: "Concise explanatory notes without mandatory references."
      },
      {
        label: "jobHunting",
        description: "company and job-hunting notes",
        detail: "Company summaries, selection notes, and questions."
      }
    ],
    {
      placeHolder: `Current mode: ${current}`
    }
  );

  if (!picked) {
    return;
  }

  await updateUserSetting("mode", picked.label);
  vscode.window.showInformationMessage(`Research Note Helper mode: ${picked.label}`);
}

async function setFillPolicyCommand() {
  const config = vscode.workspace.getConfiguration("researchNoteHelper");
  const current = config.get("fillPolicy", "emptyOnly");
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: "emptyOnly",
        description: "empty headings only",
        detail: "Safest option. Skips headings that already have notes."
      },
      {
        label: "emptyOrBulletsOnly",
        description: "empty or bullets-only headings",
        detail: "Useful when existing bullets are rough source notes."
      },
      {
        label: "appendAlways",
        description: "append to every heading",
        detail: "Most aggressive. Existing content is preserved and appended to."
      }
    ],
    {
      placeHolder: `Current fill policy: ${current}`
    }
  );

  if (!picked) {
    return;
  }

  await updateUserSetting("fillPolicy", picked.label);
  vscode.window.showInformationMessage(
    `Research Note Helper fill policy: ${picked.label}`
  );
}

function getWorkspaceDirForLogCommand() {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.scheme === "file") {
    return getWorkspaceDir(editor.document);
  }

  const folder = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0];
  return folder ? folder.uri.fsPath : undefined;
}

async function deleteFailureLogCommand() {
  const workspaceDir = getWorkspaceDirForLogCommand();
  if (!workspaceDir) {
    vscode.window.showWarningMessage("Open a workspace or file before deleting the log.");
    return;
  }

  const options = getConfig();
  let logPath;
  try {
    logPath = getLogFilePathFromWorkspace(workspaceDir, options);
  } catch (error) {
    vscode.window.showErrorMessage(`Invalid log file setting: ${error.message}`);
    return;
  }

  if (!fs.existsSync(logPath)) {
    vscode.window.showInformationMessage(
      `No failure log found at ${path.relative(workspaceDir, logPath)}.`
    );
    return;
  }

  const relativeLogPath = path.relative(workspaceDir, logPath);
  const choice = await vscode.window.showWarningMessage(
    `Delete ${relativeLogPath}? This cannot be undone.`,
    { modal: true },
    "Delete Log"
  );

  if (choice !== "Delete Log") {
    return;
  }

  await vscode.workspace.fs.delete(vscode.Uri.file(logPath));
  await vscode.commands.executeCommand("workbench.files.action.refreshFilesExplorer");
  vscode.window.showInformationMessage(`Deleted ${relativeLogPath}.`);
}

async function runSelfTestCommand() {
  const result = runSelfTests();
  if (!testOutputChannel) {
    testOutputChannel = vscode.window.createOutputChannel(
      "Research Note Helper Tests"
    );
  }

  testOutputChannel.clear();
  testOutputChannel.appendLine("Research Note Helper self test");
  testOutputChannel.appendLine(`passed: ${result.passed}`);
  testOutputChannel.appendLine(`failed: ${result.failed}`);
  testOutputChannel.appendLine("");

  result.results.forEach((item) => {
    testOutputChannel.appendLine(`${item.ok ? "PASS" : "FAIL"} ${item.name}`);
    if (!item.ok) {
      testOutputChannel.appendLine(item.error.stack || item.error.message);
      testOutputChannel.appendLine("");
    }
  });

  testOutputChannel.show(true);

  if (result.failed > 0) {
    vscode.window.showErrorMessage(
      `Research Note Helper self test failed: ${result.failed} failure(s).`
    );
    return;
  }

  vscode.window.showInformationMessage(
    `Research Note Helper self test passed: ${result.passed} checks.`
  );
}

function activate(context) {
  extensionContext = context;
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "researchNoteHelper.fillWithCodex",
      fillWithCodex
    ),
    vscode.commands.registerCommand(
      "researchNoteHelper.listEmptyHeadings",
      listEmptyHeadings
    ),
    vscode.commands.registerCommand(
      "researchNoteHelper.deleteFailureLog",
      deleteFailureLogCommand
    ),
    vscode.commands.registerCommand(
      "researchNoteHelper.setMode",
      setModeCommand
    ),
    vscode.commands.registerCommand(
      "researchNoteHelper.setFillPolicy",
      setFillPolicyCommand
    ),
    vscode.commands.registerCommand(
      "researchNoteHelper.runSelfTest",
      runSelfTestCommand
    )
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  deleteFailureLogCommand,
  refreshMarkdownPreviews,
  setFillPolicyCommand,
  setModeCommand,
  syncEditorFromDisk
};
