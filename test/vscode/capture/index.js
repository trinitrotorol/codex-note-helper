"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "trinitrotorol.codex-note-helper";
const POLL_INTERVAL_MS = 50;
const STAGE_TIMEOUT_MS = 45_000;
const GENERATED_MARKDOWN = [
  "Hamiltonian simulation approximates quantum time evolution with a circuit.",
  "",
  "- Encode the dynamics as unitary operations.",
  "- Balance circuit depth against approximation error.",
  "- Validate accuracy on a small synthetic model first."
].join("\n");

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function controlDirectory() {
  const value = process.env.CNH_DEMO_CONTROL_DIR;
  assert.ok(value && path.isAbsolute(value), "CNH_DEMO_CONTROL_DIR is required.");
  return value;
}

async function writeStage(stage) {
  const directory = controlDirectory();
  const destination = path.join(directory, `${stage}.ready.json`);
  const temporary = `${destination}.tmp`;
  await fs.promises.writeFile(
    temporary,
    `${JSON.stringify({ stage })}\n`,
    { encoding: "utf8", flag: "wx" }
  );
  await fs.promises.rename(temporary, destination);
}

async function waitFor(check, label, timeoutMs = STAGE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await delay(POLL_INTERVAL_MS);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function waitForGate(gate) {
  const gatePath = path.join(controlDirectory(), `${gate}.go`);
  await waitFor(
    async () => Boolean(await fs.promises.stat(gatePath, { throwIfNoEntry: false })),
    `capture gate '${gate}'`
  );
}

function allTabs() {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

function isOwnedReviewTab(tab) {
  const input = tab && tab.input;
  return Boolean(
    input &&
      input.original &&
      input.modified &&
      input.original.scheme === "codex-note-helper-preview" &&
      input.modified.scheme === "codex-note-helper-preview"
  );
}

function markdownPreviewTabs() {
  return allTabs().filter(
    (tab) =>
      tab.input &&
      typeof tab.input.viewType === "string" &&
      tab.input.viewType.toLowerCase().includes("markdown")
  );
}

async function arrangeDemoEditors(document) {
  await vscode.commands.executeCommand("notifications.clearAll");
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await vscode.commands.executeCommand("workbench.action.closeSidebar");
  await vscode.commands.executeCommand("workbench.action.closePanel");
  const commands = await vscode.commands.getCommands(true);
  if (commands.includes("workbench.action.closeAuxiliaryBar")) {
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
  }
  await vscode.commands.executeCommand("workbench.action.editorLayoutTwoColumns");

  const editor = await vscode.window.showTextDocument(document, {
    preserveFocus: false,
    preview: false,
    viewColumn: vscode.ViewColumn.One
  });
  editor.selection = new vscode.Selection(0, 0, 0, 0);
  editor.revealRange(
    new vscode.Range(0, 0, 0, 0),
    vscode.TextEditorRevealType.AtTop
  );

  await vscode.commands.executeCommand("markdown.showPreviewToSide");
  await waitFor(
    () => markdownPreviewTabs().length === 1,
    "the Markdown preview"
  );
  await vscode.window.showTextDocument(document, {
    preserveFocus: false,
    preview: false,
    viewColumn: vscode.ViewColumn.One
  });
  await delay(700);
}

async function waitForReview() {
  await waitFor(
    () => allTabs().some(isOwnedReviewTab),
    "the generated review diff"
  );
}

async function cleanup(document, originalText) {
  if (!document.isClosed && document.getText() !== originalText) {
    await vscode.window.showTextDocument(document, {
      preserveFocus: false,
      preview: false,
      viewColumn: vscode.ViewColumn.One
    });
    await vscode.commands.executeCommand("undo");
  }
  assert.equal(document.getText(), originalText, "Capture cleanup must restore the fixture.");
  assert.equal(document.isDirty, false, "Capture cleanup must leave no dirty fixture.");
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

async function runCapture(extension, runtime, document, originalText) {
  assert.equal(typeof runtime.__captureRequestApply, "function");
  const {
    applyGeneratedSectionUpdates,
    findTargetHeadingSections
  } = require(path.join(extension.extensionPath, "lib", "noteParser.js"));
  const targets = findTargetHeadingSections(originalText, 1, "emptyOnly");
  assert.equal(targets.length, 1);
  const application = applyGeneratedSectionUpdates(originalText, targets, [
    { id: targets[0].id, content: GENERATED_MARKDOWN }
  ]);

  await writeStage("01-edit-preview");
  await waitForGate("start-generation");

  await vscode.window.withProgress(
    {
      cancellable: false,
      location: vscode.ProgressLocation.Notification,
      title: "Generating a preview for 1 section(s) with Codex"
    },
    async (progress) => {
      progress.report({ message: "Generating structured note updates" });
      await writeStage("02-generation-started");
      await waitForGate("finish-generation");
    }
  );

  const controller = new AbortController();
  const state = { review: undefined };
  const reviewPromise = runtime.__captureRequestApply({
    application,
    document,
    documentLabel: "note.md",
    onPhase: () => {},
    originalText,
    originalVersion: document.version,
    proposedText: application.text,
    signal: controller.signal,
    state,
    warnings: []
  });
  await waitForReview();
  await writeStage("03-review");

  // The controller clicks the real notification button through the workbench.
  const result = await reviewPromise;
  assert.equal(result && result.applied, true);
  await waitFor(
    () => !allTabs().some(isOwnedReviewTab),
    "the applied review diff to close"
  );
  assert.notEqual(document.getText(), originalText, "Apply must update the note.");
  assert.equal(document.isDirty, true, "The default Apply behavior must stay unsaved.");
  assert.equal(markdownPreviewTabs().length, 1, "Apply must preserve the Markdown preview.");
  vscode.window.showInformationMessage(
    "Applied 1 generated section to 'note.md'. Save the note when ready."
  );
  await writeStage("04-applied");

  await waitForGate("finish");
  await cleanup(document, originalText);
}

async function run() {
  const mode = process.env.CNH_DEMO_MODE;
  assert.equal(mode, "capture", "Invalid CNH_DEMO_MODE.");

  const expectedVersion = process.env.CNH_DEMO_EXPECTED_VERSION;
  const workspacePath = process.env.CNH_DEMO_WORKSPACE;
  assert.ok(expectedVersion, "CNH_DEMO_EXPECTED_VERSION is required.");
  assert.ok(workspacePath && path.isAbsolute(workspacePath), "CNH_DEMO_WORKSPACE is required.");

  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} is not installed.`);
  assert.equal(extension.packageJSON.version, expectedVersion);
  const runtime = await extension.activate();
  assert.ok(runtime, "The isolated capture API was not returned by activation.");

  const noteUri = vscode.Uri.file(path.join(workspacePath, "note.md"));
  const document = await vscode.workspace.openTextDocument(noteUri);
  const originalText = document.getText();
  await arrangeDemoEditors(document);

  try {
    await runCapture(extension, runtime, document, originalText);
  } catch (error) {
    try {
      await writeStage("99-failed");
    } catch (_stageError) {
      // The original error is more useful to the isolated test runner.
    }
    throw error;
  }
}

module.exports = { run };
