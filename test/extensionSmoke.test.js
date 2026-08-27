"use strict";

const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

function translate(message, ...args) {
  return args.reduce(
    (result, value, index) => result.replace(`{${index}}`, String(value)),
    message
  );
}

function createUri(parts) {
  const uri = {
    ...parts,
    fsPath: parts.fsPath || parts.path || "",
    toString() {
      return `${this.scheme || "file"}:${this.path || this.fsPath || ""}`;
    }
  };
  return uri;
}

test("extension entry point activates and registers every command", async () => {
  const commands = new Map();
  const vscodeMock = {
    ConfigurationTarget: { Global: 1, WorkspaceFolder: 3 },
    ProgressLocation: { Notification: 15 },
    StatusBarAlignment: { Right: 2 },
    Uri: {
      from: createUri,
      parse(value) {
        return createUri({ scheme: String(value).split(":", 1)[0], path: value });
      },
      joinPath(base, ...parts) {
        return createUri({
          scheme: base.scheme,
          path: path.join(base.path || base.fsPath, ...parts),
          fsPath: path.join(base.fsPath || base.path, ...parts)
        });
      }
    },
    commands: {
      executeCommand: async () => undefined,
      registerCommand(id, handler) {
        commands.set(id, handler);
        return { dispose() {} };
      }
    },
    extensions: { getExtension: () => undefined },
    l10n: { t: translate },
    window: {
      activeTextEditor: undefined,
      createStatusBarItem() {
        return {
          dispose() {},
          hide() {},
          show() {}
        };
      },
      createOutputChannel() {
        return {
          appendLine() {},
          clear() {},
          dispose() {},
          show() {}
        };
      },
      onDidChangeActiveTextEditor() {
        return { dispose() {} };
      }
    },
    workspace: {
      isTrusted: true,
      onDidChangeTextDocument() {
        return { dispose() {} };
      },
      onDidCloseTextDocument() {
        return { dispose() {} };
      },
      onDidChangeConfiguration() {
        return { dispose() {} };
      },
      getConfiguration() {
        return {
          get(_name, fallback) {
            return fallback;
          },
          async update() {}
        };
      },
      registerTextDocumentContentProvider() {
        return { dispose() {} };
      }
    }
  };
  const context = {
    extension: { packageJSON: { version: "0.3.2" } },
    globalState: { get: () => 0, update: async () => undefined },
    globalStorageUri: createUri({
      scheme: "file",
      path: "C:/extension-storage",
      fsPath: "C:/extension-storage"
    }),
    subscriptions: []
  };

  const originalLoad = Module._load;
  const extensionPath = require.resolve("../extension");
  Module._load = function load(request, parent, isMain) {
    if (request === "vscode") {
      return vscodeMock;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[extensionPath];
    const extension = require(extensionPath);
    extension.activate(context);
    assert.deepEqual([...commands.keys()].sort(), [
      "codexNoteHelper.applyPendingReview",
      "codexNoteHelper.cancelRun",
      "codexNoteHelper.chooseCliSource",
      "codexNoteHelper.deleteFailureLog",
      "codexNoteHelper.discardPendingReview",
      "codexNoteHelper.fillWithCodex",
      "codexNoteHelper.listEmptyHeadings",
      "codexNoteHelper.listTargetHeadings",
      "codexNoteHelper.reopenPendingReview",
      "codexNoteHelper.runDiagnostics",
      "codexNoteHelper.runSelfTest",
      "codexNoteHelper.setFillPolicy",
      "codexNoteHelper.setMode"
    ]);
    await extension.deactivate();
  } finally {
    Module._load = originalLoad;
    delete require.cache[extensionPath];
  }
});
