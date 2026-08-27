"use strict";

// Capture and audit the Marketplace demo from an isolated VS Code renderer
// using fixed synthetic note and proposal data. This script does not invoke
// Codex or a provider.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const {
  resolveCliArgsFromVSCodeExecutablePath,
  runTests
} = require("@vscode/test-electron");

const REPO_ROOT = path.resolve(__dirname, "..");
const CAPTURE_ROOT = path.join(REPO_ROOT, ".tools", "marketplace-capture");
const USER_DATA_DIR = path.join(CAPTURE_ROOT, "user-data");
const EXTENSIONS_DIR = path.join(CAPTURE_ROOT, "extensions");
const DEMO_WORKSPACE = path.join(CAPTURE_ROOT, "demo");
const CONTROL_DIR = path.join(CAPTURE_ROOT, "control");
const SAFE_HOME_DIR = path.join(CAPTURE_ROOT, "home");
const SAFE_TEMP_DIR = path.join(CAPTURE_ROOT, "temp");
const CODE_ROOT = path.join(
  REPO_ROOT,
  ".vscode-test",
  "vscode-win32-x64-archive-1.135.0"
);
const CODE_EXECUTABLE = path.join(CODE_ROOT, "Code.exe");
const LOCAL_NODE_DIR = path.join(REPO_ROOT, ".tools", "node");
const LOCAL_NODE = path.join(LOCAL_NODE_DIR, "node.exe");
const VSCE_ENTRY = path.join(REPO_ROOT, "node_modules", "@vscode", "vsce", "vsce");
const CAPTURE_SUITE = path.join(REPO_ROOT, "test", "vscode", "capture", "index.js");
const TEST_DRIVER = path.join(REPO_ROOT, "test", "vscode", "driver");
const DEVTOOLS_PORT_FILE = path.join(USER_DATA_DIR, "DevToolsActivePort");
const WIDTH = 1280;
const HEIGHT = 720;
const POLL_MS = 100;
const DEFAULT_TIMEOUT_MS = 45_000;

const DEMO_NOTE = "# Hamiltonian simulation\n";
const EXPECTED_DEMO_OWNERSHIP_ID = `heading-${createHash("sha256")
  .update("atx\0" + "1\0Hamiltonian simulation", "utf8")
  .digest("hex")}-1`;
const PRIVATE_LOCAL_IDENTIFIERS = [...new Set(
  [
    process.env.USERNAME,
    process.env.USER,
    process.env.USERPROFILE && path.basename(process.env.USERPROFILE),
    process.env.HOME && path.basename(process.env.HOME)
  ]
    .map((value) => String(value || "").trim())
    .filter((value) => value.length >= 3)
)];

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value.`);
  }
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertRegularFile(filePath, label) {
  if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`${label} is unavailable.`);
  }
}

function assertCaptureRoot() {
  const toolsRoot = `${path.resolve(REPO_ROOT, ".tools")}${path.sep}`.toLowerCase();
  const captureRoot = `${path.resolve(CAPTURE_ROOT)}${path.sep}`.toLowerCase();
  if (!captureRoot.startsWith(toolsRoot) || captureRoot === toolsRoot) {
    throw new Error("The capture root escaped the repository's ignored tooling directory.");
  }
}

function assertNoReparsePointWithinRepository(target) {
  const repositoryRoot = path.resolve(REPO_ROOT);
  const repositoryPrefix = `${repositoryRoot}${path.sep}`.toLowerCase();
  let current = path.resolve(target);
  if (
    current.toLowerCase() !== repositoryRoot.toLowerCase() &&
    !current.toLowerCase().startsWith(repositoryPrefix)
  ) {
    throw new Error("A capture path escaped the repository boundary.");
  }
  while (current.toLowerCase() !== repositoryRoot.toLowerCase()) {
    const stats = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stats?.isSymbolicLink()) {
      throw new Error("Refusing to use a capture path through a reparse point.");
    }
    current = path.dirname(current);
  }
}

function resetDirectory(directory) {
  const captureRoot = `${path.resolve(CAPTURE_ROOT)}${path.sep}`.toLowerCase();
  const resolved = `${path.resolve(directory)}${path.sep}`.toLowerCase();
  if (resolved !== captureRoot && !resolved.startsWith(captureRoot)) {
    throw new Error("Refusing to reset a directory outside the capture root.");
  }
  assertNoReparsePointWithinRepository(directory);
  fs.rmSync(directory, { force: true, recursive: true });
  fs.mkdirSync(directory, { recursive: true });
}

function safeEnvironment() {
  const original = { ...process.env };
  const systemRoot = original.SystemRoot || original.SYSTEMROOT || "C:\\Windows";
  const comSpec = original.ComSpec || original.COMSPEC || path.join(systemRoot, "System32", "cmd.exe");
  const pathEntries = [
    LOCAL_NODE_DIR,
    path.join(systemRoot, "System32"),
    systemRoot,
    path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")
  ];
  const gitCommandDirectory = "C:\\Program Files\\Git\\cmd";
  if (fs.statSync(gitCommandDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    pathEntries.push(gitCommandDirectory);
  }
  const parsedRoot = path.parse(CAPTURE_ROOT);
  const homeRelative = path.relative(parsedRoot.root, SAFE_HOME_DIR);
  return {
    APPDATA: path.join(SAFE_HOME_DIR, "AppData", "Roaming"),
    COMSPEC: comSpec,
    HOME: SAFE_HOME_DIR,
    HOMEDRIVE: parsedRoot.root.replace(/[\\/]$/u, ""),
    HOMEPATH: `\\${homeRelative.replace(/[\\/]/gu, "\\")}`,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    LOCALAPPDATA: path.join(SAFE_HOME_DIR, "AppData", "Local"),
    NO_COLOR: "1",
    PATH: pathEntries.join(path.delimiter),
    PATHEXT: original.PATHEXT || ".COM;.EXE;.BAT;.CMD",
    SYSTEMROOT: systemRoot,
    TEMP: SAFE_TEMP_DIR,
    TMP: SAFE_TEMP_DIR,
    USERPROFILE: SAFE_HOME_DIR,
    WINDIR: systemRoot
  };
}

function replaceProcessEnvironment(environment) {
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(environment)) {
    process.env[key] = value;
  }
}

function writeSettings() {
  const settings = {
    "breadcrumbs.enabled": false,
    "chat.disableAIFeatures": true,
    "codexNoteHelper.applySaveBehavior": "leaveUnsaved",
    "codexNoteHelper.confirmBeforeRun": "never",
    "codexNoteHelper.enableWebSearch": false,
    "codexNoteHelper.fillPolicy": "emptyOnly",
    "codexNoteHelper.headingLevel": 1,
    "codexNoteHelper.ignoreCodexUserConfiguration": true,
    "codexNoteHelper.mode": "research",
    "codexNoteHelper.outputLanguage": "English",
    "codexNoteHelper.showCodexProgress": true,
    "diffEditor.hideUnchangedRegions.enabled": false,
    "diffEditor.renderSideBySide": false,
    "diffEditor.wordWrap": "on",
    "editor.cursorBlinking": "solid",
    "editor.fontSize": 16,
    "editor.minimap.enabled": false,
    "editor.renderWhitespace": "none",
    "editor.wordWrap": "on",
    "extensions.autoCheckUpdates": false,
    "extensions.autoUpdate": false,
    "extensions.ignoreRecommendations": true,
    "files.autoSave": "off",
    "git.enabled": false,
    "security.workspace.trust.enabled": false,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "window.commandCenter": false,
    "window.menuBarVisibility": "hidden",
    "window.title": "Codex Note Helper Demo",
    "window.titleBarStyle": "native",
    "workbench.activityBar.location": "hidden",
    "workbench.colorTheme": "Default Dark Modern",
    "workbench.editor.enablePreview": false,
    "workbench.editor.labelFormat": "short",
    "workbench.editor.showIcons": false,
    "workbench.enableExperiments": false,
    "workbench.startupEditor": "none",
    "workbench.statusBar.visible": true,
    "workbench.secondarySideBar.defaultVisibility": "hidden",
    "workbench.tips.enabled": false,
    "workbench.welcomePage.walkthroughs.openOnInstall": false
  };
  const settingsPath = path.join(USER_DATA_DIR, "User", "settings.json");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPO_ROOT,
    encoding: "utf8",
    env: process.env,
    shell: Boolean(options.shell),
    stdio: options.stdio || "pipe",
    windowsHide: true
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const error = new Error(`${options.label || "A capture command"} failed.`);
    error.stdout = result.stdout;
    error.stderr = result.stderr;
    throw error;
  }
  return result;
}

function packageAndInstall(manifest) {
  const vsixPath = path.join(CAPTURE_ROOT, `codex-note-helper-${manifest.version}.vsix`);
  runCommand(
    LOCAL_NODE,
    [
      VSCE_ENTRY,
      "package",
      "--no-dependencies",
      "--out",
      vsixPath
    ],
    { label: "Strict VSIX packaging", stdio: "inherit" }
  );

  const [cli, ...cliPrefix] = resolveCliArgsFromVSCodeExecutablePath(CODE_EXECUTABLE);
  runCommand(
    cli,
    [
      ...cliPrefix,
      `--user-data-dir=${USER_DATA_DIR}`,
      `--extensions-dir=${EXTENSIONS_DIR}`,
      "--install-extension",
      vsixPath,
      "--force"
    ],
    {
      label: "Isolated VSIX installation",
      shell: process.platform === "win32",
      stdio: "inherit"
    }
  );
}

function exposeCaptureHook(manifest) {
  const installedMain = path.join(
    EXTENSIONS_DIR,
    `trinitrotorol.codex-note-helper-${manifest.version}`,
    "extension.js"
  );
  assertRegularFile(installedMain, "The isolated installed extension entry point");
  fs.appendFileSync(
    installedMain,
    [
      "",
      "// Capture-only staging hook; this installed copy is never packaged.",
      "const __captureActivate = module.exports.activate;",
      "module.exports.activate = async function captureActivate(context) {",
      "  await __captureActivate(context);",
      "  return { __captureRequestApply: requestApply };",
      "};",
      ""
    ].join("\n"),
    "utf8"
  );
}

class CdpClient {
  constructor(url, expectedPort) {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "ws:" ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.port !== String(expectedPort) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      !/^\/devtools\/page\/[A-Za-z0-9_-]+$/u.test(parsed.pathname)
    ) {
      throw new Error("A DevTools renderer endpoint escaped the loopback boundary.");
    }
    this.url = parsed.href;
    this.socket = undefined;
    this.nextId = 1;
    this.pending = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        this.socket.removeEventListener("open", onOpen);
        this.socket.removeEventListener("error", onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error("Could not connect to the isolated VS Code renderer."));
      };
      timer = setTimeout(() => {
        cleanup();
        try {
          this.socket.close();
        } catch (_error) {
          // The bounded connection attempt is already being rejected.
        }
        reject(new Error("The isolated VS Code renderer connection timed out."));
      }, 3_000);
      this.socket.addEventListener("open", onOpen, { once: true });
      this.socket.addEventListener("error", onError, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch (_error) {
        return;
      }
      if (!message.id || !this.pending.has(message.id)) {
        return;
      }
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(`CDP command failed: ${pending.method}`));
      } else {
        pending.resolve(message.result || {});
      }
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("The isolated VS Code renderer closed."));
      }
      this.pending.clear();
    });
  }

  request(method, params = {}, timeoutMs = 10_000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP is not connected."));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, reject, resolve, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.request("Runtime.evaluate", {
      awaitPromise: true,
      expression,
      returnByValue: true
    });
    if (result.exceptionDetails) {
      throw new Error("The isolated workbench evaluation failed.");
    }
    return result.result && result.result.value;
  }

  close() {
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
      this.socket.close();
    }
  }
}

async function waitFor(check, label, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(POLL_MS);
  }
  const error = new Error(`Timed out waiting for ${label}.`);
  if (lastError) {
    error.cause = lastError;
  }
  throw error;
}

async function readDevToolsPort() {
  return waitFor(async () => {
    const contents = await fs.promises.readFile(DEVTOOLS_PORT_FILE, "utf8").catch(
      (error) => {
        if (error && error.code === "ENOENT") {
          return "";
        }
        throw error;
      }
    );
    const [portText, browserPath] = contents.trim().split(/\r?\n/u);
    const port = Number(portText);
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !/^\/devtools\/browser\/[A-Za-z0-9-]+$/u.test(browserPath || "")
    ) {
      return undefined;
    }
    return port;
  }, "the isolated DevTools endpoint", 20_000);
}

async function fetchTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(3_000)
  });
  if (!response.ok) {
    throw new Error("The isolated DevTools target list was unavailable.");
  }
  const targets = await response.json();
  return Array.isArray(targets) ? targets : [];
}

function eligibleTarget(target) {
  if (!target || target.type !== "page" || !target.webSocketDebuggerUrl) {
    return false;
  }
  const url = String(target.url || "").toLowerCase();
  return !(
    url.startsWith("devtools:") ||
    url.startsWith("chrome-extension:") ||
    url.startsWith("vscode-webview:")
  );
}

async function connectWorkbench(port) {
  return waitFor(async () => {
    const matches = [];
    const targets = (await fetchTargets(port)).filter(eligibleTarget);
    for (const target of targets) {
      const client = new CdpClient(target.webSocketDebuggerUrl, port);
      try {
        await client.connect();
        const isWorkbench = await client.evaluate(
          "Boolean(document.querySelector('.monaco-workbench')) && document.title.includes('Codex Note Helper Demo')"
        );
        if (isWorkbench) {
          matches.push({ client, target });
        } else {
          client.close();
        }
      } catch (_error) {
        client.close();
      }
    }
    if (matches.length > 1) {
      for (const match of matches) {
        match.client.close();
      }
      throw new Error("More than one isolated VS Code workbench matched.");
    }
    return matches[0];
  }, "the isolated VS Code workbench", 25_000);
}

async function setCaptureViewport(client, targetId) {
  await client.request("Page.enable");
  await client.request("Runtime.enable");
  await client.request("Page.bringToFront");
  try {
    const window = await client.request("Browser.getWindowForTarget", { targetId });
    await client.request("Browser.setContentsSize", {
      height: HEIGHT,
      width: WIDTH,
      windowId: window.windowId
    });
  } catch (_error) {
    // Device emulation below is authoritative for the renderer-only pixels.
  }
  await client.request("Emulation.setDeviceMetricsOverride", {
    deviceScaleFactor: 1,
    height: HEIGHT,
    mobile: false,
    screenHeight: HEIGHT,
    screenWidth: WIDTH,
    width: WIDTH
  });
  await client.request("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: 8,
    y: 8
  });
  await client.evaluate(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
  );
}

async function bodyText(client) {
  return String(
    (await client.evaluate("document.body ? document.body.innerText : ''")) || ""
  );
}

function shannonEntropy(value) {
  const counts = new Map();
  for (const character of value) {
    counts.set(character, (counts.get(character) || 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function textViolations(text) {
  const violations = [];
  const sanitized = String(text).replace(
    /id=heading-((?:[a-f0-9]\s*){64})-([1-9][0-9]*)/giu,
    (match, spacedDigest, occurrence) => {
      const actualId = `heading-${spacedDigest.replace(/\s/gu, "")}-${occurrence}`;
      if (actualId !== EXPECTED_DEMO_OWNERSHIP_ID) {
        violations.push("unexpected-ownership-id");
        return match;
      }
      return "id=heading-demo-id";
    }
  );
  const patterns = [
    ["email", /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
    ["windows-path", /\b[A-Z]:[\\/]/u],
    ["posix-home", /(?:\/Users\/|\/home\/)[^\s/]+/u],
    ["unc-path", /\\\\[A-Za-z0-9._-]+\\/u],
    ["uri", /\b(?:file|vscode-remote|ssh-remote|https?|ws|wss):\/\//iu],
    ["ip-address", /\b(?:\d{1,3}\.){3}\d{1,3}\b/u],
    ["uuid", /\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b/iu],
    ["github-token", /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]+/iu],
    ["api-token", /\b(?:sk-|Bearer\s+|eyJ[A-Za-z0-9_-]+\.)[A-Za-z0-9_.-]+/u],
    ["credential-assignment", /\b(?:token|secret|password|authorization|credential)\s*[:=]/iu],
    ["clock-time", /\b\d{1,2}:\d{2}(?::\d{2})?\b/u]
  ];
  violations.push(
    ...patterns
      .filter(([_name, pattern]) => pattern.test(sanitized))
      .map(([name]) => name)
  );
  if (
    PRIVATE_LOCAL_IDENTIFIERS.some((identifier) =>
      new RegExp(`(?:^|[^A-Za-z0-9_])${escapeRegExp(identifier)}(?:[^A-Za-z0-9_]|$)`, "iu")
        .test(sanitized)
    )
  ) {
    violations.push("local-user");
  }
  const tokens = sanitized.match(/[A-Za-z0-9_+/=-]{28,}/gu) || [];
  if (tokens.some((token) => shannonEntropy(token) >= 4.25)) {
    violations.push("high-entropy-token");
  }
  return [...new Set(violations)];
}

async function collectVisibleTexts(port, workbench) {
  const texts = [await bodyText(workbench.client)];
  const targets = (await fetchTargets(port)).filter(
    (target) =>
      target &&
      target.type === "page" &&
      target.webSocketDebuggerUrl &&
      target.id !== workbench.target.id &&
      !String(target.url || "").toLowerCase().startsWith("devtools:")
  );
  for (const target of targets) {
    const client = new CdpClient(target.webSocketDebuggerUrl, port);
    try {
      await client.connect();
      texts.push(String((await client.evaluate("document.body ? document.body.innerText : ''")) || ""));
    } finally {
      client.close();
    }
  }
  return texts.join("\n\n--- isolated surface ---\n\n");
}

async function waitForStableWorkbench(port, workbench, requiredText) {
  await waitFor(async () => {
    const first = await collectVisibleTexts(port, workbench);
    if (!first.includes(requiredText)) {
      return false;
    }
    await delay(250);
    const second = await collectVisibleTexts(port, workbench);
    return first === second;
  }, `stable workbench text '${requiredText}'`);
}

async function captureFrame(port, workbench, stageName, requiredText) {
  await waitForStableWorkbench(port, workbench, requiredText);
  await workbench.client.evaluate(
    "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))"
  );
  const visibleText = await collectVisibleTexts(port, workbench);
  const violations = textViolations(visibleText);
  if (violations.length > 0) {
    throw new Error(`Frame ${stageName} failed text audit: ${violations.join(", ")}.`);
  }
  const screenshot = await workbench.client.request("Page.captureScreenshot", {
    captureBeyondViewport: false,
    format: "png",
    fromSurface: true,
    optimizeForSpeed: false
  });
  const payload = Buffer.from(screenshot.data || "", "base64");
  if (
    payload.length < 24 ||
    payload.readUInt32BE(16) !== WIDTH ||
    payload.readUInt32BE(20) !== HEIGHT
  ) {
    throw new Error(`Frame ${stageName} has unexpected renderer dimensions.`);
  }
  fs.writeFileSync(path.join(CAPTURE_ROOT, `${stageName}.png`), payload, { flag: "wx" });
  fs.writeFileSync(path.join(CAPTURE_ROOT, `${stageName}.visible-text.txt`), visibleText, {
    encoding: "utf8",
    flag: "wx"
  });
}

async function visibleButtonCenter(client, label) {
  const expression = `(() => {
    const wanted = ${JSON.stringify(label)};
    const candidates = [...document.querySelectorAll('button, a.monaco-button, [role="button"]')];
    const element = candidates.find((candidate) => {
      const text = String(candidate.textContent || '').replace(/\\s+/g, ' ').trim();
      const rect = candidate.getBoundingClientRect();
      const style = getComputedStyle(candidate);
      return text === wanted && rect.width > 0 && rect.height > 0 &&
        style.visibility !== 'hidden' && style.display !== 'none';
    });
    if (!element) return undefined;
    const rect = element.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`;
  return client.evaluate(expression);
}

async function movePointer(client, center) {
  await client.request("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: center.x,
    y: center.y
  });
}

async function pressPointer(client, center) {
  await client.request("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 1,
    clickCount: 1,
    type: "mousePressed",
    x: center.x,
    y: center.y
  });
}

async function releasePointer(client, center) {
  await client.request("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 0,
    clickCount: 1,
    type: "mouseReleased",
    x: center.x,
    y: center.y
  });
}

async function cancelPressedPointer(client) {
  const safePoint = { x: 8, y: 8 };
  await client.request("Input.dispatchMouseEvent", {
    button: "left",
    buttons: 1,
    type: "mouseMoved",
    x: safePoint.x,
    y: safePoint.y
  });
  await releasePointer(client, safePoint);
}

async function clickVisibleButton(client, label) {
  const center = await visibleButtonCenter(client, label);
  if (!center) {
    return false;
  }
  await movePointer(client, center);
  await pressPointer(client, center);
  await releasePointer(client, center);
  return true;
}

function stageExists(stage) {
  return fs.statSync(
    path.join(CONTROL_DIR, `${stage}.ready.json`),
    { throwIfNoEntry: false }
  )?.isFile();
}

async function waitForStage(stage, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await waitFor(() => stageExists(stage), `capture stage '${stage}'`, timeoutMs);
}

function releaseGate(gate) {
  fs.writeFileSync(path.join(CONTROL_DIR, `${gate}.go`), "go\n", {
    encoding: "utf8",
    flag: "wx"
  });
}

function launchArguments() {
  return [
    DEMO_WORKSPACE,
    "--new-window",
    "--remote-debugging-port=0",
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${USER_DATA_DIR}`,
    `--extensions-dir=${EXTENSIONS_DIR}`,
    "--locale=en",
    "--sync=off",
    "--disable-updates",
    "--disable-telemetry",
    "--skip-welcome",
    "--skip-release-notes",
    "--disable-workspace-trust"
  ];
}

async function runIsolatedWindow(mode, manifest, drive) {
  resetDirectory(CONTROL_DIR);
  fs.writeFileSync(path.join(DEMO_WORKSPACE, "note.md"), DEMO_NOTE, "utf8");
  fs.rmSync(DEVTOOLS_PORT_FILE, { force: true });

  const runPromise = runTests({
    vscodeExecutablePath: CODE_EXECUTABLE,
    extensionDevelopmentPath: TEST_DRIVER,
    extensionTestsPath: CAPTURE_SUITE,
    launchArgs: launchArguments(),
    extensionTestsEnv: {
      CNH_DEMO_CONTROL_DIR: CONTROL_DIR,
      CNH_DEMO_EXPECTED_VERSION: manifest.version,
      CNH_DEMO_MODE: mode,
      CNH_DEMO_WORKSPACE: DEMO_WORKSPACE
    }
  });
  runPromise.catch(() => {});

  let workbench;
  try {
    const port = await readDevToolsPort();
    workbench = await connectWorkbench(port);
    await setCaptureViewport(workbench.client, workbench.target.id);
    await drive(port, workbench);
    await runPromise;
  } catch (error) {
    if (workbench) {
      try {
        await workbench.client.request("Browser.close", {}, 3_000);
      } catch (_closeError) {
        // The test runner also has a bounded failure path.
      }
    }
    await Promise.race([runPromise.catch(() => {}), delay(5_000)]);
    throw error;
  } finally {
    if (workbench) {
      workbench.client.close();
    }
  }
}

async function captureDemo(port, workbench) {
  await waitForStage("01-edit-preview");
  await captureFrame(port, workbench, "01-edit-preview", "note.md");
  releaseGate("start-generation");

  await waitForStage("02-generation-started");
  await captureFrame(
    port,
    workbench,
    "02-generating-a",
    "Generating a preview for 1 section(s) with Codex"
  );
  await delay(450);
  await captureFrame(
    port,
    workbench,
    "03-generating-b",
    "Generating a preview for 1 section(s) with Codex"
  );
  releaseGate("finish-generation");

  await waitForStage("03-review");
  const applyCenter = await waitFor(
    () => visibleButtonCenter(workbench.client, "Apply changes"),
    "the real Apply changes notification button"
  );
  await movePointer(workbench.client, applyCenter);
  await delay(180);
  await captureFrame(port, workbench, "04-review", "Apply changes");
  await pressPointer(workbench.client, applyCenter);
  try {
    await delay(100);
    await captureFrame(port, workbench, "05-apply-pressed", "Apply changes");
  } finally {
    await cancelPressedPointer(workbench.client);
  }
  if (!(await clickVisibleButton(workbench.client, "Apply changes"))) {
    throw new Error("The real Apply changes button disappeared before activation.");
  }

  await waitForStage("04-applied");
  await captureFrame(
    port,
    workbench,
    "06-applied",
    "Save the note when ready."
  );
  releaseGate("finish");
}

function runGifBuilder(pythonPath) {
  runCommand(
    pythonPath,
    [
      path.join(REPO_ROOT, "scripts", "build-marketplace-demo-gif.py"),
      "--capture-dir",
      CAPTURE_ROOT
    ],
    { label: "GIF construction and metadata audit", stdio: "inherit" }
  );
}

async function main() {
  assertCaptureRoot();
  const pythonPath = path.resolve(argumentValue("--python") || "");
  assertRegularFile(CODE_EXECUTABLE, "The cached VS Code executable");
  assertRegularFile(LOCAL_NODE, "The pinned Node.js runtime");
  assertRegularFile(VSCE_ENTRY, "The local VSCE entry point");
  assertRegularFile(CAPTURE_SUITE, "The capture suite");
  assertRegularFile(pythonPath, "The Pillow-enabled Python runtime");

  resetDirectory(CAPTURE_ROOT);
  for (const directory of [
    USER_DATA_DIR,
    EXTENSIONS_DIR,
    DEMO_WORKSPACE,
    CONTROL_DIR,
    SAFE_HOME_DIR,
    SAFE_TEMP_DIR
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  writeSettings();

  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
  );
  replaceProcessEnvironment(safeEnvironment());
  packageAndInstall(manifest);
  exposeCaptureHook(manifest);

  process.stdout.write("Capturing isolated VS Code renderer frames.\n");
  await runIsolatedWindow("capture", manifest, captureDemo);
  runGifBuilder(pythonPath);
  process.stdout.write("Capture and automated audit completed.\n");
}

main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
  if (error && error.stdout) {
    process.stderr.write(String(error.stdout));
  }
  if (error && error.stderr) {
    process.stderr.write(String(error.stderr));
  }
  process.exitCode = 1;
});
