"use strict";

const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const EXECUTABLE_KEY = "a".repeat(64);
const DEFAULT_TEXT = ["# Empty", "", "# Untouched", "keep", ""].join("\n");
const TEST_FILESYSTEM_ROOT = path.parse(process.cwd()).root;
const TEST_EXTENSION_PATH = path.join(TEST_FILESYSTEM_ROOT, "extension");
const TEST_STORAGE_PATH = path.join(TEST_FILESYSTEM_ROOT, "extension-storage");

function translate(message, ...args) {
  return args.reduce(
    (result, value, index) => result.replace(`{${index}}`, String(value)),
    message
  );
}

function createUri(parts) {
  return {
    ...parts,
    fsPath: parts.fsPath || parts.path || "",
    toString() {
      return `${this.scheme || "file"}:${this.path || this.fsPath || ""}`;
    }
  };
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function settleWithin(promise, milliseconds = 500) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("operation did not settle in time")),
          milliseconds
        );
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function structuredStdout(markdown = "Generated paragraph.") {
  return [
    JSON.stringify({
      type: "item.completed",
      item: {
        type: "agent_message",
        text: JSON.stringify({
          updates: [{ targetIndex: 0, markdown }],
          warnings: []
        })
      }
    }),
    JSON.stringify({ type: "turn.completed" })
  ].join("\n");
}

function createDocument(
  initialText = DEFAULT_TEXT,
  fsPath = path.join(path.parse(process.cwd()).root, "notes", "example.md")
) {
  let text = initialText;
  const document = {
    isClosed: false,
    languageId: "markdown",
    uri: createUri({
      scheme: "file",
      path: "/notes/example.md",
      fsPath
    }),
    version: 1,
    getText() {
      return text;
    },
    positionAt(offset) {
      return { offset };
    },
    replaceText(nextText) {
      text = nextText;
      this.version += 1;
    }
  };
  return document;
}

function createWorkflowHarness(options = {}) {
  const extensionPath = require.resolve("../extension");
  const commands = new Map();
  const executedCommands = [];
  const diffCalls = [];
  const editCalls = [];
  const resolverCalls = [];
  const informationMessages = [];
  const warningMessages = [];
  const errorMessages = [];
  const diagnostics = [];
  const failureLogs = [];
  const runProcessCalls = [];
  let contentProvider;
  const document = createDocument(options.text, options.documentFsPath);
  const reviewStarted = createDeferred();
  const reviewDecision = createDeferred();
  const resolverStarted = createDeferred();
  const resolverDecision = createDeferred();
  let changeDocumentListener;
  let closeDocumentListener;
  const errorDecision = createDeferred();
  const successDecision = createDeferred();

  class Range {
    constructor(start, end) {
      this.start = start;
      this.end = end;
    }
  }

  class Position {
    constructor(line, character) {
      this.line = line;
      this.character = character;
    }
  }

  class Selection extends Range {}

  const editor = {
    document,
    edit: async (callback, editOptions) => {
      const replacements = [];
      callback({
        replace(range, replacement) {
          replacements.push({ range, replacement });
        }
      });
      editCalls.push({ options: editOptions, replacements });
      if (options.editorEditResult === false) {
        return false;
      }

      let updatedText = document.getText();
      for (const operation of [...replacements].sort(
        (left, right) => right.range.start.offset - left.range.start.offset
      )) {
        updatedText =
          updatedText.slice(0, operation.range.start.offset) +
          operation.replacement +
          updatedText.slice(operation.range.end.offset);
      }
      document.replaceText(updatedText);
      return true;
    },
    revealRange() {}
  };

  const configValues = {
    allowBundledCodexFromOpenAIExtension: false,
    codexCommand: "codex",
    confirmBeforeRun: "never",
    enableWebSearch: false,
    fillPolicy: "emptyOnly",
    headingLevel: 1,
    ignoreCodexUserConfiguration: true,
    maxInputCharacters: 100000,
    maxOutputBytes: 65536,
    maxTargetHeadings: 25,
    mode: "general",
    noteStyle: "brief",
    outputLanguage: "Japanese",
    researchField: "",
    showCodexProgress: false,
    timeoutSeconds: 30,
    ...options.configuration
  };

  const workspace = {
    isTrusted: true,
    textDocuments: [document],
    workspaceFolders: [],
    asRelativePath(uri) {
      return path.basename(uri.path);
    },
    getConfiguration() {
      return {
        get(name, fallback) {
          return Object.prototype.hasOwnProperty.call(configValues, name)
            ? configValues[name]
            : fallback;
        },
        async update() {}
      };
    },
    getWorkspaceFolder() {
      return undefined;
    },
    onDidChangeTextDocument(listener) {
      changeDocumentListener = listener;
      return { dispose() {} };
    },
    onDidCloseTextDocument(listener) {
      closeDocumentListener = listener;
      return { dispose() {} };
    },
    registerTextDocumentContentProvider(_scheme, provider) {
      contentProvider = provider;
      return { dispose() {} };
    }
  };

  const vscodeMock = {
    ConfigurationTarget: { Global: 1, WorkspaceFolder: 3 },
    Position,
    ProgressLocation: { Notification: 15 },
    Range,
    Selection,
    ViewColumn: { Beside: -2 },
    Uri: {
      from: createUri,
      joinPath(base, ...parts) {
        return createUri({
          scheme: base.scheme,
          path: path.join(base.path || base.fsPath, ...parts),
          fsPath: path.join(base.fsPath || base.path, ...parts)
        });
      },
      parse(value) {
        return createUri({
          scheme: String(value).split(":", 1)[0],
          path: String(value)
        });
      }
    },
    commands: {
      async executeCommand(id, ...args) {
        executedCommands.push({ args, id });
        const handler = commands.get(id);
        if (handler) {
          return handler(...args);
        }
        if (id === "vscode.diff") {
          diffCalls.push(args);
        }
        return undefined;
      },
      registerCommand(id, handler) {
        commands.set(id, handler);
        return { dispose() {} };
      }
    },
    extensions: { getExtension: () => undefined },
    env: { remoteName: undefined },
    l10n: { t: translate },
    window: {
      activeTextEditor: editor,
      createOutputChannel() {
        return {
          appendLine(line) {
            diagnostics.push(line);
          },
          clear() {},
          dispose() {},
          show() {}
        };
      },
      async showErrorMessage(message, ...actions) {
        errorMessages.push({ actions, message });
        if (options.deferErrorMessage) {
          return errorDecision.promise;
        }
        return undefined;
      },
      async showInformationMessage(message, ...actions) {
        informationMessages.push({ actions, message });
        if (message.startsWith("Review the generated update")) {
          if (options.documentTransition === "closed") {
            document.isClosed = true;
          } else if (options.documentTransition === "reopened") {
            workspace.textDocuments = [
              createDocument(document.getText(), document.uri.fsPath)
            ];
          }
          reviewStarted.resolve();
          if (options.deferReview) {
            return reviewDecision.promise;
          }
          return options.reviewChoice === "discard"
            ? actions.find((action) => action === "Discard")
            : actions.find((action) => action === "Apply changes");
        }
        if (
          options.failSuccessNotification &&
          message.startsWith("Applied ")
        ) {
          throw new Error("notification unavailable");
        }
        if (options.deferSuccessNotification && message.startsWith("Applied ")) {
          return successDecision.promise;
        }
        return undefined;
      },
      async showTextDocument(openDocument) {
        assert.equal(openDocument, document);
        return editor;
      },
      async showQuickPick() {
        return undefined;
      },
      async showWarningMessage(message) {
        warningMessages.push(message);
        return undefined;
      },
      async withProgress(_progressOptions, operation) {
        return operation(
          { report() {} },
          { onCancellationRequested: () => ({ dispose() {} }) }
        );
      }
    },
    workspace
  };

  const state = new Map([
    ["privacyConsentVersion", 1],
    ["approvedExecutableFingerprints", [EXECUTABLE_KEY]]
  ]);
  const context = {
    extension: { packageJSON: { version: "0.3.0" } },
    extensionUri: createUri({
      scheme: "file",
      path: "/extension",
      fsPath: TEST_EXTENSION_PATH
    }),
    globalState: {
      get(key, fallback) {
        return state.has(key) ? state.get(key) : fallback;
      },
      async update(key, value) {
        state.set(key, value);
      }
    },
    globalStorageUri: createUri({
      scheme: "file",
      path: "/extension-storage",
      fsPath: TEST_STORAGE_PATH
    }),
    subscriptions: []
  };

  const dependencyMocks = new Map([
    [
      "./lib/cliProbe",
      { probeCodexCli: async () => ({ compatible: true, version: "test" }) }
    ],
    [
      "./lib/executableResolver",
      {
        async resolveCodexExecutable(resolveOptions) {
          resolverCalls.push(resolveOptions);
          resolverStarted.resolve(resolveOptions);
          if (options.deferExecutableResolution) {
            return resolverDecision.promise;
          }
          const executableKeys = options.executableKeys || [EXECUTABLE_KEY];
          const executableKey =
            executableKeys[Math.min(resolverCalls.length - 1, executableKeys.length - 1)];
          return {
            argsPrefix: [],
            command: "C:\\tools\\codex.exe",
            entryPath: "C:\\tools\\codex.exe",
            identity: { key: executableKey },
            source: "absolute"
          };
        }
      }
    ],
    [
      "./lib/logStore",
      {
        async appendFailureLog(directory, entry) {
          failureLogs.push({ directory, entry });
        },
        async deleteFailureLog() {
          return true;
        },
        async getFailureLogInfo() {
          return { exists: false };
        }
      }
    ],
    [
      "./lib/processRunner",
      {
        async runProcess(runOptions) {
          runProcessCalls.push(runOptions);
          if (options.runResult === "forbidden-tool") {
            runOptions.onEvent({
              type: "item.started",
              item: { type: "command_execution" }
            });
          }
          if (options.runResult === "invalid-structured-output") {
            return {
              stderr: "",
              stdout: [
                JSON.stringify({
                  type: "item.completed",
                  item: { type: "agent_message", text: "not JSON" }
                }),
                JSON.stringify({ type: "turn.completed" })
              ].join("\n")
            };
          }
          return { stderr: "", stdout: structuredStdout(options.markdown) };
        }
      }
    ]
  ]);
  const fsMock = {
    promises: {
      async mkdir() {},
      async unlink() {},
      async writeFile() {}
    }
  };

  const originalLoad = Module._load;
  let extension;
  Module._load = function load(request, parent, isMain) {
    if (parent && parent.filename === extensionPath) {
      if (request === "vscode") {
        return vscodeMock;
      }
      if (request === "node:fs") {
        return fsMock;
      }
      if (dependencyMocks.has(request)) {
        return dependencyMocks.get(request);
      }
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    delete require.cache[extensionPath];
    extension = require(extensionPath);
  } finally {
    Module._load = originalLoad;
  }
  extension.activate(context);

  return {
    changeDocument(nextText = `${document.getText()}\nchanged`) {
      document.replaceText(nextText);
      changeDocumentListener({
        contentChanges: [{ rangeLength: 0, text: "changed" }],
        document
      });
    },
    signalNonContentDocumentChange() {
      changeDocumentListener({ contentChanges: [], document });
    },
    closeDocument() {
      document.isClosed = true;
      workspace.textDocuments = [];
      closeDocumentListener(document);
    },
    commands,
    contentProvider,
    context,
    diagnostics,
    diffCalls,
    document,
    editCalls,
    errorMessages,
    executedCommands,
    extension,
    failureLogs,
    informationMessages,
    rejectExecutableResolution(error) {
      resolverDecision.reject(error);
    },
    resolverCalls,
    resolverStarted: resolverStarted.promise,
    resolveExecutableResolution(value = {
      argsPrefix: [],
      command: "C:\\tools\\codex.exe",
      entryPath: "C:\\tools\\codex.exe",
      identity: { key: EXECUTABLE_KEY },
      source: "absolute"
    }) {
      resolverDecision.resolve(value);
    },
    resolveReview(choice = "Apply changes") {
      reviewDecision.resolve(choice);
    },
    resolveErrorMessage(choice) {
      errorDecision.resolve(choice);
    },
    resolveSuccessMessage(choice) {
      successDecision.resolve(choice);
    },
    reviewStarted: reviewStarted.promise,
    runProcessCalls,
    vscode: vscodeMock,
    warningMessages,
    workspace,
    async dispose() {
      await extension.deactivate();
      delete require.cache[extensionPath];
    }
  };
}

async function withHarness(options, operation) {
  const harness = createWorkflowHarness(options);
  try {
    return await operation(harness);
  } finally {
    await harness.dispose();
  }
}

test("public fill command previews a diff and applies only validated target ranges", async () => {
  await withHarness({}, async (harness) => {
    const originalText = harness.document.getText();
    await harness.vscode.commands.executeCommand("codexNoteHelper.fillWithCodex");

    assert.equal(harness.runProcessCalls.length, 1);
    assert.equal(harness.resolverCalls.length, 3);
    for (const resolverCall of harness.resolverCalls) {
      assert.ok(
        resolverCall.protectedDirectories.includes(
          path.dirname(harness.document.uri.fsPath)
        ),
        "the standalone note directory must be protected from executable discovery"
      );
    }
    assert.equal(
      harness.runProcessCalls[0].maxLineBytes,
      harness.runProcessCalls[0].maxOutputBytes
    );
    assert.ok(harness.runProcessCalls[0].timeoutMs > 0);
    assert.ok(harness.runProcessCalls[0].timeoutMs <= 30_000);
    assert.equal(harness.diffCalls.length, 1);
    assert.deepEqual(harness.diffCalls[0][3], {
      preview: true,
      viewColumn: -2
    });
    assert.equal(
      harness.contentProvider.provideTextDocumentContent(
        harness.diffCalls[0][0]
      ),
      ""
    );
    assert.equal(
      harness.contentProvider.provideTextDocumentContent(
        harness.diffCalls[0][1]
      ),
      ""
    );
    const review = harness.informationMessages.find(({ message }) =>
      message.startsWith("Review the generated update")
    );
    assert.ok(review);
    assert.deepEqual(review.actions, ["Apply changes", "Discard"]);
    assert.equal(harness.editCalls.length, 1);
    assert.deepEqual(harness.editCalls[0].options, {
      undoStopAfter: true,
      undoStopBefore: true
    });
    assert.equal(harness.editCalls[0].replacements.length, 1);

    const [{ range }] = harness.editCalls[0].replacements;
    const untouchedStart = originalText.indexOf("# Untouched");
    assert.ok(range.start.offset >= "# Empty\n".length);
    assert.ok(range.end.offset <= untouchedStart);
    assert.notDeepEqual(
      [range.start.offset, range.end.offset],
      [0, originalText.length]
    );
    assert.equal(
      harness.document.getText().slice(
        harness.document.getText().indexOf("# Untouched")
      ),
      originalText.slice(untouchedStart)
    );
    assert.match(
      harness.document.getText(),
      /<!-- codex-note-helper:generated:start id=heading-[a-f0-9]{64}-1 -->\nGenerated paragraph\./u
    );
  });
});

test("an approved executable is fingerprinted again before probe and generation", async () => {
  await withHarness(
    { executableKeys: [EXECUTABLE_KEY, "b".repeat(64)] },
    async (harness) => {
      const originalText = harness.document.getText();
      await harness.vscode.commands.executeCommand(
        "codexNoteHelper.fillWithCodex"
      );

      assert.equal(harness.resolverCalls.length, 2);
      assert.equal(harness.runProcessCalls.length, 0);
      assert.equal(harness.editCalls.length, 0);
      assert.equal(harness.document.getText(), originalText);
      assert.ok(
        harness.errorMessages.some(({ message }) =>
          message.includes("rejected by the safety checks")
        )
      );
    }
  );
});

test("standalone executable protection is recursive except at the user home", async (t) => {
  await t.test("ordinary standalone folder", async () => {
    const noteDirectory = path.join(os.homedir(), "notes-project");
    await withHarness(
      { documentFsPath: path.join(noteDirectory, "note.md") },
      async (harness) => {
        await harness.vscode.commands.executeCommand(
          "codexNoteHelper.fillWithCodex"
        );
        for (const call of harness.resolverCalls) {
          assert.ok(call.workspaceRoots.includes(noteDirectory));
        }
      }
    );
  });

  await t.test("home directory", async () => {
    await withHarness(
      { documentFsPath: path.join(os.homedir(), "note.md") },
      async (harness) => {
        await harness.vscode.commands.executeCommand(
          "codexNoteHelper.fillWithCodex"
        );
        for (const call of harness.resolverCalls) {
          assert.equal(call.workspaceRoots.includes(os.homedir()), false);
          assert.ok(call.protectedDirectories.includes(os.homedir()));
        }
      }
    );
  });
});

test("cancelling through the public command during review applies nothing", async () => {
  await withHarness({ deferReview: true }, async (harness) => {
    const originalText = harness.document.getText();
    const fillPromise = harness.vscode.commands.executeCommand(
      "codexNoteHelper.fillWithCodex"
    );
    await harness.reviewStarted;
    await harness.vscode.commands.executeCommand("codexNoteHelper.cancelRun");
    harness.resolveReview();
    await fillPromise;

    assert.equal(harness.diffCalls.length, 1);
    assert.equal(harness.editCalls.length, 0);
    assert.equal(harness.document.getText(), originalText);
    assert.ok(
      harness.warningMessages.some((message) => message.includes("cancelled"))
    );
  });
});

test("cancel releases a run blocked in executable resolution", async () => {
  const harness = createWorkflowHarness({ deferExecutableResolution: true });
  try {
    const fillPromise = harness.vscode.commands.executeCommand(
      "codexNoteHelper.fillWithCodex"
    );
    const resolveOptions = await harness.resolverStarted;
    assert.ok(resolveOptions.signal);

    await harness.vscode.commands.executeCommand("codexNoteHelper.cancelRun");
    await settleWithin(fillPromise);

    assert.equal(resolveOptions.signal.aborted, true);
    assert.equal(harness.runProcessCalls.length, 0);
    assert.equal(harness.editCalls.length, 0);
    assert.ok(
      harness.warningMessages.some((message) => message.includes("cancelled"))
    );

    // A late resolver failure must remain observed after cancellation wins.
    harness.rejectExecutableResolution(new Error("late resolver failure"));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    await harness.dispose();
  }
});

test("editing or closing a note aborts wasted generation as a document change", async (t) => {
  for (const transition of ["change", "close"]) {
    await t.test(transition, async () => {
      const harness = createWorkflowHarness({ deferExecutableResolution: true });
      try {
        const fillPromise = harness.vscode.commands.executeCommand(
          "codexNoteHelper.fillWithCodex"
        );
        const resolveOptions = await harness.resolverStarted;
        if (transition === "change") {
          harness.changeDocument();
        } else {
          harness.closeDocument();
        }
        await settleWithin(fillPromise);
        assert.equal(resolveOptions.signal.aborted, true);
        harness.rejectExecutableResolution(new Error("late resolver failure"));
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(
          harness.errorMessages.some(({ message }) =>
            message.includes("note changed during generation")
          )
        );
        assert.equal(
          harness.warningMessages.some((message) => message.includes("cancelled")),
          false
        );
      } finally {
        await harness.dispose();
      }
    });
  }
});

test("a non-content document notification does not abort generation", async () => {
  const harness = createWorkflowHarness({ deferExecutableResolution: true });
  try {
    const fillPromise = harness.vscode.commands.executeCommand(
      "codexNoteHelper.fillWithCodex"
    );
    const resolveOptions = await harness.resolverStarted;

    harness.signalNonContentDocumentChange();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resolveOptions.signal.aborted, false);

    await harness.vscode.commands.executeCommand("codexNoteHelper.cancelRun");
    await settleWithin(fillPromise);
    harness.rejectExecutableResolution(new Error("late resolver failure"));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    await harness.dispose();
  }
});

test("deactivate releases a run blocked in executable resolution", async () => {
  const harness = createWorkflowHarness({ deferExecutableResolution: true });
  const fillPromise = harness.vscode.commands.executeCommand(
    "codexNoteHelper.fillWithCodex"
  );
  await harness.resolverStarted;

  await settleWithin(harness.dispose());
  await settleWithin(fillPromise);
  harness.rejectExecutableResolution(new Error("late resolver failure"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.runProcessCalls.length, 0);
  assert.equal(harness.editCalls.length, 0);
});

test("the generation deadline covers executable resolution", async () => {
  const harness = createWorkflowHarness({ deferExecutableResolution: true });
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const deadlineTimers = [];
  global.setTimeout = (callback, milliseconds, ...args) => {
    if (milliseconds >= 29_000 && milliseconds <= 30_000) {
      const handle = {
        active: true,
        callback: () => {
          if (handle.active) {
            handle.active = false;
            callback(...args);
          }
        },
        milliseconds,
        unref() {}
      };
      deadlineTimers.push(handle);
      return handle;
    }
    return originalSetTimeout(callback, milliseconds, ...args);
  };
  global.clearTimeout = (handle) => {
    if (handle && deadlineTimers.includes(handle)) {
      handle.active = false;
      return;
    }
    originalClearTimeout(handle);
  };

  try {
    const fillPromise = harness.vscode.commands.executeCommand(
      "codexNoteHelper.fillWithCodex"
    );
    await harness.resolverStarted;
    const deadlineTimer = deadlineTimers.find((handle) => handle.active);
    assert.ok(deadlineTimer);
    deadlineTimer.callback();
    await settleWithin(fillPromise);

    assert.equal(harness.runProcessCalls.length, 0);
    assert.equal(harness.editCalls.length, 0);
    assert.ok(
      harness.errorMessages.some(({ message }) => message.includes("timed out"))
    );
    harness.rejectExecutableResolution(new Error("late resolver failure"));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    await harness.dispose();
  }
});

test("diagnostics times out while executable resolution is blocked", async () => {
  const harness = createWorkflowHarness({ deferExecutableResolution: true });
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const deadlineTimers = [];
  global.setTimeout = (callback, milliseconds, ...args) => {
    if (milliseconds >= 29_000 && milliseconds <= 30_000) {
      const handle = {
        active: true,
        callback: () => {
          if (handle.active) {
            handle.active = false;
            callback(...args);
          }
        },
        unref() {}
      };
      deadlineTimers.push(handle);
      return handle;
    }
    return originalSetTimeout(callback, milliseconds, ...args);
  };
  global.clearTimeout = (handle) => {
    if (handle && deadlineTimers.includes(handle)) {
      handle.active = false;
      return;
    }
    originalClearTimeout(handle);
  };

  try {
    const diagnosticsPromise = harness.vscode.commands.executeCommand(
      "codexNoteHelper.runDiagnostics"
    );
    await harness.resolverStarted;
    const deadlineTimer = deadlineTimers.find((handle) => handle.active);
    assert.ok(deadlineTimer);
    deadlineTimer.callback();
    await settleWithin(diagnosticsPromise);

    assert.ok(harness.diagnostics.some((line) => line.includes("FAIL")));
    assert.ok(
      harness.diagnostics.some((line) => line.includes("timed out"))
    );
    assert.ok(
      harness.errorMessages.some(({ message }) =>
        message.includes("diagnostics failed")
      )
    );
    harness.rejectExecutableResolution(new Error("late resolver failure"));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
    await harness.dispose();
  }
});

test("diagnostics is single-flight and deactivation cancels a blocked probe", async () => {
  const harness = createWorkflowHarness({ deferExecutableResolution: true });
  const diagnosticsPromise = harness.vscode.commands.executeCommand(
    "codexNoteHelper.runDiagnostics"
  );
  await harness.resolverStarted;

  await harness.vscode.commands.executeCommand("codexNoteHelper.runDiagnostics");
  assert.equal(harness.resolverCalls.length, 1);
  assert.ok(
    harness.informationMessages.some(({ message }) =>
      message.includes("diagnostics are already running")
    )
  );

  await settleWithin(harness.dispose());
  await settleWithin(diagnosticsPromise);
  harness.rejectExecutableResolution(new Error("late diagnostics resolver failure"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(harness.diagnostics.some((line) => line.includes("CANCELLED")));
});

test("a closed or reopened document cannot be edited after review", async (t) => {
  for (const documentTransition of ["closed", "reopened"]) {
    await t.test(documentTransition, async () => {
      await withHarness({ documentTransition }, async (harness) => {
        const originalText = harness.document.getText();
        await harness.vscode.commands.executeCommand(
          "codexNoteHelper.fillWithCodex"
        );

        assert.equal(harness.editCalls.length, 0);
        assert.equal(harness.document.getText(), originalText);
        assert.ok(
          harness.errorMessages.some(({ message }) =>
            message.includes("note changed during generation")
          )
        );
      });
    });
  }
});

test("discard and TextEditor.edit=false both leave the document unchanged", async (t) => {
  await t.test("explicit discard", async () => {
    await withHarness({ reviewChoice: "discard" }, async (harness) => {
      const originalText = harness.document.getText();
      await harness.vscode.commands.executeCommand("codexNoteHelper.fillWithCodex");

      assert.equal(harness.editCalls.length, 0);
      assert.equal(harness.document.getText(), originalText);
      assert.ok(
        harness.informationMessages.some(({ message }) =>
          message.includes("changes were discarded")
        )
      );
    });
  });

  await t.test("TextEditor.edit resolves false", async () => {
    await withHarness({ editorEditResult: false }, async (harness) => {
      const originalText = harness.document.getText();
      await harness.vscode.commands.executeCommand("codexNoteHelper.fillWithCodex");

      assert.equal(harness.editCalls.length, 1);
      assert.equal(harness.document.getText(), originalText);
      assert.ok(
        harness.errorMessages.some(({ message }) =>
          message.includes("could not safely apply")
        )
      );
    });
  });
});

test("forbidden tool events and invalid structured output never reach review or apply", async (t) => {
  const scenarios = [
    {
      expectedMessage: "attempted an operation disabled",
      runResult: "forbidden-tool"
    },
    {
      expectedMessage: "invalid structured response",
      runResult: "invalid-structured-output"
    }
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.runResult, async () => {
      await withHarness({ runResult: scenario.runResult }, async (harness) => {
        const originalText = harness.document.getText();
        await harness.vscode.commands.executeCommand(
          "codexNoteHelper.fillWithCodex"
        );

        assert.equal(harness.diffCalls.length, 0);
        assert.equal(harness.editCalls.length, 0);
        assert.equal(harness.document.getText(), originalText);
        assert.ok(
          harness.errorMessages.some(({ message }) =>
            message.includes(scenario.expectedMessage)
          )
        );
      });
    });
  }
});

test("malformed Markdown is reported as a document problem without misleading settings actions", async () => {
  await withHarness(
    {
      text: [
        "# Broken",
        "<!-- codex-note-helper:generated:start id=not-valid -->",
        "content"
      ].join("\n")
    },
    async (harness) => {
      await harness.vscode.commands.executeCommand(
        "codexNoteHelper.listTargetHeadings"
      );

      assert.equal(harness.resolverCalls.length, 0);
      assert.equal(harness.errorMessages.length, 1);
      assert.match(harness.errorMessages[0].message, /malformed Markdown/u);
      assert.deepEqual(harness.errorMessages[0].actions, ["Open failure log"]);
      assert.match(
        harness.failureLogs[0].entry,
        /extension validation failure \(parse\)/u
      );
    }
  );
});

test("terminal notifications do not retain run locks or block deactivation", async (t) => {
  await t.test("failure action", async () => {
    const harness = createWorkflowHarness({
      deferErrorMessage: true,
      runResult: "invalid-structured-output"
    });
    try {
      await settleWithin(
        harness.vscode.commands.executeCommand("codexNoteHelper.fillWithCodex")
      );
      await settleWithin(
        harness.vscode.commands.executeCommand("codexNoteHelper.fillWithCodex")
      );
      assert.equal(harness.runProcessCalls.length, 2);
      assert.equal(
        harness.warningMessages.some((message) =>
          message.includes("already running")
        ),
        false
      );
      await settleWithin(harness.dispose());
      harness.resolveErrorMessage();
    } finally {
      harness.resolveErrorMessage();
    }
  });

  await t.test("success notification", async () => {
    const harness = createWorkflowHarness({ deferSuccessNotification: true });
    try {
      await settleWithin(
        harness.vscode.commands.executeCommand("codexNoteHelper.fillWithCodex")
      );
      assert.equal(harness.editCalls.length, 1);
      await settleWithin(harness.dispose());
      harness.resolveSuccessMessage();
    } finally {
      harness.resolveSuccessMessage();
    }
  });
});

test("a failed post-apply notification does not report that nothing was applied", async () => {
  await withHarness({ failSuccessNotification: true }, async (harness) => {
    const originalText = harness.document.getText();
    await harness.vscode.commands.executeCommand("codexNoteHelper.fillWithCodex");

    assert.equal(harness.editCalls.length, 1);
    assert.notEqual(harness.document.getText(), originalText);
    assert.equal(harness.errorMessages.length, 0);
    assert.equal(
      [...harness.informationMessages, ...harness.errorMessages].some(({ message }) =>
        message.includes("nothing was applied")
      ),
      false
    );
    assert.ok(
      harness.diagnostics.some((line) =>
        line.includes("confirmation could not be shown")
      )
    );
  });
});
