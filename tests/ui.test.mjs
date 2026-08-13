import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  contributionCellLabel,
  contributionGrowthConfirmed,
  liveConfirmationReady,
  projectPlanOntoDates,
} from "../src/app.js";

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

test("application network access is limited to explicit same-origin companion API routes", () => {
  const forbidden = [
    [/\bXMLHttpRequest\b/, "XMLHttpRequest"],
    [/\bWebSocket\b/, "WebSocket"],
    [/\bEventSource\b/, "EventSource"],
    [/\bsendBeacon\s*\(/, "sendBeacon"],
    [/\beval\s*\(/, "eval"],
    [/\bnew\s+Function\s*\(/, "Function constructor"],
    [/\bdocument\.write(?:ln)?\s*\(/, "document.write"],
  ];

  for (const [pattern, name] of forbidden) {
    assert.doesNotMatch(javascript, pattern, `${name} is not allowed in the browser application`);
  }

  const fetchCallCount = [...javascript.matchAll(/\bfetch\s*\(/g)].length;
  const literalApiCalls = [...javascript.matchAll(/\bfetch\s*\(\s*(["'])\/api\/[a-z0-9/_-]*\1/gi)].length;
  const encodedJobCalls = [...javascript.matchAll(
    /\bfetch\s*\(\s*`\/api\/submissions\/\$\{encodeURIComponent\((?:jobId|current\.id)\)\}`/g,
  )].length;
  const centralizedApiFetches = [...javascript.matchAll(/\bfetch\s*\(\s*path\s*,/g)].length;
  assert.ok(fetchCallCount > 0, "live mode should call the localhost companion API");
  assert.equal(
    literalApiCalls + encodedJobCalls + centralizedApiFetches,
    fetchCallCount,
    "fetch must be a literal same-origin API path, encoded job polling path, or the audited API helper",
  );

  if (centralizedApiFetches > 0) {
    assert.equal(centralizedApiFetches, 1, "only one centralized API fetch helper is allowed");
    assert.match(javascript, /async function apiJson\(path,[\s\S]*?fetch\(path,\s*options\)/);
    const helperCallCount = [...javascript.matchAll(/\bapiJson\s*\(/g)].length - 1;
    const helperLiteralCalls = [...javascript.matchAll(/\bapiJson\s*\(\s*(["'])\/api\/[a-z0-9/_-]*\1/gi)].length;
    const helperPollingCalls = [...javascript.matchAll(
      /\bapiJson\s*\(\s*`\/api\/submissions\/\$\{encodeURIComponent\((?:jobId|current\.id)\)\}`/g,
    )].length;
    assert.equal(
      helperLiteralCalls + helperPollingCalls,
      helperCallCount,
      "every API helper call must use a literal /api/ path or the exact encoded polling template",
    );
  }

  assert.doesNotMatch(javascript, /\bhttps?:\/\//i, "browser code must not contain external HTTP endpoints");
  assert.doesNotMatch(javascript, /\b(?:api\.)?github\.com\b|github\.com\/login/i);
  assert.doesNotMatch(javascript, /\blocalStorage\b/i, "persistent browser storage is not allowed");
  assert.doesNotMatch(javascript, /sessionStorage[\s\S]{0,160}(?:token|csrf|authorization|design)/i);
  assert.match(javascript, /sessionStorage\.setItem\(PENDING_JOB_STORAGE_KEY, jobId\)/);
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
  assert.match(html, /离线后备/);
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

test("live GitHub controls and offline fallbacks remain explicit in the markup", () => {
  const liveIds = [
    "live-mode-badge",
    "connect-status",
    "refresh-contributions-button",
    "live-section",
    "live-heading",
    "live-account",
    "live-repository",
    "managed-repo-name",
    "managed-repo-visibility",
    "setup-repository-button",
    "live-plan-summary",
    "submit-live-button",
    "resume-submission-button",
    "dismiss-submission-button",
    "live-submit-status",
    "live-progress",
    "live-dialog",
    "live-dialog-title",
    "live-review-account",
    "live-review-repository",
    "live-review-branch",
    "live-review-count",
    "live-review-dates",
    "live-confirm-input",
    "live-confirm-phrase",
    "live-high-volume-confirm-wrap",
    "live-high-volume-confirm",
    "confirm-live-submit-button",
  ];
  const offlineFallbackIds = [
    "import-snapshot-button",
    "unload-snapshot-button",
    "snapshot-file",
    "export-json-button",
    "import-json-button",
    "import-file",
    "export-form",
    "generate-button",
    "script-dialog",
    "script-output",
    "copy-script-button",
    "download-script-button",
  ];

  for (const id of [...liveIds, ...offlineFallbackIds]) {
    assert.match(html, new RegExp(`\\bid=["']${id}["']`), `missing dual-mode UI element: ${id}`);
  }
  assert.match(html, /真实的远程写入|真实写入远程仓库/);
  assert.match(html, /高级离线后备/);
});

test("documented snapshot outputs use the ignored private-data suffix", () => {
  const documentedOutputs = [...readme.matchAll(/--output\s+(\S+)/g)].map((match) => match[1]);
  assert.ok(documentedOutputs.length > 0, "README should document an explicit snapshot output path");
  for (const output of documentedOutputs) {
    assert.match(output, /\.commit-canvas-snapshot\.json$/);
  }
  assert.match(gitignore, /^\*\.commit-canvas-snapshot\.json$/m);
});

test("the CSP permits only same-origin companion connections", () => {
  const cspMeta = tags("meta").find(
    (attributes) => attribute(attributes, "http-equiv")?.toLowerCase() === "content-security-policy",
  );
  assert.ok(cspMeta, "a Content Security Policy is required");
  const content = attribute(cspMeta, "content") ?? "";
  assert.match(content, /(?:^|;)\s*connect-src\s+'self'\s*(?:;|$)/i);
  assert.doesNotMatch(content, /(?:^|;)\s*connect-src[^;]*(?:\*|https?:|wss?:)/i);
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

test("live submission confirms indexing only when every target date grew by its planned count", () => {
  const before = new Map([
    ["2025-01-01", { count: 2 }],
    ["2025-01-02", { count: 0 }],
  ]);
  const planned = new Map([
    ["2025-01-01", 3],
    ["2025-01-02", 1],
  ]);
  assert.equal(contributionGrowthConfirmed(before, planned, new Map([
    ["2025-01-01", { count: 5 }],
    ["2025-01-02", { count: 1 }],
  ])), true);
  assert.equal(contributionGrowthConfirmed(before, planned, new Map([
    ["2025-01-01", { count: 5 }],
    ["2025-01-02", { count: 0 }],
  ])), false);
  assert.match(javascript, /GitHub 贡献墙已确认更新/);
  assert.match(javascript, /等待 GitHub 索引（最长可能 24 小时）/);
});

test("live high-volume submission requires a separate acknowledgement at 200 commits", () => {
  assert.equal(liveConfirmationReady("CREATE", "CREATE", 199, false), true);
  assert.equal(liveConfirmationReady("CREATE", "CREATE", 200, false), false);
  assert.equal(liveConfirmationReady("CREATE", "CREATE", 200, true), true);
  assert.equal(liveConfirmationReady("wrong", "CREATE", 200, true), false);
});

test("accepted jobs remain resumable while terminal results use backend created and skipped counts", () => {
  assert.match(javascript, /rememberPendingJob\(payload\.job\.id\)/);
  assert.match(javascript, /expectedDefaultBranch:\s*plan\.expectedDefaultBranch/);
  assert.match(javascript, /这不表示任务失败；请继续查询/);
  assert.match(javascript, /completed\.status === 'failed'/);
  assert.match(javascript, /创建 \$\{created \?\? 0\} 次，跳过 \$\{skipped \?\? 0\} 次/);
  assert.match(javascript, /全部计划提交已存在，因此没有创建新提交/);
  assert.match(javascript, /部分提交被跳过，无法按日期即时确认贡献增长/);
});

test("an unresolved accepted job blocks new writes and a missing local job remains explicitly unknown", () => {
  assert.match(javascript, /elements\.submitLive\.disabled[\s\S]{0,160}state\.pendingJobId/);
  assert.match(javascript, /if \(state\.pendingJobId\)[\s\S]{0,240}才能提交新计划/);
  assert.match(javascript, /if \(state\.submitting \|\| state\.pendingJobId \|\| !plan\) return/);
  assert.match(javascript, /error\?\.status === 404/);
  assert.match(javascript, /这不表示远端失败/);
  assert.match(javascript, /请先在 GitHub 核对仓库/);
  assert.match(javascript, /放弃只会清除本浏览器的查询记录，不会取消、撤销或判断远端任务/);
});

test("reload completion without submission context reports facts without clearing the canvas", () => {
  assert.match(javascript, /if \(context\) \{[\s\S]*?submittedDates[\s\S]*?restoreLevels\(state\.levels\)[\s\S]*?\}/);
  assert.match(javascript, /const countDetails = `创建 \$\{created \?\? 0\} 次，跳过 \$\{skipped \?\? 0\} 次`/);
  assert.match(javascript, /const resultUrl = completed\.result\?\.commitUrl/);
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
