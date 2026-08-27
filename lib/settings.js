"use strict";

const path = require("path");

const MODES = new Set(["research", "general", "jobHunting"]);
const FILL_POLICIES = new Set([
  "emptyOnly",
  "emptyOrBulletsOnly",
  "appendAlways"
]);
const CONFIRM_POLICIES = new Set(["always", "appendAlways", "never"]);

function integerInRange(value, minimum, maximum, name) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function limitedString(value, maximum, name, fallback = "") {
  const normalized = String(value === undefined ? fallback : value).trim();
  if (normalized.length > maximum) {
    throw new TypeError(`${name} must not exceed ${maximum} characters.`);
  }
  return normalized;
}

function normalizeCodexCommand(value) {
  const trimmed = String(value || "codex").trim();
  const command = /^"[^"\r\n]+"$/u.test(trimmed)
    ? trimmed.slice(1, -1)
    : trimmed;

  if (!command || /[\0\r\n]/u.test(command)) {
    throw new TypeError("codexCommand is invalid.");
  }

  const isAbsolute =
    path.isAbsolute(command) ||
    path.win32.isAbsolute(command) ||
    path.posix.isAbsolute(command);

  if (!isAbsolute && !/^[A-Za-z0-9_.-]+$/u.test(command)) {
    throw new TypeError(
      "codexCommand must be an executable name or an absolute executable path."
    );
  }

  return command;
}

function validateOptions(raw = {}) {
  const mode = raw.mode === undefined ? "research" : raw.mode;
  const fillPolicy = raw.fillPolicy === undefined ? "emptyOnly" : raw.fillPolicy;
  const confirmBeforeRun =
    raw.confirmBeforeRun === undefined ? "appendAlways" : raw.confirmBeforeRun;

  if (!MODES.has(mode)) {
    throw new TypeError(`Unsupported mode: ${mode}`);
  }
  if (!FILL_POLICIES.has(fillPolicy)) {
    throw new TypeError(`Unsupported fill policy: ${fillPolicy}`);
  }
  if (!CONFIRM_POLICIES.has(confirmBeforeRun)) {
    throw new TypeError(`Unsupported confirmation policy: ${confirmBeforeRun}`);
  }

  return {
    mode,
    fillPolicy,
    researchField: limitedString(raw.researchField, 2000, "researchField"),
    outputLanguage: limitedString(
      raw.outputLanguage,
      100,
      "outputLanguage",
      "English"
    ),
    noteStyle: limitedString(raw.noteStyle, 4000, "noteStyle"),
    headingLevel: integerInRange(
      raw.headingLevel === undefined ? 1 : raw.headingLevel,
      1,
      6,
      "headingLevel"
    ),
    codexCommand: normalizeCodexCommand(raw.codexCommand),
    allowBundledCodexFromOpenAIExtension:
      raw.allowBundledCodexFromOpenAIExtension === true,
    enableWebSearch: raw.enableWebSearch === true,
    showCodexProgress: raw.showCodexProgress !== false,
    ignoreCodexUserConfiguration: raw.ignoreCodexUserConfiguration !== false,
    confirmBeforeRun,
    timeoutSeconds: integerInRange(
      raw.timeoutSeconds === undefined ? 300 : raw.timeoutSeconds,
      30,
      1800,
      "timeoutSeconds"
    ),
    maxTargetHeadings: integerInRange(
      raw.maxTargetHeadings === undefined ? 25 : raw.maxTargetHeadings,
      1,
      200,
      "maxTargetHeadings"
    ),
    maxInputCharacters: integerInRange(
      raw.maxInputCharacters === undefined ? 500000 : raw.maxInputCharacters,
      1000,
      5000000,
      "maxInputCharacters"
    ),
    maxOutputBytes: integerInRange(
      raw.maxOutputBytes === undefined ? 1048576 : raw.maxOutputBytes,
      65536,
      10485760,
      "maxOutputBytes"
    )
  };
}

function shouldConfirmRun(confirmBeforeRun, fillPolicy) {
  return (
    confirmBeforeRun === "always" ||
    (confirmBeforeRun === "appendAlways" && fillPolicy === "appendAlways")
  );
}

function isSupportedDocumentScheme(scheme) {
  return scheme === "file" || scheme === "vscode-remote";
}

module.exports = {
  CONFIRM_POLICIES,
  FILL_POLICIES,
  MODES,
  isSupportedDocumentScheme,
  normalizeCodexCommand,
  shouldConfirmRun,
  validateOptions
};
