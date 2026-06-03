function normalizeHeadingLevel(level) {
  const parsed = Number(level);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 6) {
    return 1;
  }
  return parsed;
}

function isIgnorableLine(line) {
  const trimmed = line.trim();
  return trimmed === "" || /^<!--.*-->$/.test(trimmed);
}

function isBulletLine(line) {
  return /^\s*[-*+]\s+\S/.test(line);
}

function normalizeFillPolicy(policy) {
  const allowed = new Set(["emptyOnly", "emptyOrBulletsOnly", "appendAlways"]);
  return allowed.has(policy) ? policy : "emptyOnly";
}

function normalizeMode(mode) {
  const allowed = new Set(["research", "general", "jobHunting"]);
  return allowed.has(mode) ? mode : "research";
}

function parseHeadingSections(text, headingLevel = 1) {
  const level = normalizeHeadingLevel(headingLevel);
  const prefix = "#".repeat(level);
  const headingPattern = new RegExp(`^${prefix}\\s+(.+?)\\s*$`);
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const headings = [];

  lines.forEach((line, index) => {
    const match = line.match(headingPattern);
    if (match) {
      headings.push({
        title: match[1].trim(),
        lineIndex: index,
        lineNumber: index + 1
      });
    }
  });

  return headings.map((heading, index) => {
    const next = headings[index + 1];
    const bodyStart = heading.lineIndex + 1;
    const bodyEnd = next ? next.lineIndex : lines.length;
    const bodyLines = lines.slice(bodyStart, bodyEnd);
    const meaningfulBodyLines = bodyLines.filter(
      (line) => !isIgnorableLine(line)
    );

    return {
      ...heading,
      bodyLines,
      isEmpty: meaningfulBodyLines.length === 0,
      isBulletsOnly:
        meaningfulBodyLines.length > 0 &&
        meaningfulBodyLines.every(isBulletLine)
    };
  });
}

function findEmptyHeadingSections(text, headingLevel = 1) {
  return parseHeadingSections(text, headingLevel).filter(
    (section) => section.isEmpty
  );
}

function findTargetHeadingSections(text, headingLevel = 1, fillPolicy = "emptyOnly") {
  const policy = normalizeFillPolicy(fillPolicy);

  return parseHeadingSections(text, headingLevel).filter((section) => {
    if (policy === "appendAlways") {
      return true;
    }

    if (policy === "emptyOrBulletsOnly") {
      return section.isEmpty || section.isBulletsOnly;
    }

    return section.isEmpty;
  });
}

function getModeInstruction(mode) {
  switch (normalizeMode(mode)) {
    case "jobHunting":
      return [
        "Mode: job hunting notes.",
        "Use each heading as a company or organization name.",
        "Preserve existing bullet notes as source hints.",
        "Append concise notes useful for job hunting, such as business summary, strengths, role fit, selection notes, and questions to ask.",
        "Do not add paper references unless the user explicitly asks for them."
      ].join("\n");
    case "general":
      return [
        "Mode: general notes.",
        "Append concise explanatory notes that help the user understand or organize the heading topic.",
        "References are optional and should be added only when useful."
      ].join("\n");
    default:
      return [
        "Mode: research notes.",
        "References must be paper-based; arXiv references are acceptable.",
        "Add exactly one reference per heading."
      ].join("\n");
  }
}

function getDefaultStyle(mode) {
  switch (normalizeMode(mode)) {
    case "jobHunting":
      return "Keep it brief. Add 2-4 compact bullets or one short paragraph, depending on the existing note shape.";
    case "general":
      return "Keep it brief. Add one concise paragraph or a few compact bullets.";
    default:
      return "One concise explanatory paragraph + one paper-based reference per heading. Keep it brief.";
  }
}

function getPolicyInstruction(fillPolicy) {
  switch (normalizeFillPolicy(fillPolicy)) {
    case "appendAlways":
      return "Target policy: append to every listed heading. Preserve existing content and append at the end of each section.";
    case "emptyOrBulletsOnly":
      return "Target policy: edit listed headings only if they are still empty or contain only bullet lines. Preserve existing bullets and append after them.";
    default:
      return "Target policy: edit listed headings only if they are still empty.";
  }
}

function buildCodexExecPrompt(filePath, targetSections, options = {}) {
  const mode = normalizeMode(options.mode);
  const fillPolicy = normalizeFillPolicy(options.fillPolicy);
  const researchField = options.researchField || "not specified";
  const outputLanguage = options.outputLanguage || "Japanese";
  const noteStyle = options.noteStyle || getDefaultStyle(mode);

  const headingList = targetSections
    .map((section) => {
      const state = section.isEmpty
        ? "empty"
        : section.isBulletsOnly
          ? "bullets-only"
          : "has content";
      return `- ${section.title} (line ${section.lineNumber}, ${state})`;
    })
    .join("\n");

  return [
    "Edit the following Markdown file directly.",
    "",
    `Target file: ${filePath}`,
    `Research field: ${researchField}`,
    `Output language: ${outputLanguage}`,
    `Mode: ${mode}`,
    `Fill policy: ${fillPolicy}`,
    "",
    "Target headings:",
    headingList,
    "",
    "Mode instructions:",
    getModeInstruction(mode),
    "",
    "Rules:",
    "- Reread the target file immediately before editing and check for user changes.",
    `- ${getPolicyInstruction(fillPolicy)}`,
    "- Do not delete or rewrite existing body text, bullets, links, references, or user notes.",
    `- Style: ${noteStyle}`,
    `- Write in ${outputLanguage}.`,
    "- Do not add extra commentary outside the file edit."
  ].join("\n");
}

module.exports = {
  buildCodexExecPrompt,
  findEmptyHeadingSections,
  findTargetHeadingSections,
  isBulletLine,
  parseHeadingSections
};
