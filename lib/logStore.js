"use strict";

const fs = require("fs");
const path = require("path");

const LOG_DIRECTORY = "logs";
const LOG_FILE_NAME = "failures.log";
const LOG_HEADER = "# Codex Note Helper owned failure log\n";
const DEFAULT_MAX_LOG_BYTES = 512 * 1024;

let operationQueue = Promise.resolve();

function getFailureLogPath(storageDir) {
  if (!path.isAbsolute(storageDir)) {
    throw new TypeError("The extension storage directory must be absolute.");
  }
  return path.join(storageDir, LOG_DIRECTORY, LOG_FILE_NAME);
}

function getFailureLogPaths(storageDir) {
  const filePath = getFailureLogPath(storageDir);
  return [filePath, `${filePath}.1`];
}

async function inspectOwnedFileIfPresent(filePath) {
  try {
    return await assertOwnedRegularFile(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function assertOwnedRegularFile(filePath) {
  const stat = await fs.promises.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Refusing to use a non-regular failure log.");
  }

  const handle = await fs.promises.open(filePath, "r");
  try {
    const buffer = Buffer.alloc(Buffer.byteLength(LOG_HEADER));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (buffer.subarray(0, bytesRead).toString("utf8") !== LOG_HEADER) {
      throw new Error("Refusing to use a failure log not owned by this extension.");
    }
  } finally {
    await handle.close();
  }

  return stat;
}

async function createOwnedLog(filePath) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.promises.open(filePath, "wx", 0o600);
  try {
    await handle.writeFile(LOG_HEADER, "utf8");
  } finally {
    await handle.close();
  }
}

async function ensureOwnedLog(filePath) {
  try {
    return await assertOwnedRegularFile(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      try {
        await createOwnedLog(filePath);
      } catch (createError) {
        if (!createError || createError.code !== "EEXIST") {
          throw createError;
        }
      }
      return assertOwnedRegularFile(filePath);
    }
    throw error;
  }
}

async function rotateIfNeeded(filePath, incomingBytes, maxBytes) {
  const stat = await ensureOwnedLog(filePath);
  if (stat.size + incomingBytes <= maxBytes) {
    return;
  }

  const rotatedPath = `${filePath}.1`;
  try {
    await assertOwnedRegularFile(rotatedPath);
    await fs.promises.unlink(rotatedPath);
  } catch (error) {
    if (!error || error.code !== "ENOENT") {
      throw error;
    }
  }

  await fs.promises.rename(filePath, rotatedPath);
  await createOwnedLog(filePath);
}

function enqueue(operation) {
  const next = operationQueue.then(operation, operation);
  operationQueue = next.catch(() => undefined);
  return next;
}

function appendFailureLog(storageDir, entry, options = {}) {
  const filePath = getFailureLogPath(storageDir);
  const maxBytes = options.maxBytes || DEFAULT_MAX_LOG_BYTES;
  const normalizedEntry = `${String(entry || "").trimEnd()}\n`;
  const incomingBytes = Buffer.byteLength(normalizedEntry, "utf8");

  return enqueue(async () => {
    await rotateIfNeeded(filePath, incomingBytes, maxBytes);
    await fs.promises.appendFile(filePath, normalizedEntry, {
      encoding: "utf8",
      mode: 0o600,
      flag: "a"
    });
    return filePath;
  });
}

function deleteFailureLog(storageDir) {
  const filePaths = getFailureLogPaths(storageDir);
  return enqueue(async () => {
    const existing = [];
    for (const filePath of filePaths) {
      if (await inspectOwnedFileIfPresent(filePath)) {
        existing.push(filePath);
      }
    }
    for (const filePath of existing) {
      await fs.promises.unlink(filePath);
    }
    return existing;
  });
}

async function getFailureLogInfo(storageDir) {
  const filePaths = getFailureLogPaths(storageDir);
  const files = [];
  for (const filePath of filePaths) {
    const stat = await inspectOwnedFileIfPresent(filePath);
    if (stat) {
      files.push({ filePath, size: stat.size, modifiedAt: stat.mtime });
    }
  }
  return {
    exists: files.length > 0,
    filePath: filePaths[0],
    files,
    size: files.reduce((total, file) => total + file.size, 0),
    modifiedAt: files.reduce(
      (latest, file) => (!latest || file.modifiedAt > latest ? file.modifiedAt : latest),
      undefined
    )
  };
}

module.exports = {
  DEFAULT_MAX_LOG_BYTES,
  LOG_HEADER,
  appendFailureLog,
  assertOwnedRegularFile,
  deleteFailureLog,
  getFailureLogInfo,
  getFailureLogPath
};
