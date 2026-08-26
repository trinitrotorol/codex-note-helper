"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

const extensionId = "trinitrotorol.codex-note-helper";
const publicCommands = [
  "codexNoteHelper.fillWithCodex",
  "codexNoteHelper.cancelRun",
  "codexNoteHelper.listTargetHeadings",
  "codexNoteHelper.deleteFailureLog",
  "codexNoteHelper.setMode",
  "codexNoteHelper.setFillPolicy",
  "codexNoteHelper.runDiagnostics"
];

async function run() {
  const extension = vscode.extensions.getExtension(extensionId);
  assert.ok(extension, `${extensionId} was not installed from the VSIX.`);
  assert.equal(extension.packageJSON.version, process.env.CNH_EXPECTED_VERSION);
  assert.equal(extension.packageJSON.main, "./extension.js");
  assert.equal(
    path.resolve(extension.extensionPath) === path.resolve(__dirname, "..", "..", ".."),
    false,
    "The test must activate the installed VSIX, not the source checkout."
  );

  await extension.activate();
  assert.equal(extension.isActive, true);

  const registeredCommands = await vscode.commands.getCommands(true);
  for (const command of publicCommands) {
    assert.equal(
      registeredCommands.includes(command),
      true,
      `Missing packaged command: ${command}`
    );
  }

  const workspacePath = process.env.CNH_TEST_WORKSPACE;
  assert.ok(workspacePath, "CNH_TEST_WORKSPACE was not provided.");
  const noteUri = vscode.Uri.file(path.join(workspacePath, "filled.md"));
  const document = await vscode.workspace.openTextDocument(noteUri);
  await vscode.window.showTextDocument(document, { preview: true });
  const before = document.getText();

  await vscode.commands.executeCommand("codexNoteHelper.listTargetHeadings");
  await vscode.commands.executeCommand("codexNoteHelper.cancelRun");

  assert.equal(document.getText(), before);
  assert.equal(document.isDirty, false);

  const proposedUri = vscode.Uri.file(path.join(workspacePath, "proposed.md"));
  await vscode.commands.executeCommand(
    "vscode.diff",
    noteUri,
    proposedUri,
    "Codex Note Helper packaged apply test",
    { preview: true, viewColumn: vscode.ViewColumn.Beside }
  );
  assert.equal(document.isClosed, false, "The preview note must remain open beside the diff.");
  const packagedRuntime = require(path.join(extension.extensionPath, "extension.js"));
  const insertion = "<!-- packaged-apply-test -->\n";
  await packagedRuntime.applyProposedEdits(document, before, document.version, {
    edits: [{ start: 0, end: 0, replacement: insertion }],
    text: insertion + before,
    updatedCount: 1
  });
  assert.equal(document.getText(), insertion + before);
  assert.equal(document.isDirty, true);
  await vscode.commands.executeCommand("undo");
  assert.equal(document.getText(), before);
  assert.equal(document.isDirty, false);
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

module.exports = { run };
