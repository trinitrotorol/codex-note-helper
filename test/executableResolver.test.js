"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  resolveCodexExecutable,
  resolveExecutable
} = require("../lib/executableResolver");

async function makeTempDirectory(t) {
  const directory = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "cnh-executable-resolver-")
  );
  t.after(async () => {
    await fs.promises.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function writeExecutable(filePath, contents = "native") {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, contents, "utf8");
  if (process.platform !== "win32") {
    await fs.promises.chmod(filePath, 0o755);
  }
}

function nativeName(name = "codex") {
  return process.platform === "win32" ? `${name}.exe` : name;
}

function resolverEnvironment(binDirectory) {
  return process.platform === "win32"
    ? { PATH: binDirectory, PATHEXT: ".EXE;.CMD;.BAT" }
    : { PATH: binDirectory };
}

test("resolves and fingerprints the PATH executable before a bundled fallback", async (t) => {
  const root = await makeTempDirectory(t);
  const pathBin = path.join(root, "path-bin");
  const bundleBin = path.join(root, "bundle-bin");
  const pathExecutable = path.join(pathBin, nativeName());
  const bundledExecutable = path.join(bundleBin, nativeName());
  await writeExecutable(pathExecutable, "path codex");
  await writeExecutable(bundledExecutable, "bundled codex");

  const resolution = await resolveCodexExecutable({
    command: "codex",
    env: resolverEnvironment(pathBin),
    bundledExecutable,
    allowBundledFallback: true,
    workspaceRoots: []
  });

  assert.equal(resolution.command, await fs.promises.realpath(pathExecutable));
  assert.equal(resolution.entryPath, resolution.command);
  assert.equal(resolution.source, "path");
  assert.deepEqual(resolution.argsPrefix, []);
  assert.equal(resolution.identity.kind, "native");
  assert.equal(resolution.identity.key.length, 64);
  assert.equal(
    resolution.identity.artifacts.executable.size,
    Buffer.byteLength("path codex")
  );
  assert.equal(
    typeof resolution.identity.artifacts.executable.mtimeMs,
    "number"
  );
  assert.match(
    resolution.identity.artifacts.executable.sha256,
    /^[a-f0-9]{64}$/u
  );
  assert.equal(Object.hasOwn(resolution, "_entryInfo"), false);
});

test("uses the bundled executable only when the default PATH command is absent", async (t) => {
  const root = await makeTempDirectory(t);
  const emptyBin = path.join(root, "empty");
  const bundledExecutable = path.join(root, "bundle", nativeName());
  await fs.promises.mkdir(emptyBin, { recursive: true });
  await writeExecutable(bundledExecutable, "bundle");

  const resolution = await resolveCodexExecutable({
    command: "codex",
    env: resolverEnvironment(emptyBin),
    bundledExecutable,
    allowBundledFallback: true
  });

  assert.equal(resolution.source, "bundled");
  assert.equal(resolution.command, await fs.promises.realpath(bundledExecutable));
});

test("refuses an executable whose lexical or real path is inside a workspace", async (t) => {
  const root = await makeTempDirectory(t);
  const workspace = path.join(root, "workspace");
  const executable = path.join(workspace, nativeName());
  await writeExecutable(executable);

  await assert.rejects(
    resolveExecutable(executable, { workspaceRoots: [workspace] }),
    (error) => error && error.code === "EXECUTABLE_IN_WORKSPACE"
  );
});

test("protects only direct standalone-note siblings without blocking user subdirectories", async (t) => {
  const root = await makeTempDirectory(t);
  const noteDirectory = path.join(root, "user-home");
  const siblingExecutable = path.join(noteDirectory, nativeName("sibling"));
  const userBinExecutable = path.join(
    noteDirectory,
    ".local",
    "bin",
    nativeName("installed")
  );
  await writeExecutable(siblingExecutable);
  await writeExecutable(userBinExecutable);

  await assert.rejects(
    resolveExecutable(siblingExecutable, {
      protectedDirectories: [noteDirectory]
    }),
    (error) => error && error.code === "EXECUTABLE_IN_WORKSPACE"
  );

  const resolution = await resolveExecutable(userBinExecutable, {
    protectedDirectories: [noteDirectory]
  });
  assert.equal(
    resolution.command,
    await fs.promises.realpath(userBinExecutable)
  );
});

test(
  "returns a symlink target as the executable identity",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await makeTempDirectory(t);
    const target = path.join(root, "actual-codex");
    const link = path.join(root, "codex-link");
    await writeExecutable(target);
    await fs.promises.symlink(target, link, "file");

    const resolution = await resolveExecutable(link);
    assert.equal(resolution.command, await fs.promises.realpath(target));
    assert.equal(
      resolution.identity.artifacts.executable.realPath,
      await fs.promises.realpath(target)
    );
  }
);

test("converts only an official Windows npm Codex shim to node plus codex.js", async (t) => {
  const root = await makeTempDirectory(t);
  const bin = path.join(root, "npm-bin");
  const shim = path.join(bin, "codex.cmd");
  const node = path.join(bin, "node.exe");
  const packageDirectory = path.join(bin, "node_modules", "@openai", "codex");
  const script = path.join(packageDirectory, "bin", "codex.js");
  const packageJson = path.join(packageDirectory, "package.json");
  await writeExecutable(
    shim,
    '@ECHO off\r\n"%dp0%\\node.exe" "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n'
  );
  await writeExecutable(node, "node");
  await writeExecutable(script, "#!/usr/bin/env node\n");
  await fs.promises.writeFile(
    packageJson,
    JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }),
    "utf8"
  );

  const resolution = await resolveExecutable("codex", {
    platform: "win32",
    env: { PATH: bin, PATHEXT: ".EXE;.CMD;.BAT" },
    pathDelimiter: path.delimiter
  });

  assert.equal(resolution.command, await fs.promises.realpath(node));
  assert.deepEqual(resolution.argsPrefix, [await fs.promises.realpath(script)]);
  assert.equal(resolution.entryPath, await fs.promises.realpath(shim));
  assert.equal(resolution.identity.kind, "npm-codex-shim");
  assert.deepEqual(Object.keys(resolution.identity.artifacts), [
    "shim",
    "node",
    "script",
    "packageJson"
  ]);
  for (const artifact of Object.values(resolution.identity.artifacts)) {
    assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
  }
});

test("rejects batch files and non-Codex command shims without falling back", async (t) => {
  const root = await makeTempDirectory(t);
  const bat = path.join(root, "codex.bat");
  const cmd = path.join(root, "other.cmd");
  const bundled = path.join(root, "bundle", "codex.exe");
  await writeExecutable(bat, "@echo off\r\n");
  await writeExecutable(cmd, "@echo off\r\n");
  await writeExecutable(bundled, "bundle");

  await assert.rejects(
    resolveCodexExecutable({
      command: bat,
      platform: "win32",
      allowBundledFallback: true,
      bundledExecutable: bundled
    }),
    (error) => error && error.code === "UNSUPPORTED_WINDOWS_SCRIPT"
  );
  await assert.rejects(
    resolveExecutable(cmd, { platform: "win32" }),
    (error) => error && error.code === "UNSAFE_COMMAND_SHIM"
  );
});

test("identity changes when the executable size or mtime changes", async (t) => {
  const root = await makeTempDirectory(t);
  const executable = path.join(root, nativeName());
  await writeExecutable(executable, "one");
  const first = await resolveExecutable(executable);

  await writeExecutable(executable, "a different executable body");
  const changedTime = new Date(Date.now() + 2000);
  await fs.promises.utimes(executable, changedTime, changedTime);
  const second = await resolveExecutable(executable);

  assert.notEqual(first.identity.key, second.identity.key);
  assert.notEqual(
    first.identity.artifacts.executable.size,
    second.identity.artifacts.executable.size
  );
});

test("identity changes when content changes with the same size and mtime", async (t) => {
  const root = await makeTempDirectory(t);
  const executable = path.join(root, nativeName());
  const fixedTime = new Date("2024-01-02T03:04:05.000Z");
  await writeExecutable(executable, "one");
  await fs.promises.utimes(executable, fixedTime, fixedTime);
  const first = await resolveExecutable(executable);

  await writeExecutable(executable, "two");
  await fs.promises.utimes(executable, fixedTime, fixedTime);
  const second = await resolveExecutable(executable);

  assert.equal(
    first.identity.artifacts.executable.size,
    second.identity.artifacts.executable.size
  );
  assert.equal(
    first.identity.artifacts.executable.mtimeMs,
    second.identity.artifacts.executable.mtimeMs
  );
  assert.notEqual(
    first.identity.artifacts.executable.sha256,
    second.identity.artifacts.executable.sha256
  );
  assert.notEqual(first.identity.key, second.identity.key);
});

test("rejects an already-aborted executable resolution before filesystem I/O", async () => {
  const controller = new AbortController();
  controller.abort();
  let touchedFilesystem = false;

  await assert.rejects(
    resolveExecutable("codex", {
      signal: controller.signal,
      fsImpl: new Proxy(
        {},
        {
          get() {
            touchedFilesystem = true;
            throw new Error("filesystem should not be touched");
          }
        }
      )
    }),
    (error) => error && error.code === "ABORT_ERR" && error.cancelled === true
  );
  assert.equal(touchedFilesystem, false);
});

test("rejects a file whose stat changes while its contents are hashed", async (t) => {
  const root = await makeTempDirectory(t);
  const executable = path.join(root, nativeName());
  await writeExecutable(executable, "stable-looking executable");
  let handleStatCalls = 0;
  const actual = fs.promises;
  const fsImpl = {
    access: actual.access.bind(actual),
    lstat: actual.lstat.bind(actual),
    realpath: actual.realpath.bind(actual),
    stat: actual.stat.bind(actual),
    async open(...args) {
      const handle = await actual.open(...args);
      return {
        close: handle.close.bind(handle),
        read: handle.read.bind(handle),
        async stat() {
          const stat = await handle.stat();
          handleStatCalls += 1;
          return handleStatCalls === 2
            ? { ...stat, mtimeMs: stat.mtimeMs + 1 }
            : stat;
        }
      };
    }
  };

  await assert.rejects(
    resolveExecutable(executable, { fsImpl }),
    (error) => error && error.code === "EXECUTABLE_CHANGED"
  );
});
