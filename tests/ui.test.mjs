import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  contributionCellLabel,
  contributionGrowthConfirmed,
  liveConfirmationReady,
  projectPlanOntoDates,
} from "../src/app.js";
import {
  CATALOGS,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  assertCatalogParity,
  createI18n,
  localizeDocument,
  normalizeLocale,
} from "../src/i18n.js";

const [html, javascript, i18nSource, css, readme, gitignore] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../src/i18n.js", import.meta.url), "utf8"),
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
  assert.match(html, /<html\b[^>]*\blang=["']en["']/i);
  assert.match(html, /<meta\b[^>]*\bcharset\s*=/i);
  assert.match(html, /<meta\b[^>]*\bname=["']viewport["']/i);
  assert.match(html, /<title>[^<]+<\/title>/i);
  assert.match(html, /<main\b/i);
  assert.match(html, /<h1\b/i);
  assert.match(html, /<button\b/i);
  assert.match(html, /<label\b/i);
  assert.match(html + javascript, /\bkeydown\b/i, "the drawing UI should support a keyboard");
  assert.match(
    html,
    /<div\b[^>]*\bid=["']commit-grid["'][^>]*\baria-describedby=["']grid-help["'][^>]*>/i,
    "the contribution grid should expose its keyboard and pointer instructions",
  );
});

test("English is the non-persistent default and the accessible language switch exposes both locales", () => {
  assert.equal(DEFAULT_LOCALE, "en");
  assert.deepEqual(SUPPORTED_LOCALES, ["en", "zh-Hans"]);
  assert.match(html, /<html\b[^>]*\blang=["']en["']/i);
  assert.match(html, /data-locale=["']en["'][^>]*aria-pressed=["']true["']/i);
  assert.match(html, /data-locale=["']zh-Hans["'][^>]*aria-pressed=["']false["']/i);
  assert.match(html, /data-i18n-aria-label=["']language\.label["']/i);
  assert.match(javascript, /ui\.setLocale\(locale\)/);
  assert.match(javascript, /localizeDocument\(document, ui\)/);
  assert.doesNotMatch(javascript + i18nSource, /localStorage/i);
  assert.doesNotMatch(javascript, /sessionStorage\.(?:setItem|getItem)\([^\n]*(?:locale|language)/i);
});

test("translation catalogs have exact parity, are frozen, and format both locales", () => {
  assert.equal(assertCatalogParity(), true);
  assert.equal(Object.isFrozen(CATALOGS), true);
  assert.equal(Object.isFrozen(CATALOGS.en), true);
  assert.equal(Object.isFrozen(CATALOGS["zh-Hans"]), true);
  assert.equal(normalizeLocale("zh-CN"), "zh-Hans");
  assert.equal(normalizeLocale("fr-FR"), "en");

  const english = createI18n();
  const chinese = createI18n("zh-Hans");
  assert.equal(english.locale, "en");
  assert.equal(english.plural("cell.existing", 1), "GitHub already has 1 contribution");
  assert.equal(english.plural("cell.existing", 2), "GitHub already has 2 contributions");
  assert.equal(chinese.plural("cell.existing", 2), "GitHub 已有 2 次贡献");
  assert.equal(english.formatNumber(12345), "12,345");
  assert.equal(english.formatMonth("2025-01-02"), "Jan");
  assert.equal(chinese.formatMonth("2025-01-02"), "1月");
  assert.equal(english.formatWeekday("2025-01-02"), "Thursday");
  assert.match(chinese.formatWeekday("2025-01-02"), /星期四|周四/);
  assert.match(english.formatIsoDate("2025-01-02"), /Jan 2, 2025/);
  assert.match(chinese.formatIsoDate("2025-01-02"), /2025.*1.*2/);
  assert.throws(() => english.formatIsoDate("2025-02-29"), /valid calendar date/);
  assert.throws(() => english.formatMonth("not-a-date"), /YYYY-MM-DD/);
});

test("catalog parity rejects value-shape and interpolation drift", () => {
  assert.throws(() => assertCatalogParity({
    en: { greeting: 'Hello {name}' },
    'zh-Hans': { greeting: '你好' },
  }), /placeholders differ/);
  assert.throws(() => assertCatalogParity({
    en: { items: { one: '{count} item', other: '{count} items' } },
    'zh-Hans': { items: '{count} 项' },
  }), /value type differs/);
  assert.throws(() => assertCatalogParity({
    en: { items: { one: '{count} item', other: '{count} items' } },
    'zh-Hans': { items: { one: '{count} 项' } },
  }), /requires an other form/);
});

test("interpolation stays text-only and document metadata and attributes follow the active locale", () => {
  const dangerous = '<img src=x onerror="alert(1)">';
  const english = createI18n();
  assert.equal(english.t("error.startup", { message: dangerous }), `The tool could not start: ${dangerous}`);

  const textNode = { dataset: { i18n: "canvas.heading" }, textContent: "" };
  const labelNode = {
    dataset: { i18nAriaLabel: "brand.home" },
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  };
  const description = {
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  };
  const documentStub = {
    nodeType: 9,
    documentElement: { lang: "en" },
    title: "",
    querySelector(selector) { return selector === 'meta[name="description"]' ? description : null; },
    querySelectorAll(selector) {
      if (selector === "[data-i18n]") return [textNode];
      if (selector === "[data-i18n-aria-label]") return [labelNode];
      return [];
    },
  };
  const chinese = createI18n("zh-Hans");
  localizeDocument(documentStub, chinese);
  assert.equal(documentStub.documentElement.lang, "zh-Hans");
  assert.equal(documentStub.title, CATALOGS["zh-Hans"]["meta.title"]);
  assert.equal(description.attributes.content, CATALOGS["zh-Hans"]["meta.description"]);
  assert.equal(textNode.textContent, "画布");
  assert.equal(labelNode.attributes["aria-label"], "Commit Canvas 首页");
  assert.doesNotMatch(i18nSource, /\.innerHTML\s*=/);
});

test("all static localization hooks resolve and browser application copy is catalog-driven", () => {
  const keys = [
    ...html.matchAll(/data-i18n(?:-aria-label|-placeholder|-title|-data-stamp)?=["']([^"']+)["']/g),
  ].map((match) => match[1]);
  assert.ok(keys.length > 80, "the visible shell should be fully localization-addressable");
  for (const key of keys) {
    assert.ok(Object.hasOwn(CATALOGS.en, key), `missing English markup translation: ${key}`);
    assert.ok(Object.hasOwn(CATALOGS["zh-Hans"], key), `missing Chinese markup translation: ${key}`);
  }
  assert.doesNotMatch(javascript, /[一-龥]/, "dynamic browser copy belongs in the translation catalog");
  assert.doesNotMatch(html.replace("简体中文", ""), /[一-龥]/, "English-default markup should contain no stale Chinese UI copy");
});

test("protocol values remain invariant and are never localized", () => {
  for (const value of ["private", "public", "bash", "powershell", "heart", "hello", "wave", "stars"]) {
    assert.match(html, new RegExp(`value=["']${value}["']|data-template=["']${value}["']`));
  }
  assert.match(javascript, /plan\.confirmationPhrase/);
  assert.match(javascript, /confirmation:\s*plan\.confirmationPhrase/);
  assert.match(javascript, /downloadText\(state\.generatedScript, `commit-canvas\.\$\{extension\}`/);
  assert.doesNotMatch(i18nSource, /CREATE \{?\d|commit-canvas-managed|X-Commit-Canvas-CSRF/);
  for (const zone of ["UTC", "Asia/Singapore", "America/New_York"]) assert.match(javascript, new RegExp(`'${zone}'`));
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
  assert.match(html, /A manual snapshot is not live data/);
  assert.match(html, /offline fallback/i);
  assert.equal(CATALOGS["zh-Hans"]["snapshot.stale"].includes("手动快照不是实时数据"), true);
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
  assert.match(html, /real remote write|really writes to a remote repository/i);
  assert.match(html, /Advanced offline fallback/);
  assert.match(CATALOGS["zh-Hans"]["live.warning.title"], /真实的远程写入/);
  assert.match(CATALOGS["zh-Hans"]["export.heading"], /高级离线后备/);
});

test("documented snapshot outputs use the ignored private-data suffix", () => {
  const documentedOutputs = [...readme.matchAll(/--output\s+(\S+)/g)].map((match) => match[1]);
  assert.ok(documentedOutputs.length > 0, "README should document an explicit snapshot output path");
  for (const output of documentedOutputs) {
    assert.match(output, /\.commit-canvas-snapshot\.json$/);
  }
  assert.match(gitignore, /^\*\.commit-canvas-snapshot\.json$/m);
});

test("downloaded design archives are ignored by their generated filename", () => {
  assert.match(javascript, /`commit-canvas-\$\{elements\.endDate\.value\}\.json`/);
  assert.match(gitignore, /^commit-canvas-\?\?\?\?-\?\?-\?\?\.json$/m);
});

test("all backend progress phases have localized labels", () => {
  for (const phase of ["queued", "validating", "validating repository", "creating commits", "complete", "pushed to GitHub", "failed"]) {
    assert.equal(typeof CATALOGS.en[`phase.${phase}`], "string");
    assert.equal(typeof CATALOGS["zh-Hans"][`phase.${phase}`], "string");
  }
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
    "GitHub contributions not checked, 3 planned additions",
  );
  assert.equal(
    contributionCellLabel(true, 0, 3),
    "GitHub already has 0 contributions, 3 planned additions",
  );
  assert.equal(
    contributionCellLabel(true, 7, 0),
    "GitHub already has 7 contributions, 0 planned additions",
  );
  assert.equal(
    contributionCellLabel(false, 0, 3, "zh-Hans"),
    "当前 GitHub 贡献未检查，计划新增 3 次",
  );
  assert.equal(
    contributionCellLabel(true, 0, 3, "zh-Hans"),
    "GitHub 已有 0 次贡献，计划新增 3 次",
  );
  assert.equal(
    contributionCellLabel(true, 7, 0, "zh-Hans"),
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
  assert.match(CATALOGS.en["live.result.confirmed"], /update is confirmed/);
  assert.match(CATALOGS.en["live.result.indexing"], /up to 24 hours/);
  assert.match(CATALOGS["zh-Hans"]["live.result.confirmed"], /GitHub 贡献墙已确认更新/);
  assert.match(CATALOGS["zh-Hans"]["live.result.indexing"], /最长可能 24 小时/);
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
  assert.match(CATALOGS.en["live.pollInterrupted"], /does not mean the task failed/);
  assert.match(CATALOGS["zh-Hans"]["live.pollInterrupted"], /这不表示任务失败/);
  assert.match(javascript, /completed\.status === 'failed'/);
  assert.match(javascript, /ui\.t\('live\.countDetails'/);
  assert.match(CATALOGS.en["live.result.none"], /no new commit was created/);
  assert.match(CATALOGS.en["live.result.partial"], /Some commits were skipped/);
  assert.match(CATALOGS["zh-Hans"]["live.result.none"], /没有创建新提交/);
  assert.match(CATALOGS["zh-Hans"]["live.result.partial"], /部分提交被跳过/);
});

test("an unresolved accepted job blocks new writes and a missing local job remains explicitly unknown", () => {
  assert.match(javascript, /elements\.submitLive\.disabled[\s\S]{0,160}state\.pendingJobId/);
  assert.match(javascript, /if \(state\.pendingJobId\)[\s\S]{0,240}live\.pendingBlocked/);
  assert.match(javascript, /if \(state\.submitting \|\| state\.pendingJobId \|\| !plan\) return/);
  assert.match(javascript, /error\?\.status === 404/);
  assert.match(CATALOGS.en["live.taskLost"], /does not mean the remote operation failed/);
  assert.match(CATALOGS.en["live.dismiss.body"], /does not cancel, undo, or determine the remote task/);
  assert.match(CATALOGS["zh-Hans"]["live.taskLost"], /这不表示远端失败/);
  assert.match(CATALOGS["zh-Hans"]["live.dismiss.body"], /不会取消、撤销或判断远端任务/);
});

test("reload completion without submission context reports facts without clearing the canvas", () => {
  assert.match(javascript, /if \(context\) \{[\s\S]*?submittedDates[\s\S]*?restoreLevels\(state\.levels\)[\s\S]*?\}/);
  assert.match(javascript, /const detailsForLocale = \(\) => \{[\s\S]*?ui\.t\('live\.countDetails'/);
  assert.match(javascript, /const resultUrl = completed\.result\?\.commitUrl/);
});

test("language changes preserve and retranslate dynamic live status descriptors", () => {
  assert.doesNotMatch(html.match(/<p\b[^>]*id=["']live-submit-status["'][^>]*>/i)?.[0] ?? "", /data-i18n=/i);
  assert.match(javascript, /let liveStatusDescriptor = \{ key: 'live\.status\.initial'/);
  assert.match(javascript, /function setLiveStatusKey\(/);
  assert.match(javascript, /function renderLiveStatusDescriptor\(/);
  assert.match(javascript, /localizeDocument\(document, ui\)[\s\S]{0,700}renderLiveStatusDescriptor\(\)/);
  assert.match(javascript, /setLiveStatusKey\('live\.taskLost'/);
  assert.match(javascript, /setLiveStatusKey\(messageKey, \(\) => \(\{ details: detailsForLocale\(\) \}\)/);
  assert.match(javascript, /function applyLocale\(locale\) \{[\s\S]{0,160}elements\.toast\.classList\.remove\('is-visible'\)/);
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
  const selectedLanguage = darkRules.match(/\.language-switcher button\[aria-pressed="true"\]\s*\{([^}]*)\}/i)?.[1] ?? "";
  const languageInk = selectedLanguage.match(/color:\s*#([0-9a-f]{6})/i)?.[1];
  const languageBackground = selectedLanguage.match(/background:\s*#([0-9a-f]{6})/i)?.[1];
  assert.ok(languageInk && languageBackground);
  assert.ok(contrastRatio(languageInk, languageBackground) >= 4.5, "selected language needs dark-mode contrast");

  const headerRule = css.match(/\.site-header\s*\{([^}]*)\}/i)?.[1] ?? "";
  const headerToolsRule = css.match(/\.header-tools\s*\{([^}]*)\}/i)?.[1] ?? "";
  const languageRule = css.match(/\.language-switcher\s*\{([^}]*)\}/i)?.[1] ?? "";
  assert.match(headerRule, /flex-wrap:\s*wrap/i, "the header should wrap under high zoom");
  assert.match(headerToolsRule, /flex-wrap:\s*wrap/i, "header controls should wrap rather than clip");
  assert.match(headerToolsRule, /max-width:\s*100%/i);
  assert.match(languageRule, /flex-wrap:\s*wrap/i, "language controls should fit very narrow viewports");
  assert.match(languageRule, /max-width:\s*100%/i);

  const forcedColorsRules = css.match(/@media\s*\(forced-colors:\s*active\)\s*\{([\s\S]*?)\n\}/i)?.[1] ?? "";
  assert.match(forcedColorsRules, /\.language-switcher button\[aria-pressed="true"\]/i);
  assert.match(forcedColorsRules, /forced-color-adjust:\s*none/i);
});
