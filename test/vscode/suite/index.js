"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const vscode = require("vscode");

const extensionId = "trinitrotorol.codex-note-helper";
const publicCommands = [
  "codexNoteHelper.fillWithCodex",
  "codexNoteHelper.cancelRun",
  "codexNoteHelper.reopenPendingReview",
  "codexNoteHelper.applyPendingReview",
  "codexNoteHelper.discardPendingReview",
  "codexNoteHelper.listTargetHeadings",
  "codexNoteHelper.deleteFailureLog",
  "codexNoteHelper.setMode",
  "codexNoteHelper.setFillPolicy",
  "codexNoteHelper.runDiagnostics",
  "codexNoteHelper.chooseCliSource"
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
  assert.equal(extension.packageJSON.pricing, "Free");
  assert.equal(extension.packageJSON.contributes.walkthroughs.length, 1);

  const outputLanguage = vscode.workspace
    .getConfiguration("codexNoteHelper")
    .inspect("outputLanguage");
  assert.ok(outputLanguage, "The packaged output-language setting is missing.");
  assert.equal(
    outputLanguage.defaultValue,
    "English",
    "The English extension host must resolve the localized default."
  );

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

  const sourceViewColumn = vscode.window.activeTextEditor.viewColumn;
  await vscode.commands.executeCommand("markdown.showPreviewToSide");
  const allTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs);
  const markdownPreviewTabs = allTabs().filter(
    (tab) =>
      tab.input &&
      typeof tab.input.viewType === "string" &&
      tab.input.viewType.toLowerCase().includes("markdown")
  );
  assert.ok(markdownPreviewTabs.length > 0, "Markdown preview must open beside the note.");
  await vscode.window.showTextDocument(document, {
    preserveFocus: false,
    preview: false,
    viewColumn: sourceViewColumn
  });

  const beforeUri = vscode.Uri.file(path.join(workspacePath, "before.md"));
  const proposedUri = vscode.Uri.file(path.join(workspacePath, "proposed.md"));
  await vscode.commands.executeCommand(
    "vscode.diff",
    beforeUri,
    proposedUri,
    "Codex Note Helper packaged apply test",
    { preview: true, viewColumn: vscode.ViewColumn.Beside }
  );
  assert.equal(document.isClosed, false, "The preview note must remain open beside the diff.");
  const activeTabBeforeApply = vscode.window.tabGroups.activeTabGroup.activeTab;
  const sourceTabs = () =>
    allTabs()
      .filter(
        (tab) =>
          tab.input &&
          tab.input.uri &&
          tab.input.uri.toString() === noteUri.toString()
      );
  const sourceTabsBeforeApply = sourceTabs();
  assert.equal(sourceTabsBeforeApply[0].group.viewColumn, sourceViewColumn);
  const packagedRuntime = require(path.join(extension.extensionPath, "extension.js"));
  const insertion = "<!-- packaged-apply-test -->\n";
  await packagedRuntime.applyProposedEdits(document, before, document.version, {
    edits: [{ start: 0, end: 0, replacement: insertion }],
    text: insertion + before,
    updatedCount: 1
  });
  assert.equal(document.getText(), insertion + before);
  assert.equal(document.isDirty, true);
  assert.equal(
    vscode.window.tabGroups.activeTabGroup.activeTab,
    activeTabBeforeApply,
    "Apply must not change the active tab or editor group."
  );
  assert.equal(
    sourceTabs().length,
    sourceTabsBeforeApply.length,
    "Apply must not open another raw Markdown editor."
  );
  await packagedRuntime.closeGeneratedDiff({
    originalUri: beforeUri,
    proposedUri
  });
  assert.equal(
    allTabs().some(
      (tab) =>
        tab.input &&
        tab.input.original &&
        tab.input.modified &&
        tab.input.original.toString() === beforeUri.toString() &&
        tab.input.modified.toString() === proposedUri.toString()
    ),
    false,
    "Review completion must close the exact generated diff."
  );
  assert.ok(
    markdownPreviewTabs.every((tab) => allTabs().includes(tab)),
    "Closing the generated diff must preserve the Markdown preview."
  );
  await vscode.window.showTextDocument(document, {
    preserveFocus: false,
    preview: false,
    viewColumn: sourceViewColumn
  });
  await vscode.commands.executeCommand("undo");
  assert.equal(document.getText(), before);
  assert.equal(document.isDirty, false);
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
}

module.exports = { run };
