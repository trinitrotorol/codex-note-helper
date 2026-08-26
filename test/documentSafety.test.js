const test = require("node:test");
const assert = require("node:assert/strict");
const { isDocumentSnapshotCurrent } = require("../lib/documentSafety");

function createDocument(overrides = {}) {
  return {
    isClosed: false,
    version: 7,
    getText: () => "# Note\n",
    ...overrides
  };
}

test("document snapshot is current only for the same open document instance", () => {
  const document = createDocument();
  assert.equal(
    isDocumentSnapshotCurrent(document, [document], 7, "# Note\n"),
    true
  );
  assert.equal(
    isDocumentSnapshotCurrent(document, [createDocument()], 7, "# Note\n"),
    false
  );
});

test("closed, changed, and untracked documents are rejected", () => {
  const closed = createDocument({ isClosed: true });
  const changedVersion = createDocument({ version: 8 });
  const changedText = createDocument({ getText: () => "# Reopened\n" });

  assert.equal(isDocumentSnapshotCurrent(closed, [closed], 7, "# Note\n"), false);
  assert.equal(
    isDocumentSnapshotCurrent(changedVersion, [changedVersion], 7, "# Note\n"),
    false
  );
  assert.equal(
    isDocumentSnapshotCurrent(changedText, [changedText], 7, "# Note\n"),
    false
  );
  assert.equal(isDocumentSnapshotCurrent(createDocument(), [], 7, "# Note\n"), false);
});
