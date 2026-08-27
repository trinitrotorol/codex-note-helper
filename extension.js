"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const vscode = require("vscode");
const { probeCodexCli } = require("./lib/cliProbe");
const { isDocumentSnapshotCurrent } = require("./lib/documentSafety");
const { resolveCodexExecutable } = require("./lib/executableResolver");
const { buildOutputSchema, parseGeneratedUpdates } = require("./lib/generation");
const {
  appendFailureLog,
  deleteFailureLog,
  getFailureLogInfo
} = require("./lib/logStore");
const {
  applyGeneratedSectionUpdates,
  buildCodexExecPrompt,
  findTargetHeadingSections
} = require("./lib/noteParser");
const {
  assertCodexEventPolicy,
  createProgressEventFilter
} = require("./lib/codexProgress");
const {
  buildCodexArgs,
  formatFailureLog,
  formatSafeFailureReason
} = require("./lib/codexRuntime");
const { runProcess } = require("./lib/processRunner");
const {
  isSupportedDocumentScheme,
  normalizeCodexCommand,
  shouldConfirmRun,
  validateOptions
} = require("./lib/settings");

const PREVIEW_SCHEME = "codex-note-helper-preview";
const CONSENT_VERSION = 1;
const CONSENT_KEY = "privacyConsentVersion";
const EXECUTABLE_CONSENT_KEY = "approvedExecutableFingerprints";
const MAX_EXECUTABLE_CONSENTS = 10;
const MAX_CONCURRENT_RUNS = 3;

let extensionContext;
let diagnosticsChannel;
let previewProvider;
let reviewStatusBarItem;
const activeRuns = new Map();
let activeDiagnostics;
let activeCliSourceSelection;
const cliProbeCache = new Map();

function t(message, ...args) {
  if (vscode.l10n && typeof vscode.l10n.t === "function") {
    return vscode.l10n.t(message, ...args);
  }
  return args.reduce(
    (result, value, index) => result.replace(`{${index}}`, String(value)),
    message
  );
}

function modeLabel(mode) {
  return {
    research: t("Research"),
    general: t("General"),
    jobHunting: t("Job hunting")
  }[mode] || String(mode);
}

function fillPolicyLabel(policy) {
  return {
    emptyOnly: t("Empty sections only"),
    emptyOrBulletsOnly: t("Empty or list-only sections"),
    appendAlways: t("Every matching section")
  }[policy] || String(policy);
}

function yesNoLabel(value) {
  return value ? t("Yes") : t("No");
}

function executableSourceLabel(source) {
  return {
    path: t("PATH"),
    absolute: t("Absolute path"),
    bundled: t("Bundled OpenAI extension")
  }[source] || t("Resolved executable");
}

function safeDocumentLabel(value) {
  const label = String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return label ? label.slice(0, 160) : t("Current note");
}

function makeError(message, code, phase) {
  const error = new Error(message);
  error.code = code;
  error.phase = phase;
  return error;
}

function makeRecoverableApplyError(message) {
  const error = makeError(message, "APPLY_REJECTED", "apply");
  error.reviewRecoverable = true;
  return error;
}

function markPhase(error, phase) {
  if (error && typeof error === "object" && !error.phase) {
    error.phase = phase;
  }
  return error;
}

function throwIfAborted(signal) {
  if (signal && signal.aborted) {
    if (
      signal.reason &&
      typeof signal.reason === "object" &&
      (signal.reason.code === "ETIMEDOUT" ||
        signal.reason.code === "DOCUMENT_CHANGED")
    ) {
      throw signal.reason;
    }
    const error = makeError("The run was cancelled.", "ABORT_ERR", "cancel");
    error.cancelled = true;
    throw error;
  }
}

async function raceWithAbort(promise, signal) {
  const observed = Promise.resolve(promise);
  // Keep a rejection handler attached even when the signal is already aborted or
  // wins the race. Some filesystem operations cannot actually be cancelled and
  // may reject after their caller has moved on.
  observed.catch(() => {});
  if (!signal) {
    return observed;
  }
  throwIfAborted(signal);
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
      resolve(undefined);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([observed, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function createOperationDeadline(timeoutMs, parentSignal) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("timeoutMs must be a positive integer.");
  }

  const controller = new AbortController();
  let remainingMs = timeoutMs;
  let startedAt;
  let timer;
  let disposed = false;

  const cancelFromParent = () => {
    if (!controller.signal.aborted) {
      if (
        parentSignal &&
        parentSignal.reason &&
        parentSignal.reason.code === "DOCUMENT_CHANGED"
      ) {
        controller.abort(parentSignal.reason);
        return;
      }
      const error = makeError("The run was cancelled.", "ABORT_ERR", "cancel");
      error.cancelled = true;
      controller.abort(error);
    }
  };
  if (parentSignal) {
    parentSignal.addEventListener("abort", cancelFromParent, { once: true });
    if (parentSignal.aborted) {
      cancelFromParent();
    }
  }

  const pause = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (startedAt !== undefined) {
      remainingMs = Math.max(0, remainingMs - (performance.now() - startedAt));
      startedAt = undefined;
    }
  };

  const start = () => {
    throwIfAborted(controller.signal);
    if (remainingMs <= 0) {
      const error = makeError("The run timed out.", "ETIMEDOUT", "generation");
      controller.abort(error);
      throw error;
    }
    startedAt = performance.now();
    timer = setTimeout(() => {
      timer = undefined;
      startedAt = undefined;
      remainingMs = 0;
      if (!controller.signal.aborted) {
        controller.abort(
          makeError("The run timed out.", "ETIMEDOUT", "generation")
        );
      }
    }, Math.max(1, Math.ceil(remainingMs)));
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  };

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      pause();
      if (parentSignal) {
        parentSignal.removeEventListener("abort", cancelFromParent);
      }
    },
    remainingTimeoutMs() {
      throwIfAborted(controller.signal);
      const elapsed = startedAt === undefined ? 0 : performance.now() - startedAt;
      return Math.max(1, Math.ceil(remainingMs - elapsed));
    },
    async run(operation) {
      if (disposed) {
        throw new Error("The operation deadline has been disposed.");
      }
      if (typeof operation !== "function") {
        throw new TypeError("operation must be a function.");
      }
      throwIfAborted(parentSignal);
      start();
      const task = Promise.resolve().then(() => {
        throwIfAborted(controller.signal);
        return operation(controller.signal);
      });
      try {
        return await raceWithAbort(task, controller.signal);
      } finally {
        pause();
      }
    }
  };
}

function assertDocumentSnapshot(document, originalVersion, originalText) {
  if (
    !isDocumentSnapshotCurrent(
      document,
      vscode.workspace.textDocuments,
      originalVersion,
      originalText
    )
  ) {
    throw makeError(
      "The note changed, closed, or reopened while Codex was running.",
      "DOCUMENT_CHANGED",
      "apply"
    );
  }
}

class PreviewContentProvider {
  constructor(limit = 12) {
    this.limit = limit;
    this.entries = new Map();
    this.order = [];
  }

  provideTextDocumentContent(uri) {
    return this.entries.get(uri.toString()) || "";
  }

  add(label, text) {
    const uri = vscode.Uri.from({
      scheme: PREVIEW_SCHEME,
      path: `/${crypto.randomUUID()}-${label}.md`
    });
    const key = uri.toString();
    this.entries.set(key, text);
    this.order.push(key);
    while (this.order.length > this.limit) {
      this.entries.delete(this.order.shift());
    }
    return uri;
  }

  remove(uri) {
    const key = uri.toString();
    this.entries.delete(key);
    const index = this.order.indexOf(key);
    if (index !== -1) {
      this.order.splice(index, 1);
    }
  }

  dispose() {
    this.entries.clear();
    this.order.length = 0;
  }
}

function reportReviewUiFailure(message) {
  if (diagnosticsChannel) {
    diagnosticsChannel.appendLine(message);
  }
}

function setContextSafely(name, value) {
  try {
    Promise.resolve(
      vscode.commands.executeCommand("setContext", name, value)
    ).catch(() => {
      reportReviewUiFailure(t("The pending review UI could not be updated."));
    });
  } catch (_error) {
    reportReviewUiFailure(t("The pending review UI could not be updated."));
  }
}

function getPendingReviewStates() {
  return [...activeRuns.values()].filter(
    (state) => state.review && state.review.settled !== true
  );
}

function reviewMatchesResource(state, resource) {
  if (!state || !state.review || !resource) {
    return false;
  }
  const key = resource.toString();
  const { review } = state;
  return (
    review.document.uri.toString() === key ||
    review.preview.originalUri.toString() === key ||
    review.preview.proposedUri.toString() === key
  );
}

function updatePendingReviewUi() {
  const reviews = getPendingReviewStates();
  const activeResource =
    vscode.window.activeTextEditor && vscode.window.activeTextEditor.document
      ? vscode.window.activeTextEditor.document.uri
      : undefined;
  setContextSafely("codexNoteHelper.hasPendingReview", reviews.length > 0);
  setContextSafely(
    "codexNoteHelper.activeEditorHasPendingReview",
    reviews.some((state) => reviewMatchesResource(state, activeResource))
  );

  if (!reviewStatusBarItem) {
    return;
  }
  if (reviews.length === 0) {
    reviewStatusBarItem.hide();
    return;
  }
  reviewStatusBarItem.text =
    reviews.length === 1
      ? t("$(diff) Review Codex update")
      : t("$(diff) Review {0} Codex updates", reviews.length);
  reviewStatusBarItem.tooltip = t(
    "A generated update is waiting for an explicit Apply or Discard decision."
  );
  reviewStatusBarItem.show();
}

function getConfiguration(document) {
  const resource = document && document.uri;
  const config = vscode.workspace.getConfiguration("codexNoteHelper", resource);
  return validateOptions({
    mode: config.get("mode", "research"),
    fillPolicy: config.get("fillPolicy", "emptyOnly"),
    researchField: config.get("researchField", ""),
    outputLanguage: config.get("outputLanguage", "English"),
    noteStyle: config.get("noteStyle", ""),
    headingLevel: config.get("headingLevel", 1),
    codexCommand: config.get("codexCommand", "codex"),
    allowBundledCodexFromOpenAIExtension: config.get(
      "allowBundledCodexFromOpenAIExtension",
      false
    ),
    enableWebSearch: config.get("enableWebSearch", false),
    showCodexProgress: config.get("showCodexProgress", true),
    timeoutSeconds: config.get("timeoutSeconds", 300),
    maxTargetHeadings: config.get("maxTargetHeadings", 25),
    maxInputCharacters: config.get("maxInputCharacters", 500000),
    maxOutputBytes: config.get("maxOutputBytes", 1048576),
    confirmBeforeRun: config.get("confirmBeforeRun", "appendAlways"),
    applySaveBehavior: config.get("applySaveBehavior", "leaveUnsaved"),
    ignoreCodexUserConfiguration: config.get(
      "ignoreCodexUserConfiguration",
      true
    )
  });
}

function getApplySaveBehavior(document) {
  try {
    const value = vscode.workspace
      .getConfiguration("codexNoteHelper", document && document.uri)
      .get("applySaveBehavior", "leaveUnsaved");
    return value === "saveIfCleanBeforeApply"
      ? "saveIfCleanBeforeApply"
      : "leaveUnsaved";
  } catch (_error) {
    return "leaveUnsaved";
  }
}

function readCliConfiguration(document) {
  const config = vscode.workspace.getConfiguration(
    "codexNoteHelper",
    document && document.uri
  );
  const inspectedCommand =
    typeof config.inspect === "function"
      ? config.inspect("codexCommand")
      : undefined;
  const codexCommandExplicitlyConfigured = Boolean(
    inspectedCommand &&
      [
        "globalValue",
        "workspaceValue",
        "workspaceFolderValue",
        "globalLanguageValue",
        "workspaceLanguageValue",
        "workspaceFolderLanguageValue"
      ].some((key) => inspectedCommand[key] !== undefined)
  );
  return {
    codexCommand: normalizeCodexCommand(config.get("codexCommand", "codex")),
    codexCommandExplicitlyConfigured,
    allowBundledCodexFromOpenAIExtension:
      config.get("allowBundledCodexFromOpenAIExtension", false) === true,
    ignoreCodexUserConfiguration:
      config.get("ignoreCodexUserConfiguration", true) !== false
  };
}

function sameCliConfiguration(left, right) {
  return Boolean(
    left &&
      right &&
      left.codexCommand === right.codexCommand &&
      left.allowBundledCodexFromOpenAIExtension ===
        right.allowBundledCodexFromOpenAIExtension &&
      left.ignoreCodexUserConfiguration === right.ignoreCodexUserConfiguration
  );
}

function updateCliSourceConfiguredContext(document) {
  let configured = false;
  try {
    const cliConfiguration = readCliConfiguration(document);
    configured =
      cliConfiguration.codexCommand !== "codex" ||
      cliConfiguration.codexCommandExplicitlyConfigured ||
      cliConfiguration.allowBundledCodexFromOpenAIExtension;
  } catch (_error) {
    configured = false;
  }
  setContextSafely("codexNoteHelper.cliSourceConfigured", configured);
  return configured;
}

function getConfigurationTarget(resource) {
  if (resource && vscode.workspace.getWorkspaceFolder(resource)) {
    return vscode.ConfigurationTarget.WorkspaceFolder;
  }
  return vscode.ConfigurationTarget.Global;
}

async function updateUserSetting(name, value, resource) {
  const config = vscode.workspace.getConfiguration("codexNoteHelper", resource);
  await config.update(name, value, getConfigurationTarget(resource));
}

function getActiveMarkdownEditor() {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showWarningMessage(t("No active editor."));
    return undefined;
  }
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage(
      t("Trust this workspace before running Codex Note Helper.")
    );
    return undefined;
  }

  const { document } = editor;
  if (!isSupportedDocumentScheme(document.uri.scheme)) {
    vscode.window.showWarningMessage(
      t("Open a local or remote file-backed Markdown note first.")
    );
    return undefined;
  }
  const isMarkdown =
    document.languageId === "markdown" ||
    document.uri.path.toLowerCase().endsWith(".md");
  if (!isMarkdown) {
    vscode.window.showWarningMessage(t("Open a Markdown note first."));
    return undefined;
  }
  return editor;
}

function getStorageDirectory() {
  if (!extensionContext || !extensionContext.globalStorageUri) {
    throw makeError(
      "Extension storage is not available.",
      "STORAGE_UNAVAILABLE",
      "storage"
    );
  }
  const storageDir = extensionContext.globalStorageUri.fsPath;
  if (!path.isAbsolute(storageDir)) {
    throw makeError(
      "Extension storage is not a filesystem path.",
      "STORAGE_UNAVAILABLE",
      "storage"
    );
  }
  return storageDir;
}

async function getRuntimeDirectory() {
  const runtimeDir = path.join(getStorageDirectory(), "runtime");
  await fs.promises.mkdir(runtimeDir, { recursive: true });
  return runtimeDir;
}

function bundledDirectoryName() {
  const platform = {
    win32: "windows",
    darwin: "darwin",
    linux: "linux"
  }[process.platform];
  const architecture = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  return platform && architecture ? `${platform}-${architecture}` : undefined;
}

function getBundledCodexCandidate() {
  const openAiExtension = vscode.extensions.getExtension("openai.chatgpt");
  const directoryName = bundledDirectoryName();
  if (!openAiExtension || !directoryName) {
    return undefined;
  }
  const executableName = process.platform === "win32" ? "codex.exe" : "codex";
  return path.join(
    openAiExtension.extensionPath,
    "bin",
    directoryName,
    executableName
  );
}

function hasBundledCodexCandidate() {
  const candidate = getBundledCodexCandidate();
  if (!candidate) {
    return false;
  }
  try {
    const stat = fs.lstatSync(candidate);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch (_error) {
    return false;
  }
}

function isMissingExecutableError(error) {
  return Boolean(
    error &&
      (error.code === "ENOENT" ||
        error.code === "EXECUTABLE_NOT_FOUND" ||
        error.code === "NODE_EXECUTABLE_NOT_FOUND")
  );
}

function canOfferBundledCliSetting(error, document) {
  if (!isMissingExecutableError(error) || !hasBundledCodexCandidate()) {
    return false;
  }
  try {
    const config = vscode.workspace.getConfiguration(
      "codexNoteHelper",
      document && document.uri
    );
    return (
      config.get("codexCommand", "codex") === "codex" &&
      config.get("allowBundledCodexFromOpenAIExtension", false) !== true
    );
  } catch (_error) {
    return false;
  }
}

async function openBundledCliSetting() {
  await vscode.commands.executeCommand(
    "workbench.action.openSettings",
    "codexNoteHelper.allowBundledCodexFromOpenAIExtension"
  );
}

async function performCliSourceSelection() {
  const choices = [
    {
      label: t("codex on PATH (Recommended)"),
      description: t("Use the standard Codex CLI command"),
      value: "path"
    }
  ];
  if (hasBundledCodexCandidate()) {
    choices.push({
      label: t("Official OpenAI extension bundle"),
      description: t("Use only after explicit opt-in"),
      value: "bundled"
    });
  }
  choices.push({
    label: t("Absolute path in Settings"),
    description: t("Configure another trusted Codex executable"),
    value: "settings"
  });

  const picked = await vscode.window.showQuickPick(choices, {
    placeHolder: t("Choose the Codex CLI source for this extension host")
  });
  if (!picked) {
    return;
  }
  if (picked.value === "settings") {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "codexNoteHelper.codexCommand"
    );
    return;
  }

  const config = vscode.workspace.getConfiguration("codexNoteHelper");
  if (picked.value === "bundled") {
    const allowLabel = t("Use bundled CLI");
    const choice = await vscode.window.showWarningMessage(
      t(
        "Allow fallback to the Codex CLI bundled with the official OpenAI extension when codex is absent from PATH? The executable will still require fingerprint approval and a compatibility check."
      ),
      { modal: true },
      allowLabel
    );
    if (choice !== allowLabel) {
      return;
    }
    await config.update(
      "codexCommand",
      "codex",
      vscode.ConfigurationTarget.Global
    );
    await config.update(
      "allowBundledCodexFromOpenAIExtension",
      true,
      vscode.ConfigurationTarget.Global
    );
    const selected = readCliConfiguration();
    if (
      selected.codexCommand !== "codex" ||
      selected.allowBundledCodexFromOpenAIExtension !== true
    ) {
      setContextSafely("codexNoteHelper.cliSourceConfigured", false);
      vscode.window.showErrorMessage(
        t("A Codex Note Helper setting is invalid. Review the extension settings.")
      );
      return;
    }
    setContextSafely("codexNoteHelper.cliSourceConfigured", true);
    vscode.window.showInformationMessage(
      t("The official OpenAI extension bundle is selected. Run diagnostics next.")
    );
    return;
  }

  await config.update(
    "allowBundledCodexFromOpenAIExtension",
    false,
    vscode.ConfigurationTarget.Global
  );
  await config.update(
    "codexCommand",
    "codex",
    vscode.ConfigurationTarget.Global
  );
  const selected = readCliConfiguration();
  if (
    selected.codexCommand !== "codex" ||
    selected.allowBundledCodexFromOpenAIExtension !== false
  ) {
    setContextSafely("codexNoteHelper.cliSourceConfigured", false);
    vscode.window.showErrorMessage(
      t("A Codex Note Helper setting is invalid. Review the extension settings.")
    );
    return;
  }
  setContextSafely("codexNoteHelper.cliSourceConfigured", true);
  vscode.window.showInformationMessage(
    t("The Codex CLI on PATH is selected. Run diagnostics next.")
  );
}

function chooseCliSourceCommand() {
  if (activeCliSourceSelection) {
    return activeCliSourceSelection;
  }
  const selection = performCliSourceSelection();
  activeCliSourceSelection = selection.finally(() => {
    if (activeCliSourceSelection === trackedSelection) {
      activeCliSourceSelection = undefined;
    }
  });
  const trackedSelection = activeCliSourceSelection;
  return trackedSelection;
}

function getWorkspaceExecutableRoots() {
  return (vscode.workspace.workspaceFolders || [])
    .map((folder) => folder && folder.uri && folder.uri.fsPath)
    .filter((value) => typeof value === "string" && path.isAbsolute(value));
}

function sameHostPath(left, right) {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function getDocumentExecutableProtection(document) {
  const uri = document && document.uri;
  if (
    uri &&
    (uri.scheme === "file" || uri.scheme === "vscode-remote") &&
    typeof uri.fsPath === "string" &&
    path.isAbsolute(uri.fsPath)
  ) {
    const directory = path.dirname(path.normalize(uri.fsPath));
    const root = path.parse(directory).root;
    const home = os.homedir();
    return {
      protectedDirectories: [directory],
      recursiveRoots:
        sameHostPath(directory, root) ||
        (path.isAbsolute(home) && sameHostPath(directory, home))
          ? []
          : [directory]
    };
  }
  return { protectedDirectories: [], recursiveRoots: [] };
}

async function resolveCodexCommand(options, runtimeDir, signal, document) {
  const bundledExecutable = options.allowBundledCodexFromOpenAIExtension
    ? getBundledCodexCandidate()
    : undefined;
  try {
    const documentProtection = getDocumentExecutableProtection(document);
    return await raceWithAbort(
      resolveCodexExecutable({
        command: options.codexCommand,
        cwd: runtimeDir,
        workspaceRoots: [
          ...getWorkspaceExecutableRoots(),
          ...documentProtection.recursiveRoots
        ],
        protectedDirectories: documentProtection.protectedDirectories,
        allowBundledFallback: Boolean(bundledExecutable),
        bundledExecutable,
        signal
      }),
      signal
    );
  } catch (error) {
    throw markPhase(error, "preflight");
  }
}

function assertExecutableIdentity(expected, current) {
  const expectedKey = expected && expected.identity && expected.identity.key;
  const currentKey = current && current.identity && current.identity.key;
  if (
    typeof expectedKey !== "string" ||
    typeof currentKey !== "string" ||
    expectedKey !== currentKey
  ) {
    throw makeError(
      "The approved Codex executable changed before it could be run.",
      "EXECUTABLE_CHANGED",
      "preflight"
    );
  }
}

async function ensureExecutableConsent(executable, signal) {
  const stored = extensionContext.globalState.get(EXECUTABLE_CONSENT_KEY, []);
  const approved = Array.isArray(stored)
    ? stored.filter((value) => /^[a-f0-9]{64}$/u.test(value))
    : [];
  if (approved.includes(executable.identity.key)) {
    return true;
  }

  const allowLabel = t("Allow executable");
  const choice = await raceWithAbort(
    vscode.window.showWarningMessage(
      t(
        "Allow Codex Note Helper to run this executable?\n\n{0}\n\nIt receives the selected note sections and may receive Codex credentials from the environment. You will be asked again if the executable changes.",
        executable.entryPath
      ),
      { modal: true },
      allowLabel
    ),
    signal
  );
  if (choice !== allowLabel) {
    return false;
  }
  const updated = [executable.identity.key, ...approved]
    .filter((value, index, values) => values.indexOf(value) === index)
    .slice(0, MAX_EXECUTABLE_CONSENTS);
  await extensionContext.globalState.update(EXECUTABLE_CONSENT_KEY, updated);
  return true;
}

async function ensureCompatibleCli(executable, runtimeDir, options, signal) {
  const cacheKey = `${executable.identity.key}\u0000${options.ignoreCodexUserConfiguration}`;
  if (cliProbeCache.has(cacheKey)) {
    return cliProbeCache.get(cacheKey);
  }
  const probe = await probeCodexCli({
    command: executable.command,
    prefixArgs: executable.argsPrefix,
    cwd: runtimeDir,
    runProcess,
    signal,
    ignoreUserConfiguration: options.ignoreCodexUserConfiguration
  });
  cliProbeCache.set(cacheKey, probe);
  return probe;
}

async function ensureFirstRunConsent(signal) {
  if (extensionContext.globalState.get(CONSENT_KEY, 0) >= CONSENT_VERSION) {
    return true;
  }
  const continueLabel = t("Continue");
  const privacyLabel = t("Privacy details");
  const choice = await raceWithAbort(
    vscode.window.showInformationMessage(
      t(
        "Codex Note Helper sends only target heading titles, their current section Markdown, and generation preferences to your configured Codex CLI. It never sends the note path or the whole workspace, and generated changes require review before they are applied."
      ),
      { modal: true },
      continueLabel,
      privacyLabel
    ),
    signal
  );
  if (choice === privacyLabel) {
    await vscode.commands.executeCommand(
      "vscode.open",
      vscode.Uri.joinPath(extensionContext.extensionUri, "SECURITY.md")
    );
    return false;
  }
  if (choice !== continueLabel) {
    return false;
  }
  await extensionContext.globalState.update(CONSENT_KEY, CONSENT_VERSION);
  return true;
}

async function confirmGeneration(targetCount, options, documentLabel, signal) {
  const needsConfirmation =
    shouldConfirmRun(options.confirmBeforeRun, options.fillPolicy) ||
    options.enableWebSearch ||
    !options.ignoreCodexUserConfiguration;
  if (!needsConfirmation) {
    return true;
  }
  const generateLabel = t("Generate preview");
  const isolationWarning = options.ignoreCodexUserConfiguration
    ? ""
    : t(" Codex user configuration is enabled, so configured integrations may run.");
  const researchWarning =
    options.mode === "research" && !options.enableWebSearch
      ? t(" Unverified references will be omitted because web search is disabled.")
      : "";
  const webSearchState = options.enableWebSearch ? t("On") : t("Blocked");
  const choice = await raceWithAbort(
    vscode.window.showInformationMessage(
      t(
        "Generate a preview for '{0}'? Targets: {1}. Mode: {2}. Policy: {3}. Web search: {4}.",
        documentLabel,
        targetCount,
        modeLabel(options.mode),
        fillPolicyLabel(options.fillPolicy),
        webSearchState
      ) + isolationWarning + researchWarning,
      { modal: true },
      generateLabel
    ),
    signal
  );
  return choice === generateLabel;
}

function progressMessage(category) {
  const messages = {
    thread: "Starting Codex",
    turn: "Analyzing target sections",
    reasoning: "Preparing note content",
    inspection: "Processing supplied context",
    tool: "Using an enabled external tool",
    "web-search": "Searching the web",
    planning: "Planning note updates",
    result: "Validating structured updates",
    complete: "Codex finished",
    error: "Codex reported an error",
    item: "Processing target sections",
    "file-change": "Ignoring an unexpected file operation"
  };
  return t(messages[category.key] || "Processing target sections");
}

function createProgressHandler(progress) {
  const filter = createProgressEventFilter();
  let lastReportAt = 0;
  return (event) => {
    const category = filter.accept(event);
    if (!category) {
      return;
    }
    const now = Date.now();
    if (!category.terminal && now - lastReportAt < 700) {
      return;
    }
    lastReportAt = now;
    progress.report({ message: progressMessage(category) });
  };
}

function createCodexEventHandler(progress, options) {
  const reportProgress = progress ? createProgressHandler(progress) : undefined;
  return (event) => {
    assertCodexEventPolicy(event, {
      enableWebSearch: Boolean(options.enableWebSearch)
    });
    if (reportProgress) {
      reportProgress(event);
    }
  };
}

async function runCodexGeneration(params) {
  const {
    executable,
    options,
    prompt,
    runtimeDir,
    signal,
    targetSections,
    progress,
    timeoutMs
  } = params;
  const maxMarkdownCharacters = Math.max(
    1024,
    Math.min(
      100000,
      Math.floor((options.maxOutputBytes * 0.7) / targetSections.length)
    )
  );
  const schema = buildOutputSchema(targetSections.length, maxMarkdownCharacters);
  const schemaPath = path.join(runtimeDir, `schema-${crypto.randomUUID()}.json`);
  await fs.promises.writeFile(schemaPath, JSON.stringify(schema), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600
  });
  try {
    const args = [
      ...executable.argsPrefix,
      ...buildCodexArgs(runtimeDir, {
        ...options,
        outputSchemaPath: schemaPath
      })
    ];
    const result = await runProcess({
      command: executable.command,
      args,
      cwd: runtimeDir,
      input: prompt,
      signal,
      timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      maxLineBytes: options.maxOutputBytes,
      onEvent: createCodexEventHandler(progress, options)
    });
    return parseGeneratedUpdates(result.stdout, targetSections, {
      maxMarkdownCharacters,
      enableWebSearch: options.enableWebSearch
    });
  } finally {
    try {
      await fs.promises.unlink(schemaPath);
    } catch (error) {
      if (!error || error.code !== "ENOENT") {
        if (diagnosticsChannel) {
          diagnosticsChannel.appendLine(t("Temporary schema cleanup failed."));
        }
      }
    }
  }
}

async function executeWithProgress(title, options, controller, operation) {
  if (!options.showCodexProgress) {
    return operation(undefined);
  }
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: true
    },
    async (progress, token) => {
      const cancellation = token.onCancellationRequested(() => controller.abort());
      try {
        progress.report({ message: t("Checking Codex CLI compatibility") });
        return await operation(progress);
      } finally {
        cancellation.dispose();
      }
    }
  );
}

async function showGeneratedDiff(preview, documentLabel) {
  await vscode.commands.executeCommand(
    "vscode.diff",
    preview.originalUri,
    preview.proposedUri,
    t("Codex Note Helper: Review generated changes for {0}", documentLabel),
    { preview: true, viewColumn: vscode.ViewColumn.Beside }
  );
}

function sameUri(left, right) {
  return Boolean(
    left &&
      right &&
      typeof left.toString === "function" &&
      typeof right.toString === "function" &&
      left.toString() === right.toString()
  );
}

async function closeGeneratedDiff(preview) {
  const tabGroups = vscode.window.tabGroups;
  if (
    !preview ||
    !tabGroups ||
    !Array.isArray(tabGroups.all) ||
    typeof tabGroups.close !== "function"
  ) {
    return;
  }
  const tabs = tabGroups.all.flatMap((group) =>
    Array.isArray(group && group.tabs) ? group.tabs : []
  );
  const ownedTabs = tabs.filter((tab) => {
    const input = tab && tab.input;
    if (!input || !sameUri(input.original, preview.originalUri)) {
      return false;
    }
    return sameUri(input.modified, preview.proposedUri);
  });
  if (ownedTabs.length === 0) {
    return;
  }
  try {
    const closed = await tabGroups.close(ownedTabs, true);
    if (closed === false) {
      reportReviewUiFailure(t("The generated diff tab could not be closed."));
    }
  } catch (_error) {
    reportReviewUiFailure(t("The generated diff tab could not be closed."));
  }
}

async function openGeneratedDiff(originalText, proposedText, documentLabel) {
  const preview = {
    originalUri: previewProvider.add("before", originalText),
    proposedUri: previewProvider.add("after", proposedText)
  };
  try {
    await showGeneratedDiff(preview, documentLabel);
    return preview;
  } catch (error) {
    previewProvider.remove(preview.originalUri);
    previewProvider.remove(preview.proposedUri);
    throw error;
  }
}

async function requestApply({
  application,
  document,
  documentLabel,
  onPhase,
  originalText,
  originalVersion,
  proposedText,
  signal,
  state,
  warnings
}) {
  let preview;
  try {
    preview = await openGeneratedDiff(originalText, proposedText, documentLabel);
  } catch (_error) {
    throw makeError(
      "The generated diff could not be opened.",
      "DIFF_UNAVAILABLE",
      "review"
    );
  }

  const review = {
    decision: undefined,
    document,
    originalText,
    originalVersion,
    preview,
    resolveDecision: undefined,
    settled: false,
    arm() {
      review.settled = false;
      review.decision = new Promise((resolve) => {
        review.resolveDecision = resolve;
      });
      updatePendingReviewUi();
    },
    settle(value) {
      if (review.settled || state.review !== review) {
        return false;
      }
      review.settled = true;
      review.resolveDecision(value);
      updatePendingReviewUi();
      return true;
    }
  };
  state.review = review;
  review.arm();
  setContextSafely("codexNoteHelper.reviewReady", true);

  const applyLabel = t("Apply changes");
  const discardLabel = t("Discard");
  const warningText = warnings.length
    ? `\n\n${t("Codex warnings:")}\n${warnings
        .map((warning) => `- ${warning}`)
        .join("\n")}`
    : "";
  const reportNotificationFailure = () => {
    reportReviewUiFailure(
      t(
        "The review notification could not be shown. Use the pending review commands."
      )
    );
  };
  try {
    try {
      Promise.resolve(
        vscode.window.showInformationMessage(
          t("Review the generated update for '{0}' before applying it.", documentLabel) +
            warningText,
          applyLabel,
          discardLabel
        )
      )
        .then((choice) => {
          if (choice === applyLabel) {
            review.settle(true);
          } else if (choice === discardLabel) {
            review.settle(false);
          }
          // Closing or clearing the notification is not an explicit decision.
        })
        .catch(reportNotificationFailure);
    } catch (_error) {
      reportNotificationFailure();
    }
    while (true) {
      const shouldApply = await raceWithAbort(review.decision, signal);
      throwIfAborted(signal);
      if (!shouldApply) {
        return false;
      }
      onPhase("applying");
      try {
        return await applyProposedEdits(
          document,
          originalText,
          originalVersion,
          application,
          getApplySaveBehavior(document)
        );
      } catch (error) {
        if (!error || error.reviewRecoverable !== true) {
          throw error;
        }
        assertDocumentSnapshot(document, originalVersion, originalText);
        throwIfAborted(signal);
        onPhase("review");
        review.arm();
        try {
          Promise.resolve(
            vscode.window.showErrorMessage(
              t(
                "VS Code could not apply the generated update. It remains pending for review."
              )
            )
          ).catch(reportNotificationFailure);
        } catch (_notificationError) {
          reportNotificationFailure();
        }
      }
    }
  } finally {
    review.settled = true;
    if (state.review === review) {
      state.review = undefined;
    }
    updatePendingReviewUi();
    await closeGeneratedDiff(preview);
    previewProvider.remove(preview.originalUri);
    previewProvider.remove(preview.proposedUri);
  }
}

async function saveAppliedDocument(
  document,
  proposedText,
  wasDirtyBeforeApply,
  applySaveBehavior
) {
  if (!isOpenWorkspaceDocument(document)) {
    return "documentClosed";
  }
  if (applySaveBehavior !== "saveIfCleanBeforeApply") {
    return document.isDirty === false ? "alreadySaved" : "leftUnsaved";
  }
  if (wasDirtyBeforeApply) {
    return document.isDirty === false
      ? "alreadySaved"
      : "skippedPreviouslyDirty";
  }
  if (document.getText() !== proposedText) {
    return document.isDirty === false
      ? "savedWithChanges"
      : "changedAfterApply";
  }
  if (document.isDirty === false) {
    return "alreadySaved";
  }
  try {
    const saved = await document.save();
    if (!isOpenWorkspaceDocument(document)) {
      return "documentClosed";
    }
    if (saved !== true) {
      if (document.getText() !== proposedText) {
        return document.isDirty === false
          ? "savedWithChanges"
          : "changedAfterApply";
      }
      return document.isDirty === false ? "alreadySaved" : "saveFailed";
    }
  } catch (_error) {
    if (document.getText() !== proposedText) {
      return document.isDirty === false
        ? "savedWithChanges"
        : "changedAfterApply";
    }
    return document.isDirty === false ? "alreadySaved" : "saveFailed";
  }
  if (document.getText() !== proposedText) {
    return document.isDirty === false
      ? "savedWithChanges"
      : "changedAfterApply";
  }
  return document.isDirty === false ? "saved" : "saveFailed";
}

function isOpenWorkspaceDocument(document) {
  try {
    return (
      document &&
      document.isClosed !== true &&
      vscode.workspace.textDocuments.includes(document)
    );
  } catch (_error) {
    return false;
  }
}

async function applyProposedEdits(
  document,
  originalText,
  originalVersion,
  application,
  applySaveBehavior = "leaveUnsaved"
) {
  assertDocumentSnapshot(document, originalVersion, originalText);
  if (
    !application ||
    !Array.isArray(application.edits) ||
    application.edits.length === 0
  ) {
    throw makeError(
      "No validated section edits are available.",
      "APPLY_REJECTED",
      "apply"
    );
  }
  const reconstructed = [];
  let cursor = 0;
  for (const operation of application.edits) {
    if (
      !operation ||
      !Number.isInteger(operation.start) ||
      !Number.isInteger(operation.end) ||
      operation.start < cursor ||
      operation.end < operation.start ||
      operation.end > originalText.length ||
      typeof operation.replacement !== "string"
    ) {
      throw makeError(
        "Validated section edits are inconsistent.",
        "APPLY_REJECTED",
        "apply"
      );
    }
    reconstructed.push(
      originalText.slice(cursor, operation.start),
      operation.replacement
    );
    cursor = operation.end;
  }
  reconstructed.push(originalText.slice(cursor));
  if (reconstructed.join("") !== application.text) {
    throw makeError(
      "Validated section edits do not match the reviewed proposal.",
      "APPLY_REJECTED",
      "apply"
    );
  }
  assertDocumentSnapshot(document, originalVersion, originalText);
  const wasDirtyBeforeApply = document.isDirty === true;
  const workspaceEdit = new vscode.WorkspaceEdit();
  for (const operation of application.edits) {
    const range = new vscode.Range(
      document.positionAt(operation.start),
      document.positionAt(operation.end)
    );
    workspaceEdit.replace(document.uri, range, operation.replacement);
  }
  let applied;
  try {
    applied = await vscode.workspace.applyEdit(workspaceEdit);
  } catch (_error) {
    if (document.getText() !== originalText) {
      throw makeError(
        "The note changed while VS Code was applying the reviewed update.",
        "APPLY_STATE_UNCERTAIN",
        "apply"
      );
    }
    throw makeRecoverableApplyError(
      "VS Code rejected the generated edit."
    );
  }
  if (!applied) {
    if (document.getText() !== originalText) {
      throw makeError(
        "The note changed while VS Code was applying the reviewed update.",
        "APPLY_STATE_UNCERTAIN",
        "apply"
      );
    }
    throw makeRecoverableApplyError("VS Code rejected the generated edit.");
  }
  if (document.getText() !== application.text) {
    throw makeError(
      "The note no longer matches the reviewed update after Apply.",
      "APPLY_STATE_UNCERTAIN",
      "apply"
    );
  }
  const saveOutcome = await saveAppliedDocument(
    document,
    application.text,
    wasDirtyBeforeApply,
    applySaveBehavior
  );
  return { applied: true, saveOutcome };
}

function refreshApplySaveOutcome(document, proposedText, saveOutcome) {
  if (!isOpenWorkspaceDocument(document)) {
    return "documentClosed";
  }
  const matchesReviewedText = document.getText() === proposedText;
  const isClean = document.isDirty === false;
  if (!matchesReviewedText) {
    return isClean ? "savedWithChanges" : "changedAfterApply";
  }
  if (isClean) {
    return saveOutcome === "leftUnsaved" ||
      saveOutcome === "saveFailed" ||
      saveOutcome === "savedWithChanges" ||
      saveOutcome === "skippedPreviouslyDirty"
      ? "alreadySaved"
      : saveOutcome;
  }
  return saveOutcome === "alreadySaved" ||
    saveOutcome === "saved" ||
    saveOutcome === "savedWithChanges"
    ? "changedAfterApply"
    : saveOutcome;
}

async function runGenerationWorkflow(
  editor,
  controller,
  documentLabel,
  onTargetCount,
  onPhase,
  state
) {
  const { document } = editor;
  let options;
  try {
    options = getConfiguration(document);
  } catch (error) {
    throw markPhase(error, "configuration");
  }

  const originalText = document.getText();
  const originalVersion = document.version;
  if (originalText.length > options.maxInputCharacters) {
    throw makeError(
      "The note exceeds the configured input limit.",
      "INPUT_LIMIT",
      "validation"
    );
  }

  let targetSections;
  try {
    targetSections = findTargetHeadingSections(
      originalText,
      options.headingLevel,
      options.fillPolicy
    );
  } catch (error) {
    throw markPhase(error, "parse");
  }
  if (targetSections.length === 0) {
    vscode.window.showInformationMessage(
      t("No target headings match the current fill policy.")
    );
    return;
  }
  onTargetCount(targetSections.length);
  if (targetSections.length > options.maxTargetHeadings) {
    throw makeError(
      "The target heading count exceeds the configured limit.",
      "TARGET_LIMIT",
      "validation"
    );
  }
  if (!(await ensureFirstRunConsent(controller.signal))) {
    return;
  }
  if (
    !(await confirmGeneration(
      targetSections.length,
      options,
      documentLabel,
      controller.signal
    ))
  ) {
    return;
  }
  throwIfAborted(controller.signal);
  assertDocumentSnapshot(document, originalVersion, originalText);

  const prompt = buildCodexExecPrompt(targetSections, options);
  if (prompt.length > options.maxInputCharacters) {
    throw makeError(
      "The selected target data exceeds the configured input limit.",
      "INPUT_LIMIT",
      "validation"
    );
  }

  const deadline = createOperationDeadline(
    options.timeoutSeconds * 1000,
    controller.signal
  );
  let generated;
  try {
    const { runtimeDir, executable } = await deadline.run(async (signal) => {
      const resolvedRuntimeDir = await getRuntimeDirectory();
      throwIfAborted(signal);
      const resolvedExecutable = await resolveCodexCommand(
        options,
        resolvedRuntimeDir,
        signal,
        document
      );
      return {
        executable: resolvedExecutable,
        runtimeDir: resolvedRuntimeDir
      };
    });

    // Human decision time is intentionally excluded from the automated
    // resolve/probe/generation budget.
    if (!(await ensureExecutableConsent(executable, controller.signal))) {
      return;
    }
    throwIfAborted(controller.signal);
    assertDocumentSnapshot(document, originalVersion, originalText);
    onPhase("generating");
    generated = await deadline.run((signal) =>
      executeWithProgress(
        t(
          "Generating a preview for {0} section(s) with Codex",
          targetSections.length
        ),
        options,
        controller,
        async (progress) => {
          const probeExecutable = await resolveCodexCommand(
            options,
            runtimeDir,
            signal,
            document
          );
          assertExecutableIdentity(executable, probeExecutable);
          await ensureCompatibleCli(
            probeExecutable,
            runtimeDir,
            options,
            signal
          );
          throwIfAborted(signal);
          if (progress) {
            progress.report({ message: t("Generating structured note updates") });
          }
          const generationExecutable = await resolveCodexCommand(
            options,
            runtimeDir,
            signal,
            document
          );
          assertExecutableIdentity(executable, generationExecutable);
          return runCodexGeneration({
            executable: generationExecutable,
            options,
            prompt,
            runtimeDir,
            signal,
            targetSections,
            progress,
            timeoutMs: deadline.remainingTimeoutMs()
          });
        }
      )
    );
  } finally {
    deadline.dispose();
  }
  throwIfAborted(controller.signal);

  const application = applyGeneratedSectionUpdates(
    originalText,
    targetSections,
    generated.updates.map((update) => ({
      id: targetSections[update.targetIndex].id,
      content: update.markdown
    }))
  );
  if (application.text === originalText || application.updatedCount === 0) {
    vscode.window.showInformationMessage(
      t("Codex proposed no changes for '{0}'.", documentLabel)
    );
    return;
  }

  assertDocumentSnapshot(document, originalVersion, originalText);
  throwIfAborted(controller.signal);
  onPhase("review");
  const applyResult = await requestApply({
    application,
    document,
    documentLabel,
    onPhase,
    originalText,
    originalVersion,
    proposedText: application.text,
    signal: controller.signal,
    state,
    warnings: generated.warnings
  });
  throwIfAborted(controller.signal);
  if (!applyResult || applyResult.applied !== true) {
    vscode.window.showInformationMessage(t("Generated changes were discarded."));
    return;
  }

  const saveOutcome = refreshApplySaveOutcome(
    document,
    application.text,
    applyResult.saveOutcome
  );

  const appliedMessage =
    application.updatedCount === 1
      ? t("Applied 1 generated section to '{0}'.", documentLabel)
      : t(
          "Applied {0} generated sections to '{1}'.",
          application.updatedCount,
          documentLabel
        );
  const saveMessage = {
    alreadySaved: t("The note is saved."),
    changedAfterApply: t(
      "The note changed after Apply and has unsaved changes. Review it before closing."
    ),
    documentClosed: t(
      "The note was closed after Apply, so whether the reviewed changes were kept could not be verified. Reopen the note and verify its contents."
    ),
    leftUnsaved: t("Save the note when ready."),
    saveFailed: t("Saving failed; the applied changes remain unsaved."),
    saved: t("The note is saved."),
    savedWithChanges: t(
      "Save-time actions changed the note after review. Review the saved note again."
    ),
    skippedPreviouslyDirty: t(
      "The note remains unsaved because it already contained unsaved changes before Apply."
    )
  }[saveOutcome] || t("Save the note when ready.");
  const successMessage = `${appliedMessage} ${saveMessage}`;
  const warningOutcome =
    saveOutcome === "changedAfterApply" ||
    saveOutcome === "documentClosed" ||
    saveOutcome === "saveFailed" ||
    saveOutcome === "savedWithChanges" ||
    saveOutcome === "skippedPreviouslyDirty";
  const reportConfirmationFailure = () => {
    if (diagnosticsChannel) {
      diagnosticsChannel.appendLine(
        t("The update was applied, but its confirmation could not be shown.")
      );
    }
  };
  try {
    const confirmation = warningOutcome
      ? vscode.window.showWarningMessage(successMessage)
      : vscode.window.showInformationMessage(successMessage);
    Promise.resolve(confirmation).catch(reportConfirmationFailure);
  } catch (_error) {
    reportConfirmationFailure();
  }
}

function friendlyErrorMessage(error) {
  const code = error && error.code;
  if (
    code === "ENOENT" ||
    code === "EXECUTABLE_NOT_FOUND" ||
    code === "NODE_EXECUTABLE_NOT_FOUND"
  ) {
    return t("Codex CLI was not found. Run diagnostics or configure the executable.");
  }
  if (
    code === "EXECUTABLE_IN_WORKSPACE" ||
    code === "UNSAFE_COMMAND_SHIM" ||
    code === "UNSAFE_NODE_EXECUTABLE" ||
    code === "UNSUPPORTED_WINDOWS_SCRIPT" ||
    code === "INVALID_CODEX_PACKAGE" ||
    code === "INVALID_EXECUTABLE_NAME" ||
    code === "WORKSPACE_ROOT_UNREADABLE" ||
    code === "EXECUTABLE_CHANGED" ||
    code === "EXECUTABLE_NOT_REGULAR" ||
    code === "EXECUTABLE_NOT_EXECUTABLE" ||
    code === "EXECUTABLE_UNREADABLE"
  ) {
    return t("The configured Codex executable was rejected by the safety checks.");
  }
  if (code === "CODEX_CLI_INCOMPATIBLE") {
    return t("The installed Codex CLI is too old for safe structured generation.");
  }
  if (code === "ETIMEDOUT") {
    return t("Codex generation timed out.");
  }
  if (code === "OUTPUT_LIMIT") {
    return t("Codex output exceeded the configured limit; nothing was applied.");
  }
  if (code === "CODEX_POLICY_VIOLATION") {
    return t("Codex attempted an operation disabled by the current safety policy.");
  }
  if (code === "DOCUMENT_CHANGED") {
    return t("The note changed during generation, so nothing was applied.");
  }
  if (code === "INPUT_LIMIT" || code === "TARGET_LIMIT") {
    return t("The note or target selection exceeds the configured safety limit.");
  }
  if (
    code === "INVALID_STRUCTURED_OUTPUT" ||
    (error && error.name === "StructuredOutputError")
  ) {
    return t("Codex returned an invalid structured response; nothing was applied.");
  }
  if (
    code === "DIFF_UNAVAILABLE" ||
    (error && error.phase === "review")
  ) {
    return t("The generated diff could not be opened, so nothing was applied.");
  }
  if (code === "APPLY_REJECTED" || (error && error.phase === "apply")) {
    return t("VS Code could not safely apply the generated update.");
  }
  if (code === "STORAGE_UNAVAILABLE" || (error && error.phase === "storage")) {
    return t("Extension storage is unavailable, so Codex was not started.");
  }
  if (error && error.phase === "configuration") {
    return t("A Codex Note Helper setting is invalid. Review the extension settings.");
  }
  if (error && error.phase === "parse") {
    return t(
      "The note contains malformed Markdown or damaged ownership markers. Close any unclosed Markdown block and repair the Codex Note Helper markers."
    );
  }
  return t("Codex generation failed; nothing was applied.");
}

async function openFailureLog() {
  const uri = vscode.Uri.joinPath(
    extensionContext.globalStorageUri,
    "logs",
    "failures.log"
  );
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
}

async function handleRunError(error, targetCount = 0, document) {
  if (
    error &&
    (error.cancelled || error.name === "AbortError" || error.code === "ABORT_ERR")
  ) {
    vscode.window.showWarningMessage(t("Codex generation was cancelled."));
    return;
  }
  let logSaved = false;
  try {
    const entry = formatFailureLog({
      error,
      targetSections: Array.from({ length: targetCount })
    });
    await appendFailureLog(getStorageDirectory(), entry);
    logSaved = true;
  } catch (_logError) {
    // Preserve the original error if diagnostic logging itself fails.
  }
  const actions = [];
  if (logSaved) {
    actions.push(t("Open failure log"));
  }
  if (!error || error.phase !== "parse") {
    if (canOfferBundledCliSetting(error, document)) {
      actions.push(t("Open bundled CLI setting"));
    } else if (isMissingExecutableError(error)) {
      actions.push(t("Choose CLI source"));
    }
    actions.push(t("Run diagnostics"), t("Open settings"));
  }
  const choice = await vscode.window.showErrorMessage(
    friendlyErrorMessage(error),
    ...actions
  );
  if (choice === t("Open failure log")) {
    await openFailureLog();
  } else if (choice === t("Open bundled CLI setting")) {
    await openBundledCliSetting();
  } else if (choice === t("Choose CLI source")) {
    await vscode.commands.executeCommand("codexNoteHelper.chooseCliSource");
  } else if (choice === t("Run diagnostics")) {
    await vscode.commands.executeCommand("codexNoteHelper.runDiagnostics");
  } else if (choice === t("Open settings")) {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "@ext:trinitrotorol.codex-note-helper"
    );
  }
}

async function fillWithCodex() {
  const editor = getActiveMarkdownEditor();
  if (!editor) {
    return;
  }
  const key = editor.document.uri.toString();
  const existingRun = activeRuns.get(key);
  if (existingRun && existingRun.review && !existingRun.review.settled) {
    await reopenPendingReviewCommand(editor.document.uri);
    return;
  }
  if (existingRun) {
    vscode.window.showWarningMessage(
      t("Codex Note Helper is already running for this note.")
    );
    return;
  }
  if (activeRuns.size >= MAX_CONCURRENT_RUNS) {
    vscode.window.showWarningMessage(
      t("Wait for an active Codex Note Helper run to finish first.")
    );
    return;
  }

  const controller = new AbortController();
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  const documentLabel = safeDocumentLabel(workspaceFolder
    ? `${workspaceFolder.name}/${vscode.workspace.asRelativePath(
        editor.document.uri,
        false
      )}`
    : path.basename(editor.document.uri.path));
  const state = {
    controller,
    detail: safeDocumentLabel(
      path.dirname(editor.document.uri.fsPath || editor.document.uri.path)
    ),
    label: documentLabel,
    phase: "preparing",
    promise: undefined,
    targetCount: 0
  };
  const promise = runGenerationWorkflow(
    editor,
    controller,
    documentLabel,
    (targetCount) => {
      state.targetCount = targetCount;
    },
    (phase) => {
      state.phase = phase;
    },
    state
  ).catch((error) => {
    // Terminal UI must not retain the document lock or block deactivation while
    // the user leaves a notification open.
    Promise.resolve(
      handleRunError(error, state.targetCount, editor.document)
    ).catch(() => {
      if (diagnosticsChannel) {
        diagnosticsChannel.appendLine(
          t("The failure notification action could not be completed.")
        );
      }
    });
  });
  state.promise = promise;
  activeRuns.set(key, state);
  try {
    await promise;
  } finally {
    if (activeRuns.get(key) === state) {
      activeRuns.delete(key);
    }
  }
}

async function selectPendingReview(resource, placeHolder, allowSingleFallback) {
  const reviews = getPendingReviewStates();
  if (reviews.length === 0) {
    vscode.window.showInformationMessage(
      t("No generated update is waiting for review.")
    );
    return undefined;
  }

  if (resource) {
    const match = reviews.find((state) => reviewMatchesResource(state, resource));
    if (match) {
      return match;
    }
    vscode.window.showInformationMessage(
      t("No generated update is waiting for review.")
    );
    return undefined;
  }
  const activeResource =
    vscode.window.activeTextEditor && vscode.window.activeTextEditor.document
      ? vscode.window.activeTextEditor.document.uri
      : undefined;
  if (activeResource) {
    const match = reviews.find((state) =>
      reviewMatchesResource(state, activeResource)
    );
    if (match) {
      return match;
    }
  }
  if (reviews.length === 1 && allowSingleFallback) {
    return reviews[0];
  }

  const picked = await vscode.window.showQuickPick(
    reviews.map((state) => ({
      label: state.label,
      detail: state.detail,
      state
    })),
    { placeHolder }
  );
  return picked && picked.state;
}

function abortStaleReview(state, review) {
  if (!review || review.settled || state.review !== review) {
    return true;
  }
  try {
    assertDocumentSnapshot(
      review.document,
      review.originalVersion,
      review.originalText
    );
    return false;
  } catch (error) {
    if (!state.controller.signal.aborted) {
      state.controller.abort(error);
    }
    return true;
  }
}

async function reopenPendingReviewCommand(resource) {
  const state = await selectPendingReview(
    resource,
    t("Select a generated update to review"),
    true
  );
  if (!state) {
    return;
  }
  const review = state.review;
  if (abortStaleReview(state, review)) {
    return;
  }
  try {
    await showGeneratedDiff(review.preview, state.label);
  } catch (_error) {
    vscode.window.showErrorMessage(
      t(
        "The pending review diff could not be reopened. The update remains pending."
      )
    );
  }
}

async function applyPendingReviewCommand(resource) {
  const state = await selectPendingReview(
    resource,
    t("Select a generated update to apply"),
    false
  );
  if (!state) {
    return;
  }
  const review = state.review;
  if (abortStaleReview(state, review)) {
    return;
  }
  review.settle(true);
}

async function discardPendingReviewCommand(resource) {
  const state = await selectPendingReview(
    resource,
    t("Select a generated update to discard"),
    false
  );
  const review = state && state.review;
  if (review && !review.settled && state.review === review) {
    review.settle(false);
  }
}

async function cancelRunCommand() {
  if (activeRuns.size === 0) {
    vscode.window.showInformationMessage(t("No Codex Note Helper run is active."));
    return;
  }
  let selected;
  if (activeRuns.size === 1) {
    selected = [...activeRuns.values()][0];
  } else {
    const picked = await vscode.window.showQuickPick(
      [...activeRuns.values()].map((run) => ({
        label: run.label,
        detail: run.detail,
        run
      })),
      { placeHolder: t("Select a run to cancel") }
    );
    selected = picked && picked.run;
  }
  if (selected) {
    if (selected.phase === "applying") {
      vscode.window.showInformationMessage(
        t("Changes are already being applied and can no longer be cancelled.")
      );
      return;
    }
    selected.controller.abort();
  }
}

async function listTargetHeadings() {
  const editor = getActiveMarkdownEditor();
  if (!editor) {
    return;
  }
  let options;
  try {
    options = getConfiguration(editor.document);
  } catch (error) {
    await handleRunError(markPhase(error, "configuration"));
    return;
  }
  let targets;
  try {
    targets = findTargetHeadingSections(
      editor.document.getText(),
      options.headingLevel,
      options.fillPolicy
    );
  } catch (error) {
    await handleRunError(markPhase(error, "parse"));
    return;
  }
  if (targets.length === 0) {
    vscode.window.showInformationMessage(
      t("No target headings match the current fill policy.")
    );
    return;
  }
  const picked = await vscode.window.showQuickPick(
    targets.map((section) => ({
      label: section.title || t("Untitled heading"),
      description: t("line {0}", section.lineNumber),
      detail: section.isEmpty
        ? t("Empty section")
        : section.isBulletsOnly
          ? t("List-only section")
          : t("Existing content; generated block will be added or replaced"),
      section
    })),
    {
      placeHolder: t(
        "Target headings for policy '{0}'",
        fillPolicyLabel(options.fillPolicy)
      )
    }
  );
  if (!picked) {
    return;
  }
  const position = new vscode.Position(picked.section.lineIndex, 0);
  editor.selection = new vscode.Selection(position, position);
  editor.revealRange(new vscode.Range(position, position));
}

async function setModeCommand() {
  const editor = vscode.window.activeTextEditor;
  const resource = editor && editor.document.uri;
  const current = vscode.workspace
    .getConfiguration("codexNoteHelper", resource)
    .get("mode", "research");
  const values = [
    ["research", t("Research"), t("Concise research notes with verified references only")],
    ["general", t("General"), t("Concise general-purpose explanatory notes")],
    ["jobHunting", t("Job hunting"), t("Company and application preparation notes")]
  ];
  const picked = await vscode.window.showQuickPick(
    values.map(([value, label, detail]) => ({
      label,
      description: value === current ? t("Current") : "",
      detail,
      value
    })),
    { placeHolder: t("Select a note generation mode") }
  );
  if (!picked) {
    return;
  }
  await updateUserSetting("mode", picked.value, resource);
  vscode.window.showInformationMessage(t("Mode set to {0}.", picked.label));
}

async function setFillPolicyCommand() {
  const editor = vscode.window.activeTextEditor;
  const resource = editor && editor.document.uri;
  const current = vscode.workspace
    .getConfiguration("codexNoteHelper", resource)
    .get("fillPolicy", "emptyOnly");
  const values = [
    ["emptyOnly", t("Empty sections only"), t("Safest: skip sections with existing notes")],
    [
      "emptyOrBulletsOnly",
      t("Empty or list-only sections"),
      t("Keep source lists and add a generated block")
    ],
    [
      "appendAlways",
      t("Every matching section"),
      t("Keep human text and replace the extension-owned generated block")
    ]
  ];
  const picked = await vscode.window.showQuickPick(
    values.map(([value, label, detail]) => ({
      label,
      description: value === current ? t("Current") : "",
      detail,
      value
    })),
    { placeHolder: t("Select which heading sections to update") }
  );
  if (!picked) {
    return;
  }
  await updateUserSetting("fillPolicy", picked.value, resource);
  vscode.window.showInformationMessage(t("Fill policy set to {0}.", picked.label));
}

async function deleteFailureLogCommand() {
  let info;
  try {
    info = await getFailureLogInfo(getStorageDirectory());
  } catch (_error) {
    vscode.window.showErrorMessage(t("The owned failure log could not be inspected."));
    return;
  }
  if (!info.exists) {
    vscode.window.showInformationMessage(t("No failure log exists."));
    return;
  }
  const deleteLabel = t("Delete log");
  const choice = await vscode.window.showWarningMessage(
    t("Delete the extension-owned failure log ({0} bytes)?", info.size),
    { modal: true },
    deleteLabel
  );
  if (choice !== deleteLabel) {
    return;
  }
  try {
    await deleteFailureLog(getStorageDirectory());
    vscode.window.showInformationMessage(t("Failure log deleted."));
  } catch (_error) {
    vscode.window.showErrorMessage(t("The owned failure log could not be deleted."));
  }
}

async function performDiagnostics(signal) {
  if (!diagnosticsChannel) {
    return;
  }
  setContextSafely("codexNoteHelper.initialDiagnosticsPassed", false);
  diagnosticsChannel.clear();
  diagnosticsChannel.appendLine(t("Codex Note Helper diagnostics"));
  diagnosticsChannel.appendLine(
    t("Extension version: {0}", extensionContext.extension.packageJSON.version)
  );
  diagnosticsChannel.appendLine(
    t("Workspace trusted: {0}", yesNoLabel(vscode.workspace.isTrusted))
  );
  diagnosticsChannel.appendLine(
    t("Extension host: {0}", vscode.env.remoteName || t("Local"))
  );
  try {
    const editor = vscode.window.activeTextEditor;
    const options = getConfiguration(editor && editor.document);
    const cliConfigurationSnapshot = {
      codexCommand: options.codexCommand,
      allowBundledCodexFromOpenAIExtension:
        options.allowBundledCodexFromOpenAIExtension,
      ignoreCodexUserConfiguration: options.ignoreCodexUserConfiguration
    };
    const deadline = createOperationDeadline(
      options.timeoutSeconds * 1000,
      signal
    );
    let executable;
    let probe;
    try {
      const resolved = await deadline.run(async (signal) => {
        const runtimeDir = await getRuntimeDirectory();
        throwIfAborted(signal);
        return {
          executable: await resolveCodexCommand(
            options,
            runtimeDir,
            signal,
            editor && editor.document
          ),
          runtimeDir
        };
      });
      executable = resolved.executable;
      if (!(await ensureExecutableConsent(executable, signal))) {
        diagnosticsChannel.appendLine(t("Executable permission: declined"));
        diagnosticsChannel.appendLine(t("Diagnostics result: CANCELLED"));
        diagnosticsChannel.show(true);
        return;
      }
      probe = await deadline.run(async (signal) => {
        const probeExecutable = await resolveCodexCommand(
          options,
          resolved.runtimeDir,
          signal,
          editor && editor.document
        );
        assertExecutableIdentity(executable, probeExecutable);
        return ensureCompatibleCli(
          probeExecutable,
          resolved.runtimeDir,
          options,
          signal
        );
      });
    } finally {
      deadline.dispose();
    }
    diagnosticsChannel.appendLine(
      t("Executable source: {0}", executableSourceLabel(executable.source))
    );
    const info = await getFailureLogInfo(getStorageDirectory());
    diagnosticsChannel.appendLine(t("Codex CLI: {0}", probe.version));
    diagnosticsChannel.appendLine(t("Required structured-output flags: available"));
    diagnosticsChannel.appendLine(
      t(
        "User Codex configuration ignored: {0}",
        yesNoLabel(options.ignoreCodexUserConfiguration)
      )
    );
    diagnosticsChannel.appendLine(
      t("Failure log present: {0}", yesNoLabel(info.exists))
    );
    let currentCliConfiguration;
    try {
      currentCliConfiguration = readCliConfiguration(editor && editor.document);
    } catch (_error) {
      currentCliConfiguration = undefined;
    }
    if (!sameCliConfiguration(cliConfigurationSnapshot, currentCliConfiguration)) {
      throw makeError(
        "The Codex CLI settings changed while diagnostics were running.",
        "EXECUTABLE_CHANGED",
        "preflight"
      );
    }
    diagnosticsChannel.appendLine(t("Diagnostics result: PASS"));
    setContextSafely("codexNoteHelper.initialDiagnosticsPassed", true);
    vscode.window.showInformationMessage(t("Codex Note Helper diagnostics passed."));
  } catch (error) {
    if (
      error &&
      (error.cancelled || error.name === "AbortError" || error.code === "ABORT_ERR")
    ) {
      diagnosticsChannel.appendLine(t("Diagnostics result: CANCELLED"));
      diagnosticsChannel.show(true);
      return;
    }
    diagnosticsChannel.appendLine(t("Diagnostics result: FAIL"));
    diagnosticsChannel.appendLine(
      t("Safe failure reason: {0}", formatSafeFailureReason(error))
    );
    diagnosticsChannel.appendLine(friendlyErrorMessage(error));
    const actions = isMissingExecutableError(error)
      ? [
          ...(canOfferBundledCliSetting(
            error,
            vscode.window.activeTextEditor &&
              vscode.window.activeTextEditor.document
          )
            ? [t("Open bundled CLI setting")]
            : [t("Choose CLI source")]),
          t("Open settings")
        ]
      : [t("Open settings")];
    const choice = await vscode.window.showErrorMessage(
      t("Codex Note Helper diagnostics failed."),
      ...actions
    );
    if (choice === t("Open bundled CLI setting")) {
      await openBundledCliSetting();
    } else if (choice === t("Choose CLI source")) {
      await vscode.commands.executeCommand("codexNoteHelper.chooseCliSource");
    } else if (choice === t("Open settings")) {
      await vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:trinitrotorol.codex-note-helper"
      );
    }
  }
  diagnosticsChannel.show(true);
}

async function runDiagnosticsCommand() {
  if (!diagnosticsChannel) {
    return;
  }
  if (activeDiagnostics) {
    vscode.window.showInformationMessage(
      t("Codex Note Helper diagnostics are already running.")
    );
    return;
  }

  const controller = new AbortController();
  const state = { controller, promise: undefined };
  state.promise = performDiagnostics(controller.signal).finally(() => {
    if (activeDiagnostics === state) {
      activeDiagnostics = undefined;
    }
  });
  activeDiagnostics = state;
  return state.promise;
}

function registerCommand(context, id, handler) {
  context.subscriptions.push(vscode.commands.registerCommand(id, handler));
}

function abortRunForDocument(document) {
  if (!document || !document.uri) {
    return;
  }
  const run = activeRuns.get(document.uri.toString());
  if (!run || run.phase === "applying" || run.controller.signal.aborted) {
    return;
  }
  run.controller.abort(
    makeError(
      "The note changed, closed, or reopened while Codex was running.",
      "DOCUMENT_CHANGED",
      "validation"
    )
  );
}

function activate(context) {
  extensionContext = context;
  previewProvider = new PreviewContentProvider();
  diagnosticsChannel = vscode.window.createOutputChannel(
    t("Codex Note Helper Diagnostics")
  );
  reviewStatusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  reviewStatusBarItem.name = t("Codex Note Helper pending review");
  reviewStatusBarItem.command = "codexNoteHelper.reopenPendingReview";
  context.subscriptions.push(
    diagnosticsChannel,
    previewProvider,
    reviewStatusBarItem,
    vscode.workspace.registerTextDocumentContentProvider(
      PREVIEW_SCHEME,
      previewProvider
    ),
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event && event.contentChanges && event.contentChanges.length > 0) {
        abortRunForDocument(event.document);
      }
    }),
    vscode.workspace.onDidCloseTextDocument((document) => {
      abortRunForDocument(document);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        !event ||
        typeof event.affectsConfiguration !== "function" ||
        (!event.affectsConfiguration("codexNoteHelper.codexCommand") &&
          !event.affectsConfiguration(
            "codexNoteHelper.allowBundledCodexFromOpenAIExtension"
          ) &&
          !event.affectsConfiguration(
            "codexNoteHelper.ignoreCodexUserConfiguration"
          ))
      ) {
        return;
      }
      updateCliSourceConfiguredContext(
        vscode.window.activeTextEditor && vscode.window.activeTextEditor.document
      );
      setContextSafely("codexNoteHelper.initialDiagnosticsPassed", false);
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      updatePendingReviewUi();
    })
  );
  registerCommand(context, "codexNoteHelper.fillWithCodex", fillWithCodex);
  registerCommand(context, "codexNoteHelper.cancelRun", cancelRunCommand);
  registerCommand(
    context,
    "codexNoteHelper.reopenPendingReview",
    reopenPendingReviewCommand
  );
  registerCommand(
    context,
    "codexNoteHelper.applyPendingReview",
    applyPendingReviewCommand
  );
  registerCommand(
    context,
    "codexNoteHelper.discardPendingReview",
    discardPendingReviewCommand
  );
  registerCommand(context, "codexNoteHelper.listTargetHeadings", listTargetHeadings);
  registerCommand(
    context,
    "codexNoteHelper.deleteFailureLog",
    deleteFailureLogCommand
  );
  registerCommand(context, "codexNoteHelper.setMode", setModeCommand);
  registerCommand(
    context,
    "codexNoteHelper.setFillPolicy",
    setFillPolicyCommand
  );
  registerCommand(
    context,
    "codexNoteHelper.runDiagnostics",
    runDiagnosticsCommand
  );
  registerCommand(
    context,
    "codexNoteHelper.chooseCliSource",
    chooseCliSourceCommand
  );
  // Hidden compatibility aliases from versions before 0.3.0.
  registerCommand(
    context,
    "codexNoteHelper.listEmptyHeadings",
    listTargetHeadings
  );
  registerCommand(
    context,
    "codexNoteHelper.runSelfTest",
    runDiagnosticsCommand
  );
  updateCliSourceConfiguredContext();
  updatePendingReviewUi();
}

async function deactivate() {
  for (const run of activeRuns.values()) {
    run.controller.abort();
  }
  if (activeDiagnostics) {
    activeDiagnostics.controller.abort();
  }
  const pending = [...activeRuns.values()].map((run) => run.promise);
  if (activeDiagnostics && activeDiagnostics.promise) {
    pending.push(activeDiagnostics.promise);
  }
  if (pending.length > 0) {
    await Promise.allSettled(pending);
  }
  activeRuns.clear();
  activeDiagnostics = undefined;
  cliProbeCache.clear();
  updatePendingReviewUi();
  extensionContext = undefined;
  diagnosticsChannel = undefined;
  previewProvider = undefined;
  reviewStatusBarItem = undefined;
}

module.exports = {
  activate,
  deactivate,
  deleteFailureLogCommand,
  chooseCliSourceCommand,
  closeGeneratedDiff,
  discardPendingReviewCommand,
  fillWithCodex,
  listTargetHeadings,
  applyProposedEdits,
  applyPendingReviewCommand,
  reopenPendingReviewCommand,
  runDiagnosticsCommand,
  setFillPolicyCommand,
  setModeCommand
};
