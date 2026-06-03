const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MARKDOWN_PREVIEW_REFRESH_COMMAND
} = require("../lib/vscodeCommands");

test("uses VS Code's Markdown preview refresh command", () => {
  assert.equal(MARKDOWN_PREVIEW_REFRESH_COMMAND, "markdown.preview.refresh");
});
