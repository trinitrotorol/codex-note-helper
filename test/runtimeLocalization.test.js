"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const repoRoot = path.join(__dirname, "..");

function decodeLiteral(literal) {
  return JSON.parse(literal);
}

function placeholders(value) {
  return [...String(value).matchAll(/\{\d+\}/gu)]
    .map((match) => match[0])
    .sort();
}

test("Japanese runtime localization covers every extension message", () => {
  const source = fs.readFileSync(path.join(repoRoot, "extension.js"), "utf8");
  const catalog = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, "l10n", "bundle.l10n.ja.json"),
      "utf8"
    )
  );
  const messages = new Set();
  const directPattern = /\bt\(\s*("(?:[^"\\]|\\.)*")/gu;
  for (const match of source.matchAll(directPattern)) {
    messages.add(decodeLiteral(match[1]));
  }

  const progressBlock = /const messages = \{([\s\S]*?)\n  \};/u.exec(source);
  assert.ok(progressBlock, "progress message table was not found");
  const valuePattern = /:\s*("(?:[^"\\]|\\.)*")/gu;
  for (const match of progressBlock[1].matchAll(valuePattern)) {
    messages.add(decodeLiteral(match[1]));
  }
  messages.add("Processing target sections");

  assert.deepEqual(Object.keys(catalog).sort(), [...messages].sort());
  for (const message of messages) {
    assert.equal(typeof catalog[message], "string", `missing: ${message}`);
    assert.notEqual(catalog[message].trim(), "", `empty: ${message}`);
    assert.deepEqual(
      placeholders(catalog[message]),
      placeholders(message),
      `placeholder mismatch: ${message}`
    );
  }
});
