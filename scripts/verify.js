const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const repoRoot = path.resolve(__dirname, "..");
const syntaxOnly = process.argv.includes("--syntax-only");
const ignoredDirectories = new Set([
  ".git",
  ".npm-cache",
  ".tools",
  ".vscode-test",
  "coverage",
  "dist",
  "node_modules"
]);

function collectJavaScriptFiles(directory, result = []) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });

  entries.forEach((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        collectJavaScriptFiles(fullPath, result);
      }
      return;
    }

    if (entry.isFile() && entry.name.endsWith(".js")) {
      result.push(fullPath);
    }
  });

  return result;
}

function checkSyntax(filePath) {
  const source = fs
    .readFileSync(filePath, "utf8")
    .replace(/^#![^\r\n]*(?:\r?\n|$)/, "");
  new vm.Script(source, { filename: filePath, displayErrors: true });
}

const javascriptFiles = collectJavaScriptFiles(repoRoot).sort();
if (javascriptFiles.length === 0) {
  throw new Error("No JavaScript files were found to verify.");
}

javascriptFiles.forEach(checkSyntax);
console.log(`Syntax OK: ${javascriptFiles.length} JavaScript files`);

if (!syntaxOnly) {
  const testRoot = path.join(repoRoot, "test");
  const testFiles = javascriptFiles.filter(
    (filePath) =>
      path.dirname(filePath) === testRoot && filePath.endsWith(".test.js")
  );

  if (testFiles.length === 0) {
    throw new Error("No test files were found to run.");
  }

  testFiles.forEach((filePath) => require(filePath));
}
