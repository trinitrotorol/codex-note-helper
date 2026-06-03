const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildCodexExecPrompt,
  findEmptyHeadingSections,
  findTargetHeadingSections,
  parseHeadingSections
} = require("../lib/noteParser");

test("findEmptyHeadingSections returns only blank top-level headings", () => {
  const text = [
    "# Filled",
    "",
    "本文あり",
    "# Empty",
    "",
    "<!-- later -->",
    "",
    "# Also filled",
    "参考文献: example"
  ].join("\n");

  const empty = findEmptyHeadingSections(text, 1);

  assert.deepEqual(
    empty.map((section) => ({
      title: section.title,
      lineNumber: section.lineNumber
    })),
    [{ title: "Empty", lineNumber: 4 }]
  );
});

test("parseHeadingSections supports CRLF and heading levels", () => {
  const text = [
    "# Parent",
    "parent body",
    "## Empty child",
    "",
    "## Filled child",
    "child body"
  ].join("\r\n");

  const sections = parseHeadingSections(text, 2);

  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, "Empty child");
  assert.equal(sections[0].lineNumber, 3);
  assert.equal(sections[0].isEmpty, true);
  assert.equal(sections[1].title, "Filled child");
  assert.equal(sections[1].isEmpty, false);
});

test("findTargetHeadingSections supports bullets-only sections", () => {
  const text = [
    "# Empty",
    "",
    "# Bullets",
    "- source note",
    "- another source note",
    "",
    "# Prose",
    "already explained"
  ].join("\n");

  const targets = findTargetHeadingSections(text, 1, "emptyOrBulletsOnly");

  assert.deepEqual(
    targets.map((section) => ({
      title: section.title,
      isEmpty: section.isEmpty,
      isBulletsOnly: section.isBulletsOnly
    })),
    [
      { title: "Empty", isEmpty: true, isBulletsOnly: false },
      { title: "Bullets", isEmpty: false, isBulletsOnly: true }
    ]
  );
});

test("findTargetHeadingSections can append to every section", () => {
  const text = ["# A", "body", "# B", "- bullet"].join("\n");
  const targets = findTargetHeadingSections(text, 1, "appendAlways");

  assert.deepEqual(
    targets.map((section) => section.title),
    ["A", "B"]
  );
});

test("lower-level headings count as body for a top-level section", () => {
  const text = ["# Not empty", "## Detail"].join("\n");

  const empty = findEmptyHeadingSections(text, 1);

  assert.deepEqual(empty, []);
});

test("buildCodexExecPrompt includes compact research note rules and headings", () => {
  const prompt = buildCodexExecPrompt(
    "C:/notes/note.md",
    [{ title: "量子フーリエ変換", lineNumber: 12, isEmpty: true }],
    {
      mode: "research",
      fillPolicy: "emptyOnly",
      researchField: "量子コンピュータ",
      outputLanguage: "Japanese",
      noteStyle: "説明1段落 + 参考文献1本"
    }
  );

  assert.match(prompt, /Target file: C:\/notes\/note\.md/);
  assert.match(prompt, /Research field: 量子コンピュータ/);
  assert.match(prompt, /Output language: Japanese/);
  assert.match(prompt, /Mode: research/);
  assert.match(prompt, /Fill policy: emptyOnly/);
  assert.match(prompt, /- 量子フーリエ変換 \(line 12, empty\)/);
  assert.match(prompt, /説明1段落 \+ 参考文献1本/);
  assert.match(prompt, /Add exactly one reference per heading/);
  assert.match(prompt, /edit listed headings only if they are still empty/);
});

test("buildCodexExecPrompt supports job hunting bullets-only append mode", () => {
  const prompt = buildCodexExecPrompt(
    "C:/notes/companies.md",
    [{ title: "Example Inc.", lineNumber: 3, isBulletsOnly: true }],
    {
      mode: "jobHunting",
      fillPolicy: "emptyOrBulletsOnly",
      outputLanguage: "Japanese"
    }
  );

  assert.match(prompt, /Mode: jobHunting/);
  assert.match(prompt, /Fill policy: emptyOrBulletsOnly/);
  assert.match(prompt, /Example Inc\. \(line 3, bullets-only\)/);
  assert.match(prompt, /job hunting notes/);
  assert.match(prompt, /Preserve existing bullets and append after them/);
});
