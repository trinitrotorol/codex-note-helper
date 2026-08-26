const path = require("node:path");
const { spawn } = require("node:child_process");
const { StringDecoder } = require("node:string_decoder");
const { createLineCollector, parseJsonLine } = require("./codexProgress");

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_MAX_LINE_BYTES = 64 * 1024;
const DEFAULT_CLOSE_WAIT_MS = 5_000;
const DEFAULT_TERMINATION_GRACE_MS = 750;
const DEFAULT_TASKKILL_WAIT_MS = 5_000;

const SAFE_ENVIRONMENT_KEYS = new Set([
  "ALL_PROXY",
  "APPDATA",
  "CODEX_API_KEY",
  "CODEX_HOME",
  "COMSPEC",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOCALAPPDATA",
  "NODE_EXTRA_CA_CERTS",
  "NO_COLOR",
  "NO_PROXY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT",
  "PATH",
  "PATHEXT",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR"
]);

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function sanitizeEnvironment(source = {}, options = {}) {
  const allowed = new Set(SAFE_ENVIRONMENT_KEYS);
  for (const key of options.allowKeys || []) {
    allowed.add(String(key).toUpperCase());
  }

  const sanitized = {};
  for (const [key, value] of Object.entries(source || {})) {
    if (
      value !== undefined &&
      value !== null &&
      allowed.has(key.toUpperCase())
    ) {
      sanitized[key] = String(value);
    }
  }

  for (const [key, value] of Object.entries(options.overrides || {})) {
    if (value === undefined || value === null) {
      delete sanitized[key];
    } else {
      // Overrides are an explicit caller decision and do not inherit implicitly.
      sanitized[key] = String(value);
    }
  }

  return sanitized;
}

function decodeUtf8Ring(buffer) {
  let start = 0;
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
    start += 1;
  }
  const decoder = new StringDecoder("utf8");
  return decoder.write(buffer.subarray(start));
}

class ByteRingBuffer {
  constructor(maxBytes = DEFAULT_MAX_OUTPUT_BYTES) {
    this.maxBytes = positiveInteger(maxBytes, DEFAULT_MAX_OUTPUT_BYTES);
    this.chunks = [];
    this.bytes = 0;
    this.totalBytes = 0;
    this.truncated = false;
  }

  push(value) {
    const chunk = Buffer.isBuffer(value)
      ? value
      : ArrayBuffer.isView(value)
        ? Buffer.from(value.buffer, value.byteOffset, value.byteLength)
        : Buffer.from(String(value || ""), "utf8");
    if (chunk.length === 0) {
      return;
    }

    this.totalBytes += chunk.length;
    if (chunk.length >= this.maxBytes) {
      this.chunks = [Buffer.from(chunk.subarray(chunk.length - this.maxBytes))];
      this.bytes = this.maxBytes;
      this.truncated = this.totalBytes > this.maxBytes;
      return;
    }

    this.chunks.push(Buffer.from(chunk));
    this.bytes += chunk.length;
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const excess = this.bytes - this.maxBytes;
      const first = this.chunks[0];
      if (first.length <= excess) {
        this.chunks.shift();
        this.bytes -= first.length;
      } else {
        this.chunks[0] = Buffer.from(first.subarray(excess));
        this.bytes -= excess;
      }
    }
    this.truncated = this.totalBytes > this.maxBytes;
  }

  toString() {
    return decodeUtf8Ring(Buffer.concat(this.chunks, this.bytes));
  }
}

function isChildClosed(child) {
  return child.exitCode !== null && child.exitCode !== undefined
    ? true
    : child.signalCode !== null && child.signalCode !== undefined;
}

function waitForClose(child, timeoutMs, timerApi = {}) {
  if (isChildClosed(child)) {
    return Promise.resolve(true);
  }

  const setTimer = timerApi.setTimeoutImpl || setTimeout;
  const clearTimer = timerApi.clearTimeoutImpl || clearTimeout;
  return new Promise((resolve) => {
    let timer;
    const onClose = () => {
      clearTimer(timer);
      resolve(true);
    };
    child.once("close", onClose);
    timer = setTimer(() => {
      child.removeListener("close", onClose);
      resolve(false);
    }, timeoutMs);
    if (timer && typeof timer.unref === "function") {
      timer.unref();
    }
  });
}

async function terminateProcessTree(child, options = {}) {
  if (!child || !Number.isInteger(child.pid) || child.pid <= 0 || isChildClosed(child)) {
    return;
  }

  const platform = options.platform || process.platform;
  const graceMs = positiveInteger(
    options.graceMs,
    DEFAULT_TERMINATION_GRACE_MS
  );

  if (platform === "win32") {
    const spawnImpl = options.spawnImpl || spawn;
    const systemRoot = options.systemRoot || process.env.SystemRoot || "C:\\Windows";
    const taskkillPath = path.join(systemRoot, "System32", "taskkill.exe");
    const taskkillWaitMs = positiveInteger(
      options.taskkillWaitMs,
      DEFAULT_TASKKILL_WAIT_MS
    );
    const setTimer = options.setTimeoutImpl || setTimeout;
    const clearTimer = options.clearTimeoutImpl || clearTimeout;

    await new Promise((resolve) => {
      let helper;
      try {
        helper = spawnImpl(
          taskkillPath,
          ["/PID", String(child.pid), "/T", "/F"],
          {
            shell: false,
            windowsHide: true,
            stdio: "ignore"
          }
        );
      } catch (_error) {
        try {
          child.kill();
        } catch (_killError) {
          // The process may already have exited.
        }
        resolve();
        return;
      }

      let settled = false;
      let timeoutTimer;
      const fallbackKill = () => {
        try {
          child.kill();
        } catch (_killError) {
          // The process may already have exited.
        }
      };
      const detachHelperListeners = () => {
        helper.removeListener("error", onHelperError);
        helper.removeListener("close", onHelperClose);
      };
      const finish = () => {
        if (!settled) {
          settled = true;
          clearTimer(timeoutTimer);
          detachHelperListeners();
          resolve();
        }
      };
      const onHelperError = () => {
        fallbackKill();
        finish();
      };
      const onHelperClose = (code) => {
        if (settled) {
          return;
        }
        if (code !== 0) {
          fallbackKill();
        }
        finish();
      };
      helper.once("error", onHelperError);
      helper.once("close", onHelperClose);
      timeoutTimer = setTimer(() => {
        if (settled) {
          return;
        }
        fallbackKill();
        // Once the bounded wait expires, retain only a harmless error sink so a
        // late ChildProcess error cannot become an uncaught EventEmitter error.
        detachHelperListeners();
        helper.once("error", () => {});
        try {
          helper.kill();
        } catch (_killError) {
          // The taskkill helper may already have exited.
        }
        if (typeof helper.unref === "function") {
          helper.unref();
        }
        finish();
      }, taskkillWaitMs);
      if (timeoutTimer && typeof timeoutTimer.unref === "function") {
        timeoutTimer.unref();
      }
      if (settled) {
        clearTimer(timeoutTimer);
      }
    });
    return;
  }

  const processKillImpl = options.processKillImpl || process.kill.bind(process);
  let usedGroupSignal = false;
  try {
    processKillImpl(-child.pid, "SIGTERM");
    usedGroupSignal = true;
  } catch (_error) {
    try {
      child.kill("SIGTERM");
    } catch (_killError) {
      return;
    }
  }

  const closed = await waitForClose(child, graceMs, options);
  if (closed) {
    return;
  }

  try {
    if (usedGroupSignal) {
      processKillImpl(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch (_error) {
    try {
      child.kill("SIGKILL");
    } catch (_killError) {
      // The process may already have exited.
    }
  }
}

function makeProcessError(kind, result, originalError) {
  const messages = {
    abort: "Codex run was cancelled.",
    callback: "Codex progress handling failed.",
    closeTimeout: "Codex did not close after termination.",
    exit: `Codex exited with code ${result.code}.`,
    outputLimit: "Codex output exceeded the configured limit.",
    spawn: "Codex could not be started.",
    stderr: "Codex stderr could not be read.",
    stdin: "Codex input could not be written.",
    stdout: "Codex stdout could not be read.",
    timeout: "Codex run timed out."
  };
  const error = new Error(messages[kind] || "Codex process failed.");
  error.name = kind === "abort" ? "AbortError" : "ProcessRunError";
  error.code =
    kind === "abort"
      ? "ABORT_ERR"
      : kind === "timeout"
        ? "ETIMEDOUT"
        : kind === "outputLimit"
          ? "OUTPUT_LIMIT"
        : kind === "exit"
          ? "CODEX_EXIT"
          : (kind === "spawn" || kind === "callback") &&
              originalError &&
              originalError.code
            ? originalError.code
            : "CODEX_PROCESS_ERROR";
  error.cancelled = kind === "abort";
  error.timedOut = kind === "timeout";
  error.codex = result;
  return error;
}

function runProcess(options = {}) {
  const {
    command,
    args = [],
    cwd,
    input = "",
    signal,
    onEvent
  } = options;

  if (typeof command !== "string" || !command.trim()) {
    return Promise.reject(new TypeError("command must be a non-empty string."));
  }
  if (!Array.isArray(args)) {
    return Promise.reject(new TypeError("args must be an array."));
  }

  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes,
    DEFAULT_MAX_OUTPUT_BYTES
  );
  const maxLineBytes = positiveInteger(
    options.maxLineBytes,
    DEFAULT_MAX_LINE_BYTES
  );
  const timeoutMs = positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  const closeWaitMs = positiveInteger(
    options.closeWaitMs,
    DEFAULT_CLOSE_WAIT_MS
  );
  const platform = options.platform || process.platform;
  const spawnImpl = options.spawnImpl || spawn;
  const killTreeImpl = options.killTreeImpl || terminateProcessTree;
  const setTimer = options.setTimeoutImpl || setTimeout;
  const clearTimer = options.clearTimeoutImpl || clearTimeout;

  if (signal && signal.aborted) {
    const result = {
      command,
      args: [...args],
      code: null,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false
    };
    return Promise.reject(makeProcessError("abort", result));
  }

  return new Promise((resolve, reject) => {
    const stdout = new ByteRingBuffer(maxOutputBytes);
    const stderr = new ByteRingBuffer(maxOutputBytes);
    let child;
    let settled = false;
    let closed = false;
    let closeCode = null;
    let closeSignal = null;
    let stopKind;
    let stopError;
    let terminationPending = false;
    let timeoutTimer;
    let closeWaitTimer;
    let linesFlushed = false;

    const result = () => ({
      command,
      args: [...args],
      code: closeCode,
      signal: closeSignal,
      stdout: stdout.toString(),
      stderr: stderr.toString(),
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated
    });

    const stdoutLines = createLineCollector(
      (line, metadata) => {
        if (metadata.truncated) {
          if (typeof onEvent === "function") {
            const error = new Error("Codex emitted an oversized event line.");
            error.code = "CODEX_POLICY_VIOLATION";
            requestStop("callback", error);
          }
          return;
        }
        const event = parseJsonLine(line, maxLineBytes);
        if (!event || typeof onEvent !== "function") {
          return;
        }
        try {
          onEvent(event);
        } catch (error) {
          requestStop("callback", error);
        }
      },
      { maxLineBytes }
    );

    function flushLines() {
      if (!linesFlushed) {
        linesFlushed = true;
        stdoutLines.flush();
      }
    }

    function cleanup() {
      clearTimer(timeoutTimer);
      clearTimer(closeWaitTimer);
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    }

    function finishIfReady() {
      if (settled || !closed || terminationPending) {
        return;
      }
      flushLines();
      settled = true;
      cleanup();
      const finalResult = result();

      if (stopKind) {
        reject(makeProcessError(stopKind, finalResult, stopError));
      } else if (closeCode !== 0) {
        reject(makeProcessError("exit", finalResult));
      } else {
        resolve(finalResult);
      }
    }

    function beginCloseWait() {
      if (closeWaitTimer || closed) {
        return;
      }
      closeWaitTimer = setTimer(() => {
        if (closed || settled) {
          return;
        }
        stopKind = stopKind || "closeTimeout";
        closed = true;
        closeCode = null;
        closeSignal = null;
        terminationPending = false;
        finishIfReady();
      }, closeWaitMs);
      if (closeWaitTimer && typeof closeWaitTimer.unref === "function") {
        closeWaitTimer.unref();
      }
    }

    function requestStop(kind, error) {
      if (settled) {
        return;
      }
      if (!stopKind) {
        stopKind = kind;
        stopError = error;
      }
      if (terminationPending || closed) {
        return;
      }

      terminationPending = true;
      beginCloseWait();
      Promise.resolve(
        killTreeImpl(child, {
          platform,
          graceMs: options.terminationGraceMs,
          taskkillWaitMs: closeWaitMs,
          setTimeoutImpl: setTimer,
          clearTimeoutImpl: clearTimer
        })
      )
        .catch((terminationError) => {
          stopError = stopError || terminationError;
          try {
            child.kill();
          } catch (_killError) {
            // The bounded close wait below still guarantees settlement.
          }
        })
        .finally(() => {
          terminationPending = false;
          finishIfReady();
        });
    }

    function onAbort() {
      requestStop("abort");
    }

    const childEnvironment = sanitizeEnvironment(
      options.env || process.env,
      {
        allowKeys: options.allowEnvKeys,
        overrides: options.envOverrides
      }
    );

    try {
      child = spawnImpl(command, args, {
        cwd,
        detached: platform !== "win32",
        env: childEnvironment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      const spawnResult = result();
      reject(makeProcessError("spawn", spawnResult, error));
      return;
    }

    child.stdout.on("data", (chunk) => {
      stdout.push(chunk);
      if (stdout.totalBytes + stderr.totalBytes > maxOutputBytes) {
        requestStop("outputLimit");
        return;
      }
      stdoutLines.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr.push(chunk);
      if (stdout.totalBytes + stderr.totalBytes > maxOutputBytes) {
        requestStop("outputLimit");
      }
    });
    child.stdout.once("error", (error) => {
      requestStop("stdout", error);
    });
    child.stderr.once("error", (error) => {
      requestStop("stderr", error);
    });
    child.stdin.once("error", (error) => {
      requestStop("stdin", error);
    });
    child.once("error", (error) => {
      requestStop("spawn", error);
    });
    child.once("close", (code, childSignal) => {
      closed = true;
      closeCode = code;
      closeSignal = childSignal || null;
      clearTimer(closeWaitTimer);
      // Process closure is authoritative. A taskkill/termination helper may hang
      // independently, so treat it as best effort once the child is gone.
      terminationPending = false;
      finishIfReady();
    });

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    }

    timeoutTimer = setTimer(() => {
      requestStop("timeout");
    }, timeoutMs);
    if (timeoutTimer && typeof timeoutTimer.unref === "function") {
      timeoutTimer.unref();
    }

    try {
      child.stdin.end(input);
    } catch (error) {
      requestStop("stdin", error);
    }
  });
}

module.exports = {
  ByteRingBuffer,
  runProcess,
  sanitizeEnvironment,
  terminateProcessTree
};
