"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  LOG_HEADER,
  appendFailureLog,
  deleteFailureLog,
  getFailureLogInfo,
  getFailureLogPath
} = require("../lib/logStore");

async function withTempDir(callback) {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "cnh-log-"));
  try {
    await callback(tempDir);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

test("failure logs live at a fixed extension-owned path", async () => {
  await withTempDir(async (tempDir) => {
    const logPath = await appendFailureLog(tempDir, "entry");
    assert.equal(logPath, getFailureLogPath(tempDir));
    const text = await fs.promises.readFile(logPath, "utf8");
    assert.equal(text, `${LOG_HEADER}entry\n`);
  });
});

test("log rotation keeps one owned previous file", async () => {
  await withTempDir(async (tempDir) => {
    const logPath = await appendFailureLog(tempDir, "first", { maxBytes: 64 });
    await appendFailureLog(tempDir, "x".repeat(64), { maxBytes: 64 });
    assert.equal(fs.existsSync(`${logPath}.1`), true);
    assert.match(await fs.promises.readFile(logPath, "utf8"), /x{64}/u);
    const info = await getFailureLogInfo(tempDir);
    assert.equal(info.files.length, 2);
    assert.equal(info.size > 64, true);
    const deleted = await deleteFailureLog(tempDir);
    assert.equal(deleted.length, 2);
    assert.equal(fs.existsSync(logPath), false);
    assert.equal(fs.existsSync(`${logPath}.1`), false);
  });
});

test("delete refuses files without the ownership header", async () => {
  await withTempDir(async (tempDir) => {
    const logPath = getFailureLogPath(tempDir);
    await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
    await fs.promises.writeFile(logPath, "user data", "utf8");
    await assert.rejects(() => deleteFailureLog(tempDir), /not owned/u);
    assert.equal(await fs.promises.readFile(logPath, "utf8"), "user data");
  });
});

test("log info reports a safely owned file", async () => {
  await withTempDir(async (tempDir) => {
    assert.equal((await getFailureLogInfo(tempDir)).exists, false);
    await appendFailureLog(tempDir, "entry");
    const info = await getFailureLogInfo(tempDir);
    assert.equal(info.exists, true);
    assert.equal(info.size > LOG_HEADER.length, true);
  });
});

test("delete validates every rotated file before deleting any log", async () => {
  await withTempDir(async (tempDir) => {
    const logPath = await appendFailureLog(tempDir, "entry");
    await fs.promises.writeFile(`${logPath}.1`, "user data", "utf8");
    await assert.rejects(() => deleteFailureLog(tempDir), /not owned/u);
    assert.equal(fs.existsSync(logPath), true);
    assert.equal(fs.existsSync(`${logPath}.1`), true);
  });
});
