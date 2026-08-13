import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { contributionCellLabel, projectPlanOntoDates } from "../src/app.js";

const [html, javascript, css, readme, gitignore] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../styles.css", import.meta.url), "utf8"),
  readFile(new URL("../README.md", import.meta.url), "utf8"),
  readFile(new URL("../.gitignore", import.meta.url), "utf8"),
]);

function tags(name) {
  return [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "gi"))].map((match) => match[1]);
}

function attribute(attributes, name) {
  return attributes.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2];
}

function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const channels = hex.match(/[0-9a-f]{2}/gi).map((channel) => Number.parseInt(channel, 16) / 255);
    const [red, green, blue] = channels.map((channel) => (
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
    ));
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const first = luminance(foreground);
  const second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test("the page has a useful, accessible document structure", () => {
  assert.match(html, /<!doctype\s+html/i);
  assert.match(html, /<html\b[^>]*\blang\s*=/i);
  assert.match(html, /<meta\b[^>]*\bcharset\s*=/i);
  assert.match(html, /<meta\b[^>]*\bname=["']viewport["']/i);
  assert.match(html, /<title>[^<]+<\/title>/i);
  assert.match(html, /<main\b/i);
  assert.match(html, /<h1\b/i);
  assert.match(html, /<button\b/i);
  assert.match(html, /<label\b/i);
  assert.match(html + javascript, /\bkeydown\b/i, "the drawing UI should support a keyboard");
});

test("CSS and JavaScript are local, external files", () => {
  const stylesheet = tags("link").find((attributes) => attribute(attributes, "rel") === "stylesheet");
  assert.ok(stylesheet, "the page should have a stylesheet link");
  assert.match(attribute(stylesheet, "href") ?? "", /^(?:\.\/)?styles\.css$/i);

  const applicationScript = tags("script").find((attributes) =>
    /^(?:\.\/)?src\/app\.js$/i.test(attribute(attributes, "src") ?? ""),
  );
  assert.ok(applicationScript, "the page should load src/app.js");
  assert.doesNotMatch(html, /<style\b/i, "CSP-compatible pages should not use inline styles");

  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, "the page should load its application script");
  for (const [, attributes, body] of scripts) {
    assert.match(attributes, /\bsrc\s*=/i, "scripts must be loaded from a file");
    assert.equal(body.trim(), "", "scripts must not contain inline code");
  }

  for (const name of ["script", "link", "img", "source", "video", "audio"]) {
    for (const attributes of tags(name)) {
      const value = attribute(attributes, name === "link" ? "href" : "src");
      if (value) {
        assert.doesNotMatch(value, /^(?:https?:)?\/\//i, "subresources must not depend on the network");
      }
    }
  }
});

test("application code contains no network clients or dynamic code execution", () => {
  const forbidden = [
    [/\bfetch\s*\(/, "fetch"],
    [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
    [/\bWebSocket\b/, "WebSocket"],
    [/\bEventSource\b/, "EventSource"],
    [/\bsendBeacon\s*\(/, "sendBeacon"],
    [/\beval\s*\(/, "eval"],
    [/\bnew\s+Function\s*\(/, "Function constructor"],
    [/\bdocument\.write(?:ln)?\s*\(/, "document.write"],
  ];

  for (const [pattern, name] of forbidden) {
    assert.doesNotMatch(javascript, pattern, `${name} is not allowed in this local-only tool`);
  }
});

test("contribution snapshots remain local and visibly separate from design archives", () => {
  for (const id of [
    "snapshot-heading",
    "import-snapshot-button",
    "unload-snapshot-button",
    "snapshot-file",
    "snapshot-account",
    "snapshot-generated-at",
    "snapshot-range",
    "snapshot-existing-status",
    "snapshot-notice",
  ]) {
    assert.match(html, new RegExp(`\\bid=["']${id}["']`), `missing snapshot UI element: ${id}`);
  }
  assert.match(html, /快照不是实时数据/);
  assert.match(html, /浏览器不会连接 GitHub/);
  assert.match(javascript, /parseContributionSnapshot/);
  assert.match(javascript, /byDate:\s*new Map\(\)/);
  assert.match(
    javascript,
    /state\.snapshot\s*\?\s*core\.generateScript\(format, design, state\.snapshot\)\s*:\s*core\.generateScript\(format, design\)/,
    "the no-snapshot path must omit the optional snapshot argument",
  );
  assert.match(javascript, /core\.serializeDesign\(currentDesign\(\)\)/);
  assert.match(css, /has-existing/);
  assert.match(css, /repeating-linear-gradient/);
  assert.match(css, /has-plan/);
});

test("documented snapshot outputs use the ignored private-data suffix", () => {
  const documentedOutputs = [...readme.matchAll(/--output\s+(\S+)/g)].map((match) => match[1]);
  assert.ok(documentedOutputs.length > 0, "README should document an explicit snapshot output path");
  for (const output of documentedOutputs) {
    assert.match(output, /\.commit-canvas-snapshot\.json$/);
  }
  assert.match(gitignore, /^\*\.commit-canvas-snapshot\.json$/m);
});

test("the CSP keeps all network connections disabled", () => {
  const cspMeta = tags("meta").find(
    (attributes) => attribute(attributes, "http-equiv")?.toLowerCase() === "content-security-policy",
  );
  assert.ok(cspMeta, "a Content Security Policy is required");
  assert.match(attribute(cspMeta, "content") ?? "", /connect-src\s+'none'/i);
});

test("plan projection reports dates lost outside the new window and blocked by existing contributions", () => {
  const planned = new Map([
    ["2025-01-01", 2],
    ["2025-01-02", 3],
    ["2024-01-01", 4],
  ]);
  const nextDates = [
    { date: "2025-01-01", isFuture: false },
    { date: "2025-01-02", isFuture: false },
    { date: "2025-01-03", isFuture: false },
  ];
  const blocked = new Map([["2025-01-02", { count: 7 }]]);

  assert.deepEqual(projectPlanOntoDates(planned, nextDates, blocked), {
    levels: [2, 0, 0],
    lostOutsideRange: 1,
    clearedExisting: 1,
  });
  assert.deepEqual([...planned], [
    ["2025-01-01", 2],
    ["2025-01-02", 3],
    ["2024-01-01", 4],
  ], "projection must not mutate current plan state before confirmation");
});

test("cell accessibility text distinguishes an unchecked wall from a checked zero", () => {
  assert.equal(
    contributionCellLabel(false, 0, 3),
    "当前 GitHub 贡献未检查，计划新增 3 次",
  );
  assert.equal(
    contributionCellLabel(true, 0, 3),
    "GitHub 已有 0 次贡献，计划新增 3 次",
  );
  assert.equal(
    contributionCellLabel(true, 7, 0),
    "GitHub 已有 7 次贡献，计划新增 0 次",
  );
});

test("markup avoids inline event handlers and unsafe blank-target links", () => {
  assert.doesNotMatch(html, /\s+on[a-z]+\s*=/i);

  for (const match of html.matchAll(/<a\b([^>]*)>/gi)) {
    const attributes = match[1];
    if (/\btarget\s*=\s*["']_blank["']/i.test(attributes)) {
      assert.match(attributes, /\brel\s*=\s*["'][^"']*\bnoopener\b[^"']*["']/i);
    }
  }
});

test("styles include keyboard focus and reduced-motion accommodations", () => {
  assert.match(css, /:focus(?:-visible)?\b/i);
  assert.match(css, /prefers-reduced-motion/i);
});

test("responsive styles avoid page overflow and provide accessible touch and dark-mode contrast", () => {
  const bodyRule = css.match(/body\s*\{([^}]*)\}/i)?.[1] ?? "";
  assert.doesNotMatch(bodyRule, /min-width\s*:/i);

  const coarseRules = css.match(/@media\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?)\n\}/i)?.[1] ?? "";
  const coarseCell = Number(coarseRules.match(/--cell:\s*(\d+)px/i)?.[1]);
  assert.ok(coarseCell >= 24, "coarse pointers need at least a 24px contribution-cell target");

  const darkRules = css.match(/@media\s*\(prefers-color-scheme:\s*dark\)\s*\{([\s\S]*?)\n\}/i)?.[1] ?? "";
  const darkRust = darkRules.match(/--rust:\s*#([0-9a-f]{6})/i)?.[1];
  const darkSheet = darkRules.match(/--sheet:\s*#([0-9a-f]{6})/i)?.[1];
  assert.ok(darkRust && darkSheet);
  assert.ok(contrastRatio(darkRust, darkSheet) >= 4.5, "dark-mode accent text must meet 4.5:1 contrast");
});
