const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const {
  ByteRingBuffer,
  runProcess,
  sanitizeEnvironment,
  terminateProcessTree
} = require("../lib/processRunner");

function createFakeChild(pid = 4321) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    return true;
  };
  return child;
}

function closeChild(child, code, signal = null) {
  child.exitCode = code;
  child.signalCode = signal;
  child.emit("close", code, signal);
}

test("sanitizeEnvironment keeps Codex essentials and drops unrelated secrets", () => {
  const sanitized = sanitizeEnvironment(
    {
      Path: "C:/bin",
      CODEX_HOME: "C:/codex",
      OPENAI_API_KEY: "needed-by-codex",
      TEMP: "C:/temp",
      NODE_OPTIONS: "--require C:/evil.js",
      AWS_SECRET_ACCESS_KEY: "private",
      GITHUB_TOKEN: "private"
    },
    {
      overrides: { RUN_MARKER: "explicit", TEMP: null }
    }
  );

  assert.deepEqual(sanitized, {
    Path: "C:/bin",
    CODEX_HOME: "C:/codex",
    OPENAI_API_KEY: "needed-by-codex",
    RUN_MARKER: "explicit"
  });
});

test("ByteRingBuffer retains bounded recent UTF-8 without replacement characters", () => {
  const ring = new ByteRingBuffer(5);
  ring.push("prefix");
  ring.push(Buffer.from("あい", "utf8"));

  assert.equal(ring.truncated, true);
  assert.equal(ring.bytes, 5);
  assert.equal(ring.toString(), "い");
  assert.equal(ring.toString().includes("\ufffd"), false);
});

test("runProcess uses safe spawn options, emits parsed events, and bounds output", async () => {
  const child = createFakeChild();
  let spawnCall;
  const events = [];
  const promise = runProcess({
    command: "codex",
    args: ["exec", "--json", "-"],
    cwd: "C:/workspace",
    input: "private prompt",
    env: {
      Path: "C:/bin",
      CODEX_HOME: "C:/codex",
      SECRET_TOKEN: "must-not-inherit"
    },
    maxOutputBytes: 80,
    timeoutMs: 10_000,
    platform: "win32",
    spawnImpl(command, args, options) {
      spawnCall = { command, args, options };
      return child;
    },
    onEvent(event) {
      events.push(event);
    }
  });

  const eventLine = JSON.stringify({
    type: "item.started",
    item: { type: "reasoning" }
  });
  child.stdout.write(Buffer.from(eventLine.slice(0, 10), "utf8"));
  child.stdout.write(Buffer.from(eventLine.slice(10) + "\n", "utf8"));
  child.stderr.write("0123456789");
  closeChild(child, 0);

  const result = await promise;
  assert.equal(spawnCall.command, "codex");
  assert.deepEqual(spawnCall.args, ["exec", "--json", "-"]);
  assert.equal(spawnCall.options.shell, false);
  assert.equal(spawnCall.options.detached, false);
  assert.equal(spawnCall.options.env.SECRET_TOKEN, undefined);
  assert.equal(spawnCall.options.env.CODEX_HOME, "C:/codex");
  assert.deepEqual(events, [
    { type: "item.started", item: { type: "reasoning" } }
  ]);
  assert.match(result.stdout, /item\.started/);
  assert.equal(result.stderr, "0123456789");
  assert.equal(result.code, 0);
});

test("runProcess rejects nonzero exits with sanitized Codex diagnostics", async () => {
  const child = createFakeChild();
  const promise = runProcess({
    command: "codex",
    args: ["exec"],
    input: "prompt",
    maxOutputBytes: 100,
    timeoutMs: 10_000,
    spawnImpl: () => child
  });

  child.stdout.write("abcdefghij");
  child.stderr.write("0123456789");
  closeChild(child, 7);

  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "CODEX_EXIT");
    assert.equal(error.codex.code, 7);
    assert.equal(error.codex.stdout, "abcdefghij");
    assert.equal(error.codex.stderr, "0123456789");
    assert.equal(error.codex.stdoutTruncated, false);
    assert.equal(error.codex.stderrTruncated, false);
    return true;
  });
});

test("runProcess enforces event callbacks on a final line without newline", async () => {
  const child = createFakeChild();
  const promise = runProcess({
    command: "codex",
    args: ["exec", "--json"],
    timeoutMs: 10_000,
    spawnImpl: () => child,
    onEvent() {
      const error = new Error("policy details must not leak");
      error.code = "CODEX_POLICY_VIOLATION";
      throw error;
    }
  });

  child.stdout.write('{"type":"item.started","item":{"type":"file_change"}}');
  closeChild(child, 0);

  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "CODEX_POLICY_VIOLATION");
    assert.equal(error.message, "Codex progress handling failed.");
    assert.equal(error.message.includes("policy details"), false);
    return true;
  });
});

test("runProcess fails closed when a JSONL event exceeds the line limit", async () => {
  const child = createFakeChild();
  const promise = runProcess({
    command: "codex",
    args: ["exec", "--json"],
    maxLineBytes: 32,
    timeoutMs: 10_000,
    spawnImpl: () => child,
    onEvent() {},
    killTreeImpl(target) {
      closeChild(target, null, "SIGTERM");
    }
  });

  child.stdout.write(
    `${JSON.stringify({ type: "item.started", item: { type: "command_execution", value: "x".repeat(100) } })}\n`
  );

  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "CODEX_POLICY_VIOLATION");
    return true;
  });
});

test("runProcess handles asynchronous child spawn errors", async () => {
  const child = createFakeChild();
  const promise = runProcess({
    command: "missing-codex",
    args: [],
    timeoutMs: 10_000,
    spawnImpl: () => child,
    killTreeImpl(target) {
      closeChild(target, null, "SIGTERM");
    }
  });

  child.emit("error", Object.assign(new Error("private path"), { code: "ENOENT" }));
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "ENOENT");
    assert.equal(error.message, "Codex could not be started.");
    return true;
  });
});

test("runProcess terminates and rejects output beyond the shared byte limit", async () => {
  const child = createFakeChild();
  let killCalls = 0;
  const promise = runProcess({
    command: "codex",
    args: ["exec"],
    maxOutputBytes: 10,
    timeoutMs: 10_000,
    spawnImpl: () => child,
    killTreeImpl(target) {
      killCalls += 1;
      closeChild(target, null, "SIGTERM");
    }
  });

  child.stdout.write("123456");
  child.stderr.write("78901");

  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "OUTPUT_LIMIT");
    assert.equal(error.codex.signal, "SIGTERM");
    return true;
  });
  assert.equal(killCalls, 1);
});

test("runProcess aborts the process tree and waits for close before rejecting", async () => {
  const child = createFakeChild();
  const controller = new AbortController();
  let killCalls = 0;
  let closedBeforeKillReturned = false;
  const promise = runProcess({
    command: "codex",
    args: ["exec"],
    signal: controller.signal,
    timeoutMs: 10_000,
    spawnImpl: () => child,
    async killTreeImpl(target) {
      killCalls += 1;
      await Promise.resolve();
      closeChild(target, null, "SIGTERM");
      closedBeforeKillReturned = true;
    }
  });

  controller.abort();

  await assert.rejects(promise, (error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.code, "ABORT_ERR");
    assert.equal(error.cancelled, true);
    assert.equal(error.codex.signal, "SIGTERM");
    assert.equal(closedBeforeKillReturned, true);
    return true;
  });
  assert.equal(killCalls, 1);
});

test("runProcess settles on child close even when the kill helper never settles", async () => {
  const child = createFakeChild();
  const controller = new AbortController();
  let killCalls = 0;
  const promise = runProcess({
    command: "codex",
    args: ["exec"],
    signal: controller.signal,
    timeoutMs: 10_000,
    spawnImpl: () => child,
    killTreeImpl() {
      killCalls += 1;
      return new Promise(() => {});
    }
  });

  controller.abort();
  closeChild(child, null, "SIGTERM");

  await assert.rejects(promise, (error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.code, "ABORT_ERR");
    assert.equal(error.codex.signal, "SIGTERM");
    return true;
  });
  assert.equal(killCalls, 1);
});

test("runProcess observes cancellation that occurs during process creation", async () => {
  const child = createFakeChild();
  const controller = new AbortController();
  const promise = runProcess({
    command: "codex",
    args: ["exec"],
    signal: controller.signal,
    timeoutMs: 10_000,
    spawnImpl() {
      controller.abort();
      return child;
    },
    killTreeImpl(target) {
      closeChild(target, null, "SIGTERM");
    }
  });

  await assert.rejects(promise, (error) => error.code === "ABORT_ERR");
});

test("runProcess times out, terminates the tree, and reports ETIMEDOUT", async () => {
  const child = createFakeChild();
  let timeoutCallback;
  let killCalls = 0;
  const timerHandles = new Set();
  const setTimeoutImpl = (callback, milliseconds) => {
    const handle = {
      callback,
      milliseconds,
      unref() {}
    };
    timerHandles.add(handle);
    if (milliseconds === 25) {
      timeoutCallback = callback;
    }
    return handle;
  };
  const clearTimeoutImpl = (handle) => timerHandles.delete(handle);

  const promise = runProcess({
    command: "codex",
    args: ["exec"],
    timeoutMs: 25,
    closeWaitMs: 100,
    spawnImpl: () => child,
    setTimeoutImpl,
    clearTimeoutImpl,
    killTreeImpl(target) {
      killCalls += 1;
      closeChild(target, null, "SIGKILL");
    }
  });

  timeoutCallback();

  await assert.rejects(promise, (error) => {
    assert.equal(error.code, "ETIMEDOUT");
    assert.equal(error.timedOut, true);
    assert.equal(error.codex.signal, "SIGKILL");
    return true;
  });
  assert.equal(killCalls, 1);
});

test("runProcess handles stdin errors and still waits for process close", async () => {
  const child = createFakeChild();
  let killCalls = 0;
  child.stdin.end = () => {
    child.stdin.emit("error", Object.assign(new Error("private"), { code: "EPIPE" }));
  };

  const promise = runProcess({
    command: "codex",
    args: ["exec"],
    input: "prompt",
    timeoutMs: 10_000,
    spawnImpl: () => child,
    killTreeImpl(target) {
      killCalls += 1;
      closeChild(target, null, "SIGTERM");
    }
  });

  await assert.rejects(promise, (error) => {
    assert.equal(error.message, "Codex input could not be written.");
    assert.equal(error.codex.signal, "SIGTERM");
    return true;
  });
  assert.equal(killCalls, 1);
});

for (const streamName of ["stdout", "stderr"]) {
  test(`runProcess handles ${streamName} stream errors`, async () => {
    const child = createFakeChild();
    let killCalls = 0;
    const promise = runProcess({
      command: "codex",
      args: ["exec"],
      timeoutMs: 10_000,
      spawnImpl: () => child,
      killTreeImpl(target) {
        killCalls += 1;
        closeChild(target, null, "SIGTERM");
      }
    });

    child[streamName].emit("error", new Error("private stream failure"));
    await assert.rejects(promise, (error) => {
      assert.equal(error.code, "CODEX_PROCESS_ERROR");
      assert.equal(error.message.includes("private"), false);
      return true;
    });
    assert.equal(killCalls, 1);
  });
}

test("terminateProcessTree signals a detached Unix process group", async () => {
  const child = createFakeChild(99);
  const signals = [];

  await terminateProcessTree(child, {
    platform: "linux",
    graceMs: 100,
    processKillImpl(pid, signal) {
      signals.push([pid, signal]);
      queueMicrotask(() => closeChild(child, null, "SIGTERM"));
    }
  });

  assert.deepEqual(signals, [[-99, "SIGTERM"]]);
  assert.deepEqual(child.killCalls, []);
});

test("terminateProcessTree invokes taskkill safely on Windows", async () => {
  const child = createFakeChild(123);
  const helper = new EventEmitter();
  let taskkillCall;

  const promise = terminateProcessTree(child, {
    platform: "win32",
    systemRoot: "C:\\Windows",
    spawnImpl(command, args, options) {
      taskkillCall = { command, args, options };
      return helper;
    }
  });
  queueMicrotask(() => helper.emit("close", 0));
  await promise;

  assert.equal(taskkillCall.command, "C:\\Windows\\System32\\taskkill.exe");
  assert.deepEqual(taskkillCall.args, ["/PID", "123", "/T", "/F"]);
  assert.equal(taskkillCall.options.shell, false);
  assert.equal(taskkillCall.options.windowsHide, true);
  assert.deepEqual(child.killCalls, []);
});

test("terminateProcessTree falls back when taskkill exits unsuccessfully", async () => {
  const child = createFakeChild(456);
  const helper = new EventEmitter();

  const promise = terminateProcessTree(child, {
    platform: "win32",
    systemRoot: "C:\\Windows",
    spawnImpl() {
      return helper;
    }
  });
  queueMicrotask(() => helper.emit("close", 1));
  await promise;

  assert.deepEqual(child.killCalls, [undefined]);
});

test("terminateProcessTree bounds and detaches a hung taskkill helper", async () => {
  const child = createFakeChild(789);
  const helper = new EventEmitter();
  helper.killCalls = [];
  helper.kill = (signal) => {
    helper.killCalls.push(signal);
    return true;
  };
  let unrefCalls = 0;
  helper.unref = () => {
    unrefCalls += 1;
  };
  let timeoutCallback;
  let clearedTimer;
  const timer = { unrefCalls: 0, unref() { this.unrefCalls += 1; } };

  const promise = terminateProcessTree(child, {
    platform: "win32",
    systemRoot: "C:\\Windows",
    taskkillWaitMs: 25,
    spawnImpl() {
      return helper;
    },
    setTimeoutImpl(callback, delay) {
      assert.equal(delay, 25);
      timeoutCallback = callback;
      return timer;
    },
    clearTimeoutImpl(value) {
      clearedTimer = value;
    }
  });

  assert.equal(typeof timeoutCallback, "function");
  assert.equal(timer.unrefCalls, 1);
  timeoutCallback();
  await promise;

  assert.deepEqual(child.killCalls, [undefined]);
  assert.deepEqual(helper.killCalls, [undefined]);
  assert.equal(unrefCalls, 1);
  assert.equal(clearedTimer, timer);
  assert.equal(helper.listenerCount("close"), 0);
  assert.equal(helper.listenerCount("error"), 1);

  helper.emit("close", 1);
  assert.deepEqual(child.killCalls, [undefined]);
});
