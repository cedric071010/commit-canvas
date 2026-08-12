import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const [html, javascript, css] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../src/app.js", import.meta.url), "utf8"),
  readFile(new URL("../styles.css", import.meta.url), "utf8"),
]);

function tags(name) {
  return [...html.matchAll(new RegExp(`<${name}\\b([^>]*)>`, "gi"))].map((match) => match[1]);
}

function attribute(attributes, name) {
  return attributes.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
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
