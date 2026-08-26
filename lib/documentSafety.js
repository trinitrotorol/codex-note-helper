"use strict";

function isDocumentSnapshotCurrent(
  document,
  openDocuments,
  originalVersion,
  originalText
) {
  if (
    !document ||
    document.isClosed === true ||
    !Array.isArray(openDocuments) ||
    !openDocuments.some((candidate) => candidate === document) ||
    document.version !== originalVersion ||
    typeof document.getText !== "function"
  ) {
    return false;
  }
  return document.getText() === originalText;
}

module.exports = { isDocumentSnapshotCurrent };
