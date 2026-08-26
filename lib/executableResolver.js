"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_SHIM_BYTES = 64 * 1024;
const MAX_PACKAGE_JSON_BYTES = 64 * 1024;
const HASH_CHUNK_BYTES = 64 * 1024;
const DEFAULT_WINDOWS_PATH_EXTENSIONS = [".COM", ".EXE", ".BAT", ".CMD"];

function resolverError(code, message) {
  const error = new Error(message);
  error.name = "ExecutableResolutionError";
  error.code = code;
  return error;
}

function throwIfAborted(signal) {
  if (!signal || !signal.aborted) {
    return;
  }
  const error = new Error("Executable resolution was cancelled.");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  error.cancelled = true;
  throw error;
}

function sameFileStat(left, right) {
  return ["dev", "ino", "mode", "size", "mtimeMs", "ctimeMs"].every(
    (field) => left[field] === right[field]
  );
}

async function hashRegularFile(realPath, initialStat, fsImpl, signal) {
  throwIfAborted(signal);
  let handle;
  try {
    handle = await fsImpl.open(realPath, "r");
    throwIfAborted(signal);
    const before = await handle.stat();
    throwIfAborted(signal);
    if (!before.isFile() || !sameFileStat(initialStat, before)) {
      throw resolverError(
        "EXECUTABLE_CHANGED",
        "The executable changed while it was being inspected."
      );
    }

    const hash = crypto.createHash("sha256");
    const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let position = 0;
    while (position < before.size) {
      throwIfAborted(signal);
      const length = Math.min(buffer.length, before.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      throwIfAborted(signal);
      if (bytesRead <= 0) {
        throw resolverError(
          "EXECUTABLE_CHANGED",
          "The executable changed while it was being inspected."
        );
      }
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }

    const after = await handle.stat();
    throwIfAborted(signal);
    if (!sameFileStat(before, after) || position !== after.size) {
      throw resolverError(
        "EXECUTABLE_CHANGED",
        "The executable changed while it was being inspected."
      );
    }
    const pathAfter = await fsImpl.stat(realPath);
    throwIfAborted(signal);
    if (!sameFileStat(after, pathAfter)) {
      throw resolverError(
        "EXECUTABLE_CHANGED",
        "The executable changed while it was being inspected."
      );
    }
    return hash.digest("hex");
  } catch (error) {
    if (error && (error.code === "ABORT_ERR" || error.code === "EXECUTABLE_CHANGED")) {
      throw error;
    }
    throw resolverError(
      "EXECUTABLE_UNREADABLE",
      "The executable contents could not be inspected."
    );
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch (_error) {
        // A completed fingerprint is still valid even if close reports an error.
      }
    }
  }
}

function environmentValue(environment, name, platform) {
  const source = environment || {};
  if (platform !== "win32") {
    return source[name];
  }
  const wanted = name.toUpperCase();
  const match = Object.keys(source).find((key) => key.toUpperCase() === wanted);
  return match === undefined ? undefined : source[match];
}

function windowsPathExtensions(environment) {
  const configured = String(
    environmentValue(environment, "PATHEXT", "win32") ||
      DEFAULT_WINDOWS_PATH_EXTENSIONS.join(";")
  );
  const extensions = configured
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => /^\.[A-Za-z0-9]+$/u.test(extension));
  return extensions.length > 0 ? extensions : DEFAULT_WINDOWS_PATH_EXTENSIONS;
}

function candidateNames(command, platform, environment, pathImpl) {
  if (platform !== "win32" || pathImpl.extname(command)) {
    return [command];
  }
  return windowsPathExtensions(environment).map(
    (extension) => `${command}${extension.toLowerCase()}`
  );
}

function stripPathQuotes(value) {
  const trimmed = String(value || "").trim();
  return /^"[^"\r\n]+"$/u.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
}

function pathSearchDirectories(environment, cwd, pathImpl, delimiter, platform) {
  const pathValue = environmentValue(environment, "PATH", platform);
  if (typeof pathValue !== "string") {
    return [];
  }

  const result = [];
  const seen = new Set();
  for (const rawDirectory of pathValue.split(delimiter)) {
    const directory = stripPathQuotes(rawDirectory);
    if (!directory) {
      // Empty PATH entries mean the current directory on several platforms.
      // Do not silently widen executable discovery that way.
      continue;
    }
    const absolute = pathImpl.isAbsolute(directory)
      ? pathImpl.normalize(directory)
      : pathImpl.resolve(cwd, directory);
    const key = platform === "win32" ? absolute.toLowerCase() : absolute;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(absolute);
    }
  }
  return result;
}

function isInsidePath(candidate, root, pathImpl, caseInsensitive) {
  const normalizedCandidate = pathImpl.resolve(candidate);
  const normalizedRoot = pathImpl.resolve(root);
  const candidateForCompare = caseInsensitive
    ? normalizedCandidate.toLowerCase()
    : normalizedCandidate;
  const rootForCompare = caseInsensitive ? normalizedRoot.toLowerCase() : normalizedRoot;
  const relative = pathImpl.relative(rootForCompare, candidateForCompare);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${pathImpl.sep}`) &&
      !pathImpl.isAbsolute(relative))
  );
}

async function normalizeWorkspaceRoots(roots, options) {
  const { cwd, fsImpl, pathImpl, platform, signal } = options;
  const normalized = [];

  for (const root of roots || []) {
    throwIfAborted(signal);
    if (typeof root !== "string" || !root.trim()) {
      continue;
    }
    const lexical = pathImpl.isAbsolute(root)
      ? pathImpl.normalize(root)
      : pathImpl.resolve(cwd, root);
    let real = lexical;
    try {
      real = await fsImpl.realpath(lexical);
      throwIfAborted(signal);
    } catch (error) {
      if (error && error.code === "ABORT_ERR") {
        throw error;
      }
      if (!error || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
        throw resolverError(
          "WORKSPACE_ROOT_UNREADABLE",
          "A workspace root could not be resolved safely."
        );
      }
    }
    normalized.push({ lexical, real, caseInsensitive: platform === "win32" });
  }

  return normalized;
}

async function normalizeProtectedDirectories(directories, options) {
  const { cwd, fsImpl, pathImpl, platform, signal } = options;
  const normalized = [];
  for (const directory of directories || []) {
    throwIfAborted(signal);
    if (typeof directory !== "string" || !directory.trim()) {
      continue;
    }
    const lexical = pathImpl.isAbsolute(directory)
      ? pathImpl.normalize(directory)
      : pathImpl.resolve(cwd, directory);
    let real = lexical;
    try {
      real = await fsImpl.realpath(lexical);
      throwIfAborted(signal);
    } catch (error) {
      if (error && error.code === "ABORT_ERR") {
        throw error;
      }
      if (!error || (error.code !== "ENOENT" && error.code !== "ENOTDIR")) {
        throw resolverError(
          "WORKSPACE_ROOT_UNREADABLE",
          "A protected document directory could not be resolved safely."
        );
      }
    }
    normalized.push({ lexical, real, caseInsensitive: platform === "win32" });
  }
  return normalized;
}

function samePath(left, right, pathImpl, caseInsensitive) {
  const normalizedLeft = pathImpl.normalize(left);
  const normalizedRight = pathImpl.normalize(right);
  return caseInsensitive
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function assertOutsideWorkspace(fileInfo, workspaceRoots, pathImpl) {
  for (const root of workspaceRoots) {
    if (
      isInsidePath(fileInfo.requestedPath, root.lexical, pathImpl, root.caseInsensitive) ||
      isInsidePath(fileInfo.realPath, root.real, pathImpl, root.caseInsensitive)
    ) {
      throw resolverError(
        "EXECUTABLE_IN_WORKSPACE",
        "Refusing to execute a program located inside the workspace."
      );
    }
  }
}

function assertOutsideProtectedDirectories(fileInfo, directories, pathImpl) {
  for (const directory of directories) {
    if (
      samePath(
        pathImpl.dirname(fileInfo.requestedPath),
        directory.lexical,
        pathImpl,
        directory.caseInsensitive
      ) ||
      samePath(
        pathImpl.dirname(fileInfo.realPath),
        directory.real,
        pathImpl,
        directory.caseInsensitive
      )
    ) {
      throw resolverError(
        "EXECUTABLE_IN_WORKSPACE",
        "Refusing to execute a program beside the active document."
      );
    }
  }
}

function assertOutsideProtectedLocations(fileInfo, context) {
  assertOutsideWorkspace(fileInfo, context.workspaceRoots, context.pathImpl);
  assertOutsideProtectedDirectories(
    fileInfo,
    context.protectedDirectories,
    context.pathImpl
  );
}

async function inspectRegularFile(candidate, options = {}) {
  const {
    cwd,
    fsImpl,
    pathImpl,
    platform,
    requireExecutable = platform !== "win32",
    signal
  } = options;
  throwIfAborted(signal);
  const requestedPath = pathImpl.isAbsolute(candidate)
    ? pathImpl.normalize(candidate)
    : pathImpl.resolve(cwd, candidate);

  try {
    await fsImpl.lstat(requestedPath);
    throwIfAborted(signal);
  } catch (error) {
    if (error && error.code === "ABORT_ERR") {
      throw error;
    }
    if (error && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw resolverError("EXECUTABLE_NOT_FOUND", "The executable was not found.");
    }
    throw resolverError("EXECUTABLE_UNREADABLE", "The executable could not be inspected.");
  }

  let realPath;
  let stat;
  try {
    realPath = await fsImpl.realpath(requestedPath);
    throwIfAborted(signal);
    stat = await fsImpl.stat(realPath);
    throwIfAborted(signal);
  } catch (error) {
    if (error && error.code === "ABORT_ERR") {
      throw error;
    }
    throw resolverError("EXECUTABLE_UNREADABLE", "The executable could not be inspected.");
  }
  if (!stat.isFile()) {
    throw resolverError("EXECUTABLE_NOT_REGULAR", "The executable is not a regular file.");
  }

  if (requireExecutable) {
    try {
      await fsImpl.access(realPath, fs.constants.X_OK);
      throwIfAborted(signal);
    } catch (error) {
      if (error && error.code === "ABORT_ERR") {
        throw error;
      }
      throw resolverError("EXECUTABLE_NOT_EXECUTABLE", "The file is not executable.");
    }
  }

  const sha256 = await hashRegularFile(realPath, stat, fsImpl, signal);

  return {
    requestedPath,
    realPath,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    sha256
  };
}

function artifactIdentity(fileInfo) {
  return {
    realPath: fileInfo.realPath,
    size: fileInfo.size,
    mtimeMs: fileInfo.mtimeMs,
    sha256: fileInfo.sha256
  };
}

function createIdentity(kind, artifacts) {
  const normalizedArtifacts = Object.fromEntries(
    Object.entries(artifacts).map(([name, value]) => [name, artifactIdentity(value)])
  );
  const key = crypto
    .createHash("sha256")
    .update(JSON.stringify({ kind, artifacts: normalizedArtifacts }), "utf8")
    .digest("hex");
  return { kind, key, artifacts: normalizedArtifacts };
}

function packageDeclaresOfficialCodex(packageJson) {
  if (!packageJson || packageJson.name !== "@openai/codex") {
    return false;
  }
  const bin = packageJson.bin;
  const declared = typeof bin === "string" ? bin : bin && bin.codex;
  return (
    typeof declared === "string" &&
    declared.replace(/\\/gu, "/").replace(/^\.\//u, "") === "bin/codex.js"
  );
}

function looksLikeOfficialNpmCodexShim(contents) {
  const normalized = String(contents || "").replace(/\//gu, "\\");
  return (
    /%(?:dp0%|~dp0)\\node_modules\\@openai\\codex\\bin\\codex\.js(?=["\s])/iu.test(
      normalized
    ) && /%\*/u.test(normalized)
  );
}

async function readSmallUtf8File(
  fileInfo,
  maximumBytes,
  fsImpl,
  errorCode,
  message,
  signal
) {
  throwIfAborted(signal);
  if (fileInfo.size > maximumBytes) {
    throw resolverError(errorCode, message);
  }
  try {
    const contents = await fsImpl.readFile(fileInfo.realPath, "utf8");
    throwIfAborted(signal);
    const sha256 = crypto.createHash("sha256").update(contents, "utf8").digest("hex");
    if (
      Buffer.byteLength(contents, "utf8") !== fileInfo.size ||
      sha256 !== fileInfo.sha256
    ) {
      throw resolverError(
        "EXECUTABLE_CHANGED",
        "The executable changed while it was being inspected."
      );
    }
    return contents;
  } catch (error) {
    if (error && (error.code === "ABORT_ERR" || error.code === "EXECUTABLE_CHANGED")) {
      throw error;
    }
    throw resolverError(errorCode, message);
  }
}

async function resolveNodeForShim(shimDirectory, context) {
  const adjacentNodePath = context.pathImpl.join(shimDirectory, "node.exe");
  try {
    const adjacentNode = await inspectRegularFile(adjacentNodePath, {
      ...context,
      requireExecutable: false
    });
    assertOutsideProtectedLocations(adjacentNode, context);
    const extension = context.pathImpl.extname(adjacentNode.realPath).toLowerCase();
    if (extension !== ".exe" && extension !== ".com") {
      throw resolverError(
        "UNSAFE_NODE_EXECUTABLE",
        "The Node.js program behind the Codex npm shim is not a native executable."
      );
    }
    return adjacentNode;
  } catch (error) {
    if (!error || error.code !== "EXECUTABLE_NOT_FOUND") {
      throw error;
    }
  }

  try {
    const resolution = await resolveExecutable("node.exe", {
      ...context.publicOptions,
      allowNpmCodexShim: false,
      platform: "win32"
    });
    return resolution._entryInfo;
  } catch (error) {
    if (error && error.code === "EXECUTABLE_NOT_FOUND") {
      throw resolverError(
        "NODE_EXECUTABLE_NOT_FOUND",
        "The Node.js executable required by the Codex npm shim was not found."
      );
    }
    throw error;
  }
}

async function resolveOfficialNpmCodexShim(shimInfo, source, context) {
  throwIfAborted(context.signal);
  const shimText = await readSmallUtf8File(
    shimInfo,
    MAX_SHIM_BYTES,
    context.fsImpl,
    "UNSAFE_COMMAND_SHIM",
    "The Windows command shim is not a recognized Codex npm shim.",
    context.signal
  );
  if (!looksLikeOfficialNpmCodexShim(shimText)) {
    throw resolverError(
      "UNSAFE_COMMAND_SHIM",
      "The Windows command shim is not a recognized Codex npm shim."
    );
  }

  const shimDirectory = context.pathImpl.dirname(shimInfo.realPath);
  const packageDirectory = context.pathImpl.join(
    shimDirectory,
    "node_modules",
    "@openai",
    "codex"
  );
  const scriptInfo = await inspectRegularFile(
    context.pathImpl.join(packageDirectory, "bin", "codex.js"),
    { ...context, requireExecutable: false }
  );
  const packageInfo = await inspectRegularFile(
    context.pathImpl.join(packageDirectory, "package.json"),
    { ...context, requireExecutable: false }
  );
  assertOutsideProtectedLocations(scriptInfo, context);
  assertOutsideProtectedLocations(packageInfo, context);
  const realPackageDirectory = context.pathImpl.dirname(packageInfo.realPath);
  if (
    !isInsidePath(
      scriptInfo.realPath,
      realPackageDirectory,
      context.pathImpl,
      context.platform === "win32"
    )
  ) {
    throw resolverError(
      "INVALID_CODEX_PACKAGE",
      "The Codex npm entry point resolves outside its package."
    );
  }

  const packageText = await readSmallUtf8File(
    packageInfo,
    MAX_PACKAGE_JSON_BYTES,
    context.fsImpl,
    "INVALID_CODEX_PACKAGE",
    "The npm package behind the Codex shim is invalid.",
    context.signal
  );
  let packageJson;
  try {
    packageJson = JSON.parse(packageText);
  } catch (_error) {
    throw resolverError(
      "INVALID_CODEX_PACKAGE",
      "The npm package behind the Codex shim is invalid."
    );
  }
  if (!packageDeclaresOfficialCodex(packageJson)) {
    throw resolverError(
      "INVALID_CODEX_PACKAGE",
      "The Windows command shim does not belong to the official Codex npm package."
    );
  }

  const nodeInfo = await resolveNodeForShim(shimDirectory, context);
  assertOutsideProtectedLocations(nodeInfo, context);
  const identity = createIdentity("npm-codex-shim", {
    shim: shimInfo,
    node: nodeInfo,
    script: scriptInfo,
    packageJson: packageInfo
  });

  return {
    command: nodeInfo.realPath,
    argsPrefix: [scriptInfo.realPath],
    entryPath: shimInfo.realPath,
    source,
    identity,
    _entryInfo: shimInfo
  };
}

async function finalizeCandidate(fileInfo, source, context) {
  throwIfAborted(context.signal);
  assertOutsideProtectedLocations(fileInfo, context);
  if (context.platform === "win32") {
    const extension = context.pathImpl.extname(fileInfo.realPath).toLowerCase();
    if (extension === ".bat" || extension === ".ps1") {
      throw resolverError(
        "UNSUPPORTED_WINDOWS_SCRIPT",
        "Refusing to execute a Windows command script through a shell."
      );
    }
    if (extension === ".cmd") {
      if (context.allowNpmCodexShim === false) {
        throw resolverError(
          "UNSAFE_COMMAND_SHIM",
          "Only the official Codex npm command shim is supported."
        );
      }
      return resolveOfficialNpmCodexShim(fileInfo, source, context);
    }
  }

  return {
    command: fileInfo.realPath,
    argsPrefix: [],
    entryPath: fileInfo.realPath,
    source,
    identity: createIdentity("native", { executable: fileInfo }),
    _entryInfo: fileInfo
  };
}

function buildCandidatePaths(command, options) {
  const { cwd, environment, pathDelimiter, pathImpl, platform } = options;
  if (pathImpl.isAbsolute(command)) {
    return candidateNames(command, platform, environment, pathImpl).map((candidate) => ({
      path: candidate,
      source: "absolute"
    }));
  }
  if (/[\\/]/u.test(command)) {
    throw resolverError(
      "INVALID_EXECUTABLE_NAME",
      "The executable must be a name or an absolute path."
    );
  }

  const result = [];
  for (const directory of pathSearchDirectories(
    environment,
    cwd,
    pathImpl,
    pathDelimiter,
    platform
  )) {
    for (const name of candidateNames(command, platform, environment, pathImpl)) {
      result.push({ path: pathImpl.join(directory, name), source: "path" });
    }
  }
  return result;
}

async function resolveExecutable(command, options = {}) {
  throwIfAborted(options.signal);
  if (typeof command !== "string" || !command.trim() || /[\0\r\n]/u.test(command)) {
    throw resolverError("INVALID_EXECUTABLE_NAME", "The executable name is invalid.");
  }

  const platform = options.platform || process.platform;
  const pathImpl = options.pathImpl || path;
  const fsImpl = options.fsImpl || fs.promises;
  const cwd = options.cwd || process.cwd();
  const environment = options.env || process.env;
  const publicOptions = {
    ...options,
    cwd,
    env: environment,
    fsImpl,
    pathImpl,
    platform,
    signal: options.signal
  };
  const context = {
    allowNpmCodexShim: options.allowNpmCodexShim !== false,
    cwd,
    environment,
    fsImpl,
    pathDelimiter: options.pathDelimiter || path.delimiter,
    pathImpl,
    platform,
    publicOptions,
    signal: options.signal,
    workspaceRoots: await normalizeWorkspaceRoots(options.workspaceRoots, {
      cwd,
      fsImpl,
      pathImpl,
      platform,
      signal: options.signal
    }),
    protectedDirectories: await normalizeProtectedDirectories(
      options.protectedDirectories,
      {
        cwd,
        fsImpl,
        pathImpl,
        platform,
        signal: options.signal
      }
    )
  };
  throwIfAborted(options.signal);
  const candidates = buildCandidatePaths(command.trim(), context);
  let unusableError;

  for (const candidate of candidates) {
    throwIfAborted(options.signal);
    let fileInfo;
    try {
      fileInfo = await inspectRegularFile(candidate.path, context);
    } catch (error) {
      if (
        error &&
        (error.code === "EXECUTABLE_NOT_FOUND" ||
          error.code === "EXECUTABLE_NOT_REGULAR" ||
          error.code === "EXECUTABLE_NOT_EXECUTABLE")
      ) {
        unusableError = unusableError || error;
        continue;
      }
      throw error;
    }
    return finalizeCandidate(fileInfo, candidate.source, context);
  }

  if (pathImpl.isAbsolute(command.trim()) && unusableError) {
    throw unusableError;
  }
  throw resolverError("EXECUTABLE_NOT_FOUND", "The executable was not found on PATH.");
}

async function resolveCodexExecutable(options = {}) {
  throwIfAborted(options.signal);
  const command = options.command || "codex";
  try {
    return await resolveExecutable(command, options);
  } catch (error) {
    const mayFallback =
      error &&
      error.code === "EXECUTABLE_NOT_FOUND" &&
      options.allowBundledFallback === true &&
      typeof options.bundledExecutable === "string" &&
      options.bundledExecutable &&
      command.toLowerCase() === "codex";
    if (!mayFallback) {
      throw error;
    }
  }

  throwIfAborted(options.signal);
  const bundled = await resolveExecutable(options.bundledExecutable, options);
  return { ...bundled, source: "bundled" };
}

function publicResolution(resolution) {
  if (!resolution || typeof resolution !== "object") {
    return resolution;
  }
  const { _entryInfo, ...result } = resolution;
  return result;
}

async function resolveExecutablePublic(command, options) {
  return publicResolution(await resolveExecutable(command, options));
}

async function resolveCodexExecutablePublic(options) {
  return publicResolution(await resolveCodexExecutable(options));
}

module.exports = {
  isInsidePath,
  looksLikeOfficialNpmCodexShim,
  packageDeclaresOfficialCodex,
  resolveCodexExecutable: resolveCodexExecutablePublic,
  resolveExecutable: resolveExecutablePublic
};
