"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");

function updateFramed(hash, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(buffer.length));
  hash.update(length);
  hash.update(buffer);
}

async function extensionPayloadDigest(filePath) {
  const archive = await JSZip.loadAsync(fs.readFileSync(filePath), {
    checkCRC32: true
  });
  const entries = Object.values(archive.files)
    .filter((entry) => !entry.dir && entry.name.startsWith("extension/"))
    .sort((left, right) => left.name.localeCompare(right.name, "en"));
  if (
    entries.length === 0 ||
    !entries.some((entry) => entry.name === "extension/package.json")
  ) {
    throw new Error(`${path.basename(filePath)} has no VSIX extension payload.`);
  }

  const hash = crypto.createHash("sha256");
  for (const entry of entries) {
    updateFramed(hash, entry.name);
    updateFramed(hash, await entry.async("nodebuffer"));
  }
  return hash.digest("hex");
}

async function main() {
  const [leftPath, rightPath] = process.argv.slice(2);
  if (!leftPath || !rightPath) {
    throw new Error("Usage: compare-vsix-payload.js <left.vsix> <right.vsix>");
  }
  const [leftDigest, rightDigest] = await Promise.all([
    extensionPayloadDigest(leftPath),
    extensionPayloadDigest(rightPath)
  ]);
  if (leftDigest !== rightDigest) {
    throw new Error(
      `VSIX extension payloads differ (${leftDigest} != ${rightDigest}).`
    );
  }
  console.log(`VSIX extension payload SHA-256: ${leftDigest}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message ? error.message : error);
    process.exitCode = 1;
  });
}

module.exports = { extensionPayloadDigest };
