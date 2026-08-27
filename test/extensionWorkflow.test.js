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

async function waitForCondition(predicate, attempts = 50) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition was not reached in time");
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
  fsPath = path.join(path.parse(process.cwd()).root, "notes", "example.md"),
  uriPath = "/notes/example.md"
) {
  let text = initialText;
  const document = {
    isClosed: false,
    languageId: "markdown",
    uri: createUri({
      scheme: "file",
      path: uriPath,
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
  const configUpdates = [];
  const contextKeys = new Map();
  const quickPickCalls = [];
  const statusBarItems = [];
  const quickPickSelections = [...(options.quickPickSelections || [])];
  const editorsByDocument = new Map();
  const reviewCountWaiters = [];
  let contentProvider;
  const document = createDocument(options.text, options.documentFsPath);
  const reviewStarted = createDeferred();
  const reviewDecision = createDeferred();
  const resolverStarted = createDeferred();
  const resolverDecision = createDeferred();
  let changeDocumentListener;
  let closeDocumentListener;
  let changeConfigurationListener;
  let activeTextEditorListener;
  const errorDecision = createDeferred();
  const successDecision = createDeferred();
  let editAttempt = 0;
  let reviewCount = 0;
  let showTextDocumentAttempt = 0;

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

  function createEditor(targetDocument) {
    const targetEditor = {
      document: targetDocument,
      edit: async (callback, editOptions) => {
        const replacements = [];
        callback({
          replace(range, replacement) {
            replacements.push({ range, replacement });
          }
        });
        editCalls.push({
          document: targetDocument,
          options: editOptions,
          replacements
        });
        const configuredResult = Array.isArray(options.editorEditResults)
          ? options.editorEditResults[
              Math.min(editAttempt, options.editorEditResults.length - 1)
            ]
          : options.editorEditResult;
        editAttempt += 1;
        if (configuredResult === false) {
          return false;
        }

        let updatedText = targetDocument.getText();
        for (const operation of [...replacements].sort(
          (left, right) => right.range.start.offset - left.range.start.offset
        )) {
          updatedText =
            updatedText.slice(0, operation.range.start.offset) +
            operation.replacement +
            updatedText.slice(operation.range.end.offset);
        }
        targetDocument.replaceText(updatedText);
        return true;
      },
      revealRange() {}
    };
    editorsByDocument.set(targetDocument, targetEditor);
    return targetEditor;
  }

  const editor = createEditor(document);

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
  const explicitlyConfiguredValues = new Set(
    Object.keys(options.configuration || {})
  );

  const workspace = {
    isTrusted: true,
    textDocuments: [document],
    workspaceFolders: [],
    asRelativePath(uri) {
      return path.basename(uri.path);
    },
    getConfiguration(section, resource) {
      return {
        get(name, fallback) {
          return Object.prototype.hasOwnProperty.call(configValues, name)
            ? configValues[name]
            : fallback;
        },
        inspect(name) {
          return {
            defaultValue: undefined,
            globalValue: explicitlyConfiguredValues.has(name)
              ? configValues[name]
              : undefined
          };
        },
        async update(name, value, target) {
          configValues[name] = value;
          explicitlyConfiguredValues.add(name);
          configUpdates.push({ name, resource, section, target, value });
          if (typeof options.afterConfigurationUpdate === "function") {
            await options.afterConfigurationUpdate({
              configValues,
              name,
              target,
              value
            });
          }
          if (changeConfigurationListener) {
            changeConfigurationListener({
              affectsConfiguration(key) {
                return key === `${section}.${name}`;
              }
            });
          }
        }
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
    onDidChangeConfiguration(listener) {
      changeConfigurationListener = listener;
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
    StatusBarAlignment: { Right: 2 },
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
        if (id === "setContext") {
          contextKeys.set(args[0], args[1]);
        }
        return undefined;
      },
      registerCommand(id, handler) {
        commands.set(id, handler);
        return { dispose() {} };
      }
    },
    extensions: {
      getExtension(id) {
        return id === "openai.chatgpt" ? options.openAiExtension : undefined;
      }
    },
    env: { remoteName: undefined },
    l10n: { t: translate },
    window: {
      activeTextEditor: editor,
      createStatusBarItem() {
        const item = {
          visible: false,
          dispose() {
            this.visible = false;
          },
          hide() {
            this.visible = false;
          },
          show() {
            this.visible = true;
          }
        };
        statusBarItems.push(item);
        return item;
      },
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
        if (options.errorChoice) {
          return actions.find((action) => action === options.errorChoice);
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
          reviewCount += 1;
          for (const waiter of [...reviewCountWaiters]) {
            if (reviewCount >= waiter.count) {
              reviewCountWaiters.splice(reviewCountWaiters.indexOf(waiter), 1);
              waiter.resolve();
            }
          }
          if (options.deferReview) {
            return reviewDecision.promise;
          }
          if (options.reviewChoice === "dismiss") {
            return undefined;
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
        const failureLimit = options.showTextDocumentFailures || 0;
        showTextDocumentAttempt += 1;
        if (showTextDocumentAttempt <= failureLimit) {
          throw new Error("editor unavailable");
        }
        const targetEditor = editorsByDocument.get(openDocument);
        assert.ok(targetEditor, "the requested document must have an editor");
        vscodeMock.window.activeTextEditor = targetEditor;
        if (activeTextEditorListener) {
          activeTextEditorListener(targetEditor);
        }
        return targetEditor;
      },
      async showQuickPick(items, quickPickOptions) {
        quickPickCalls.push({ items, options: quickPickOptions });
        const selection = quickPickSelections.length
          ? quickPickSelections.shift()
          : options.quickPickValue;
        if (!selection) {
          return undefined;
        }
        return items.find(
          (item) => item.value === selection || item.label === selection
        );
      },
      async showWarningMessage(message, ...actions) {
        warningMessages.push(message);
        if (options.warningChoice) {
          return actions.find((action) => action === options.warningChoice);
        }
        return undefined;
      },
      onDidChangeActiveTextEditor(listener) {
        activeTextEditorListener = listener;
        return { dispose() {} };
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
    extension: { packageJSON: { version: "0.3.1" } },
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
          if (options.resolverError) {
            throw options.resolverError;
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
    lstatSync() {
      if (!options.bundledCandidateAvailable) {
        const error = new Error("not found");
        error.code = "ENOENT";
        throw error;
      }
      return {
        isFile: () => true,
        isSymbolicLink: () => false
      };
    },
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
    addDocument(
      initialText = DEFAULT_TEXT,
      fsPath = path.join(path.parse(process.cwd()).root, "notes", "second.md"),
      uriPath = "/notes/second.md"
    ) {
      const addedDocument = createDocument(initialText, fsPath, uriPath);
      const addedEditor = createEditor(addedDocument);
      workspace.textDocuments.push(addedDocument);
      return { document: addedDocument, editor: addedEditor };
    },
    changeDocument(nextText = `${document.getText()}\nchanged`) {
      document.replaceText(nextText);
      changeDocumentListener({
        contentChanges: [{ rangeLength: 0, text: "changed" }],
        document
      });
    },
    changeConfiguration(name, value) {
      configValues[name] = value;
      explicitlyConfiguredValues.add(name);
      if (changeConfigurationListener) {
        changeConfigurationListener({
          affectsConfiguration(key) {
            return key === `codexNoteHelper.${name}`;
          }
        });
      }
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
    configUpdates,
    configValues,
    contentProvider,
    contextKeys,
    context,
    diagnostics,
    diffCalls,
    document,
    editCalls,
    errorMessages,
    executedCommands,
    extension,
    failureLogs,
    focusEditor(nextEditor) {
      vscodeMock.window.activeTextEditor = nextEditor;
      if (activeTextEditorListener) {
        activeTextEditorListener(nextEditor);
      }
    },
    informationMessages,
    quickPickCalls,
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
    selectQuickPick(value) {
      quickPickSelections.push(value);
    },
    reviewStarted: reviewStarted.promise,
    runProcessCalls,
    statusBarItems,
    vscode: vscodeMock,
    warningMessages,
    waitForReviewCount(count) {
      if (reviewCount >= count) {
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        reviewCountWaiters.push({ count, resolve });
      });
    },
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

test("CLI source selection requires explicit bundled opt-in and starts no process", async () => {
  await withHarness(
    {
      bundledCandidateAvailable: true,
      openAiExtension: { extensionPath: "C:\\official-openai-extension" },
      quickPickValue: "bundled",
      warningChoice: "Use bundled CLI"
    },
    async (harness) => {
      await harness.vscode.commands.executeCommand(
        "codexNoteHelper.chooseCliSource"
      );

      assert.deepEqual(
        harness.configUpdates.map(({ name, target, value }) => ({
          name,
          target,
          value
        })),
        [
          { name: "codexCommand", target: 1, value: "codex" },
          {
            name: "allowBundledCodexFromOpenAIExtension",
            target: 1,
            value: true
          }
        ]
      );
      assert.equal(
        harness.contextKeys.get("codexNoteHelper.cliSourceConfigured"),
        true
      );
      assert.equal(harness.resolverCalls.length, 0);
      assert.equal(harness.runProcessCalls.length, 0);
    }
  );
});

test("PATH CLI selection is single-flight and disables bundled fallback first", async () => {
  await withHarness(
    {
      configuration: { allowBundledCodexFromOpenAIExtension: true },
      quickPickValue: "path"
    },
    async (harness) => {
      const first = harness.vscode.commands.executeCommand(
        "codexNoteHelper.chooseCliSource"
      );
      const second = harness.vscode.commands.executeCommand(
        "codexNoteHelper.chooseCliSource"
      );
      await Promise.all([first, second]);

      assert.equal(harness.quickPickCalls.length, 1);
      assert.deepEqual(
        harness.configUpdates.map(({ name, value }) => ({ name, value })),
        [
          {
            name: "allowBundledCodexFromOpenAIExtension",
            value: false
          },
          { name: "codexCommand", value: "codex" }
        ]
      );
      assert.equal(
        harness.contextKeys.get("codexNoteHelper.cliSourceConfigured"),
        true
      );
      assert.equal(harness.resolverCalls.length, 0);
      assert.equal(harness.runProcessCalls.length, 0);
    }
  );
});

test("CLI selection verifies the final effective settings before completion", async () => {
  await withHarness(
    {
      afterConfigurationUpdate({ configValues, name }) {
        if (name === "codexCommand") {
          configValues.allowBundledCodexFromOpenAIExtension = true;
        }
      },
      quickPickValue: "path"
    },
    async (harness) => {
      await harness.vscode.commands.executeCommand(
        "codexNoteHelper.chooseCliSource"
      );

      assert.equal(
        harness.contextKeys.get("codexNoteHelper.cliSourceConfigured"),
        false
      );
      assert.ok(
        harness.errorMessages.some(({ message }) =>
          message.includes("setting is invalid")
        )
      );
      assert.equal(
        harness.informationMessages.some(({ message }) =>
          message.includes("CLI on PATH is selected")
        ),
        false
      );
    }
  );
});

test("a valid absolute CLI setting completes the chooser walkthrough step", async () => {
  await withHarness({ quickPickValue: "settings" }, async (harness) => {
    await harness.vscode.commands.executeCommand(
      "codexNoteHelper.chooseCliSource"
    );

    assert.ok(
      harness.executedCommands.some(
        ({ args, id }) =>
          id === "workbench.action.openSettings" &&
          args[0] === "codexNoteHelper.codexCommand"
      )
    );
    assert.notEqual(
      harness.contextKeys.get("codexNoteHelper.cliSourceConfigured"),
      true
    );

    harness.changeConfiguration("codexCommand", "C:\\trusted\\codex.exe");
    assert.equal(
      harness.contextKeys.get("codexNoteHelper.cliSourceConfigured"),
      true
    );
    assert.equal(
      harness.contextKeys.get("codexNoteHelper.initialDiagnosticsPassed"),
      false
    );

    harness.changeConfiguration("codexCommand", "codex --unsafe");
    assert.equal(
      harness.contextKeys.get("codexNoteHelper.cliSourceConfigured"),
      false
    );
  });
});

test("activation restores only an explicitly configured CLI source", async (t) => {
  await t.test("default PATH command remains unselected", async () => {
    await withHarness({}, async (harness) => {
      assert.equal(
        harness.contextKeys.get("codexNoteHelper.cliSourceConfigured"),
        false
      );
    });
  });

  for (const [name, configuration] of [
    ["absolute path", { codexCommand: "C:\\trusted\\codex.exe" }],
    [
      "bundled opt-in",
      { allowBundledCodexFromOpenAIExtension: true }
    ]
  ]) {
    await t.test(name, async () => {
      await withHarness({ configuration }, async (harness) => {
        assert.equal(
          harness.contextKeys.get("codexNoteHelper.cliSourceConfigured"),
          true
        );
      });
    });
  }
});

test("missing CLI offers the bundled setting without enabling it automatically", async () => {
  const resolverError = new Error("private path C:/secret/codex.exe");
  resolverError.code = "EXECUTABLE_NOT_FOUND";
  resolverError.phase = "preflight";
  await withHarness(
    {
      bundledCandidateAvailable: true,
      errorChoice: "Open bundled CLI setting",
      openAiExtension: { extensionPath: "C:\\official-openai-extension" },
      resolverError
    },
    async (harness) => {
      await harness.vscode.commands.executeCommand(
        "codexNoteHelper.fillWithCodex"
      );
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(harness.runProcessCalls.length, 0);
      assert.equal(harness.configUpdates.length, 0);
      const errorUi = harness.errorMessages.find(({ actions }) =>
        actions.includes("Open bundled CLI setting")
      );
      assert.ok(errorUi);
      assert.ok(
        harness.executedCommands.some(
          ({ args, id }) =>
            id === "workbench.action.openSettings" &&
            args[0] ===
              "codexNoteHelper.allowBundledCodexFromOpenAIExtension"
        )
      );
      assert.equal(harness.failureLogs.length, 1);
      assert.match(
        harness.failureLogs[0].entry,
        /preflight; code: EXECUTABLE_NOT_FOUND/u
      );
      assert.match(
        harness.failureLogs[0].entry,
        /Codex process started: no/u
      );
      assert.equal(harness.failureLogs[0].entry.includes("C:/secret"), false);
    }
  );
});

test("successful diagnostics completes onboarding without generation", async () => {
  await withHarness({}, async (harness) => {
    await harness.vscode.commands.executeCommand(
      "codexNoteHelper.runDiagnostics"
    );

    assert.equal(harness.runProcessCalls.length, 0);
    assert.equal(
      harness.contextKeys.get("codexNoteHelper.initialDiagnosticsPassed"),
      true
    );
    assert.ok(harness.diagnostics.some((line) => line.includes("PASS")));
  });
});

test("diagnostics cannot pass after its CLI settings change", async () => {
  const harness = createWorkflowHarness({ deferExecutableResolution: true });
  try {
    const diagnosticsPromise = harness.vscode.commands.executeCommand(
      "codexNoteHelper.runDiagnostics"
    );
    await harness.resolverStarted;
    harness.changeConfiguration("codexCommand", "C:\\other\\codex.exe");
    harness.resolveExecutableResolution();
    await diagnosticsPromise;

    assert.equal(
      harness.contextKeys.get("codexNoteHelper.initialDiagnosticsPassed"),
      false
    );
    assert.equal(
      harness.diagnostics.some((line) => line.includes("PASS")),
      false
    );
    assert.ok(harness.diagnostics.some((line) => line.includes("FAIL")));
    assert.ok(
      harness.diagnostics.some((line) =>
        line.includes("code: EXECUTABLE_CHANGED")
      )
    );
  } finally {
    await harness.dispose();
  }
});

test("dismissed review notification stays pending and command recovery reuses the proposal", async () => {
  const harness = createWorkflowHarness({ reviewChoice: "dismiss" });
  try {
    const originalText = harness.document.getText();
    const fillPromise = harness.vscode.commands.executeCommand(
      "codexNoteHelper.fillWithCodex"
    );
    await harness.reviewStarted;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(harness.editCalls.length, 0);
    assert.equal(harness.document.getText(), originalText);
    assert.equal(harness.runProcessCalls.length, 1);
    assert.equal(harness.diffCalls.length, 1);
    assert.equal(harness.statusBarItems.length, 1);
    assert.equal(harness.statusBarItems[0].visible, true);
    assert.equal(
      harness.statusBarItems[0].command,
      "codexNoteHelper.reopenPendingReview"
    );
    assert.equal(harness.contextKeys.get("codexNoteHelper.reviewReady"), true);
    assert.equal(
      harness.contextKeys.get("codexNoteHelper.hasPendingReview"),
      true
    );
    assert.equal(
      harness.contextKeys.get("codexNoteHelper.activeEditorHasPendingReview"),
      true
    );
    assert.equal(
      harness.informationMessages.some(({ message }) =>
        message.includes("changes were discarded")
      ),
      false
    );

    const [originalUri, proposedUri] = harness.diffCalls[0];
    assert.notEqual(
      harness.contentProvider.provideTextDocumentContent(originalUri),
      ""
    );
    assert.notEqual(
      harness.contentProvider.provideTextDocumentContent(proposedUri),
      ""
    );

    await harness.vscode.commands.executeCommand(
      "codexNoteHelper.reopenPendingReview"
    );
    assert.equal(harness.diffCalls.length, 2);
    assert.equal(harness.diffCalls[1][0].toString(), originalUri.toString());
    assert.equal(harness.diffCalls[1][1].toString(), proposedUri.toString());
    assert.equal(harness.runProcessCalls.length, 1);

    await harness.vscode.commands.executeCommand(
      "codexNoteHelper.applyPendingReview"
    );
    await fillPromise;

    assert.equal(harness.editCalls.length, 1);
    assert.notEqual(harness.document.getText(), originalText);
    assert.equal(harness.runProcessCalls.length, 1);
    assert.equal(harness.statusBarItems[0].visible, false);
    assert.equal(
      harness.contextKeys.get("codexNoteHelper.hasPendingReview"),
      false
    );
    assert.equal(
      harness.contextKeys.get("codexNoteHelper.activeEditorHasPendingReview"),
      false
    );
    assert.equal(
      harness.contentProvider.provideTextDocumentContent(originalUri),
      ""
    );
    assert.equal(
      harness.contentProvider.provideTextDocumentContent(proposedUri),
      ""
    );
  } finally {
    await harness.dispose();
  }
});

test("a dismissed review can be explicitly discarded without another Codex run", async () => {
  const harness = createWorkflowHarness({ reviewChoice: "dismiss" });
  try {
    const originalText = harness.document.getText();
    const fillPromise = harness.vscode.commands.executeCommand(
      "codexNoteHelper.fillWithCodex"
    );
    await harness.reviewStarted;

    await harness.vscode.commands.executeCommand(
      "codexNoteHelper.discardPendingReview"
    );
    await fillPromise;

    assert.equal(harness.editCalls.length, 0);
    assert.equal(harness.document.getText(), originalText);
    assert.equal(harness.runProcessCalls.length, 1);
    assert.equal(harness.statusBarItems[0].visible, false);
    assert.ok(
      harness.informationMessages.some(({ message }) =>
        message.includes("changes were discarded")
      )
    );
  } finally {
    await harness.dispose();
  }
});

test("palette apply does not operate on a different active note without selection", async () => {
  const harness = createWorkflowHarness({ reviewChoice: "dismiss" });
  try {
    const originalText = harness.document.getText();
    const fillPromise = harness.vscode.commands.executeCommand(
      "codexNoteHelper.fillWithCodex"
    );
    await harness.reviewStarted;
    const proposedUri = harness.diffCalls[0][1];
    const unrelated = harness.addDocument(
      "# Other\n",
      path.join(path.parse(process.cwd()).root, "notes", "other.md"),
      "/notes/other.md"
    );
    harness.focusEditor(unrelated.editor);

    await harness.vscode.commands.executeCommand(
      "codexNoteHelper.applyPendingReview"
    );
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(harness.editCalls.length, 0);
    assert.equal(harness.document.getText(), originalText);
    assert.equal(harness.statusBarItems[0].visible, true);
    const reviewPicker = harness.quickPickCalls.at(-1);
    assert.equal(reviewPicker.items.length, 1);
    assert.equal(reviewPicker.items[0].label, "example.md");

    harness.focusEditor({ document: { uri: proposedUri } });
    assert.equal(
      harness.contextKeys.get("codexNoteHelper.activeEditorHasPendingReview"),
      true
    );
    await harness.vscode.commands.executeCommand(
      "codexNoteHelper.applyPendingReview"
    );
    await fillPromise;

    assert.equal(harness.editCalls.length, 1);
    assert.equal(harness.editCalls[0].document, harness.document);
    assert.notEqual(harness.document.getText(), originalText);
    assert.equal(unrelated.document.getText(), "# Other\n");
  } finally {
    await harness.dispose();
  }
});

test("multiple pending reviews stay bound to their own diff resources", async () => {
  const harness = createWorkflowHarness({ reviewChoice: "dismiss" });
  try {
    const firstOriginal = harness.document.getText();
    const firstPromise = harness.vscode.commands.executeCommand(
      "codexNoteHelper.fillWithCodex"
    );
    await harness.waitForReviewCount(1);

    const second = harness.addDocument();
    const secondOriginal = second.document.getText();
    harness.focusEditor(second.editor);
    const secondPromise = harness.vscode.commands.executeCommand(
      "codexNoteHelper.fillWithCodex"
    );
    await harness.waitForReviewCount(2);

    assert.equal(harness.diffCalls.length, 2);
    assert.equal(harness.runProcessCalls.length, 2);
    assert.match(harness.statusBarItems[0].text, /Review 2 Codex updates/u);
    const firstProposedUri = harness.diffCalls[0][1];
    const secondProposedUri = harness.diffCalls[1][1];

    await harness.vscode.commands.executeCommand(
      "codexNoteHelper.applyPendingReview",
      firstProposedUri
    );
    await firstPromise;

    assert.notEqual(harness.document.getText(), firstOriginal);
    assert.equal(second.document.getText(), secondOriginal);
    assert.equal(harness.editCalls.length, 1);
    assert.equal(harness.editCalls[0].document, harness.document);
    assert.equal(harness.statusBarItems[0].visible, true);

    await harness.vscode.commands.executeCommand(
      "codexNoteHelper.discardPendingReview",
      secondProposedUri
    );
    await secondPromise;

    assert.equal(second.document.getText(), secondOriginal);
    assert.equal(harness.editCalls.length, 1);
    assert.equal(harness.statusBarItems[0].visible, false);
  } finally {
    await harness.dispose();
  }
});

test("changing or closing a note invalidates and cleans a pending review", async (t) => {
  for (const transition of ["change", "close"]) {
    await t.test(transition, async () => {
      const harness = createWorkflowHarness({ reviewChoice: "dismiss" });
      try {
        const originalText = harness.document.getText();
        const fillPromise = harness.vscode.commands.executeCommand(
          "codexNoteHelper.fillWithCodex"
        );
        await harness.reviewStarted;
        const [originalUri, proposedUri] = harness.diffCalls[0];

        if (transition === "change") {
          harness.changeDocument();
        } else {
          harness.closeDocument();
        }
        await fillPromise;
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(harness.editCalls.length, 0);
        if (transition === "close") {
          assert.equal(harness.document.getText(), originalText);
        }
        assert.equal(harness.statusBarItems[0].visible, false);
        assert.equal(
          harness.contentProvider.provideTextDocumentContent(originalUri),
          ""
        );
        assert.equal(
          harness.contentProvider.provideTextDocumentContent(proposedUri),
          ""
        );
        assert.ok(
          harness.errorMessages.some(({ message }) =>
            message.includes("note changed during generation")
          )
        );
      } finally {
        await harness.dispose();
      }
    });
  }
});

test("deactivation cancels and cleans a dismissed pending review", async () => {
  const harness = createWorkflowHarness({ reviewChoice: "dismiss" });
  const fillPromise = harness.vscode.commands.executeCommand(
    "codexNoteHelper.fillWithCodex"
  );
  await harness.reviewStarted;
  const [originalUri, proposedUri] = harness.diffCalls[0];

  await settleWithin(harness.dispose());
  await settleWithin(fillPromise);

  assert.equal(harness.editCalls.length, 0);
  assert.equal(harness.statusBarItems[0].visible, false);
  assert.equal(harness.contentProvider.provideTextDocumentContent(originalUri), "");
  assert.equal(harness.contentProvider.provideTextDocumentContent(proposedUri), "");
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
    const [originalUri, proposedUri] = harness.diffCalls[0];
    assert.equal(harness.editCalls.length, 0);
    assert.equal(harness.document.getText(), originalText);
    assert.equal(harness.statusBarItems[0].visible, false);
    assert.equal(harness.contentProvider.provideTextDocumentContent(originalUri), "");
    assert.equal(harness.contentProvider.provideTextDocumentContent(proposedUri), "");
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

test("discard is explicit and transient apply failures keep the review recoverable", async (t) => {
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
    await withHarness({ editorEditResults: [false, true] }, async (harness) => {
      const originalText = harness.document.getText();
      const fillPromise = harness.vscode.commands.executeCommand(
        "codexNoteHelper.fillWithCodex"
      );
      await harness.reviewStarted;
      await waitForCondition(() =>
        harness.errorMessages.some(({ message }) =>
          message.includes("remains pending for review")
        )
      );

      const [originalUri, proposedUri] = harness.diffCalls[0];
      assert.equal(harness.editCalls.length, 1);
      assert.equal(harness.document.getText(), originalText);
      assert.equal(harness.statusBarItems[0].visible, true);
      assert.notEqual(
        harness.contentProvider.provideTextDocumentContent(originalUri),
        ""
      );
      assert.notEqual(
        harness.contentProvider.provideTextDocumentContent(proposedUri),
        ""
      );

      await harness.vscode.commands.executeCommand(
        "codexNoteHelper.applyPendingReview",
        proposedUri
      );
      await fillPromise;

      assert.equal(harness.editCalls.length, 2);
      assert.notEqual(harness.document.getText(), originalText);
      assert.equal(harness.runProcessCalls.length, 1);
      assert.equal(harness.statusBarItems[0].visible, false);
      assert.equal(
        harness.contentProvider.provideTextDocumentContent(originalUri),
        ""
      );
    });
  });

  await t.test("showTextDocument rejects once", async () => {
    await withHarness({ showTextDocumentFailures: 1 }, async (harness) => {
      const originalText = harness.document.getText();
      const fillPromise = harness.vscode.commands.executeCommand(
        "codexNoteHelper.fillWithCodex"
      );
      await harness.reviewStarted;
      await waitForCondition(() =>
        harness.errorMessages.some(({ message }) =>
          message.includes("remains pending for review")
        )
      );

      const proposedUri = harness.diffCalls[0][1];
      assert.equal(harness.editCalls.length, 0);
      assert.equal(harness.document.getText(), originalText);
      assert.equal(harness.statusBarItems[0].visible, true);

      await harness.vscode.commands.executeCommand(
        "codexNoteHelper.applyPendingReview",
        proposedUri
      );
      await fillPromise;

      assert.equal(harness.editCalls.length, 1);
      assert.notEqual(harness.document.getText(), originalText);
      assert.equal(harness.runProcessCalls.length, 1);
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
