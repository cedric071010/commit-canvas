#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import * as core from "../src/core.js";

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_JSON_BYTES = 256 * 1024;
const MAX_JOBS = 20;
const PUBLIC_PATHS = new Set(["/index.html", "/styles.css", "/src/app.js", "/src/core.js", "/src/i18n.js"]);
const SERVICE_ERROR_CODES = new Set([
  "ACCOUNT_CHANGED",
  "AMBIGUOUS_REF_UPDATE",
  "CLI_FAILED",
  "CLI_UNAVAILABLE",
  "DEFAULT_BRANCH_CHANGED",
  "GITHUB_REQUEST_FAILED",
  "HEAD_MOVED",
  "HISTORY_LIMIT_REACHED",
  "INSUFFICIENT_PERMISSION",
  "INVALID_INPUT",
  "INVALID_PLAN",
  "INVALID_RESPONSE",
  "UNMANAGED_REPOSITORY",
]);
const COMPANION_ERROR_CODES = new Set([
  "ACCOUNT_MISMATCH",
  "API_NOT_FOUND",
  "CONFIRMATION_MISMATCH",
  "INTERNAL_ERROR",
  "JOB_NOT_FOUND",
  "LIVE_UNAVAILABLE",
  "PAYLOAD_TOO_LARGE",
  "REPOSITORY_CHANGED",
  "REQUEST_FORBIDDEN",
  "REQUEST_INVALID",
  "SUBMISSION_ACTIVE",
  "UNSUPPORTED_MEDIA_TYPE",
]);

const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".gif", "image/gif"],
  [".htm", "text/html; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".webp", "image/webp"],
]);

const securityHeaders = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
};

export function parsePort(value) {
  if (value === undefined || value === "") return 4173;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError(`PORT must be an integer from 1 to 65535; received ${value}`);
  }
  return parsed;
}

function errorMessage(error) {
  if (!(error instanceof Error) || !error.message) return "Request failed";
  return error.message.replace(/[\r\n\t]+/g, " ").slice(0, 300);
}

function codedError(code, message, statusCode) {
  const error = new Error(message);
  error.apiCode = code;
  if (statusCode !== undefined) error.statusCode = statusCode;
  return error;
}

function apiErrorPayload(error, explicitCode) {
  const candidate = explicitCode ?? error?.apiCode ?? error?.code;
  let code;
  if (COMPANION_ERROR_CODES.has(candidate) || SERVICE_ERROR_CODES.has(candidate)) {
    code = candidate;
  } else if (error instanceof URIError || error instanceof SyntaxError || error instanceof TypeError || error instanceof RangeError) {
    code = "REQUEST_INVALID";
  } else {
    code = "INTERNAL_ERROR";
  }
  return { code };
}

function json(response, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  response.writeHead(status, {
    ...securityHeaders,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function text(response, status, body = "") {
  response.writeHead(status, {
    ...securityHeaders,
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function apiError(response, status, error, code) {
  json(response, status, { error: apiErrorPayload(error, code) });
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw codedError("REQUEST_INVALID", `${label} must be a JSON object`);
  }
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  if (actual.length !== allowed.length || actual.some((key, index) => key !== allowed[index])) {
    throw codedError("REQUEST_INVALID", `${label} contains missing or unknown fields`);
  }
}

async function readJson(request) {
  const mediaType = String(request.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw codedError("UNSUPPORTED_MEDIA_TYPE", "Content-Type must be application/json", 415);
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) {
      throw codedError("PAYLOAD_TOO_LARGE", `JSON body exceeds ${MAX_JSON_BYTES} bytes`, 413);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw codedError("REQUEST_INVALID", "Request body is not valid JSON", 400);
  }
}

function isAllowedHost(host) {
  return /^127\.0\.0\.1:\d{1,5}$/.test(host);
}

function requireTrustedRequest(request, csrfToken) {
  const host = String(request.headers.host ?? "");
  if (!isAllowedHost(host)) {
    throw codedError("REQUEST_FORBIDDEN", "Untrusted Host header", 403);
  }
  if (request.method === "POST") {
    if (request.headers.origin !== `http://${host}`) {
      throw codedError("REQUEST_FORBIDDEN", "Untrusted request origin", 403);
    }
    if (request.headers["x-commit-canvas-csrf"] !== csrfToken) {
      throw codedError("REQUEST_FORBIDDEN", "Missing or invalid request token", 403);
    }
  }
}

function publicJob(job) {
  const output = {
    id: job.id,
    status: job.status,
    phase: job.phase,
    completed: job.completed,
    total: job.total,
    created: job.created,
    skipped: job.skipped,
  };
  if (job.result) output.result = job.result;
  if (job.error) output.error = job.error;
  return output;
}

function normalizeProgress(job, progress) {
  if (typeof progress === "number" && Number.isFinite(progress)) {
    job.completed = Math.max(0, Math.min(job.total, Math.trunc(progress)));
    return;
  }
  if (!progress || typeof progress !== "object") return;
  if (typeof progress.phase === "string") job.phase = progress.phase.slice(0, 80);
  for (const key of ["completed", "created", "skipped"]) {
    if (Number.isSafeInteger(progress[key]) && progress[key] >= 0) job[key] = progress[key];
  }
}

function pruneJobs(jobs) {
  while (jobs.size > MAX_JOBS) {
    const finished = [...jobs].find(([, job]) => job.status === "succeeded" || job.status === "failed");
    if (!finished) return;
    jobs.delete(finished[0]);
  }
}

async function serveStatic({ request, response, root, realRoot }) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    text(response, 405, "Method Not Allowed\n");
    return;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  const pathname = decodeURIComponent(url.pathname);
  if (pathname.includes("\0")) {
    text(response, 400, "Bad Request\n");
    return;
  }
  if (pathname.split("/").some((segment) => segment.startsWith("."))) {
    text(response, 404, "Not Found\n");
    return;
  }

  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  if (!PUBLIC_PATHS.has(requestedPath)) {
    text(response, 404, "Not Found\n");
    return;
  }
  const candidate = resolve(root, `.${requestedPath.split("/").join(sep)}`);
  const offset = relative(root, candidate);
  if (offset.startsWith(`..${sep}`) || offset === ".." || isAbsolute(offset)) {
    text(response, 403, "Forbidden\n");
    return;
  }

  let filePath;
  try {
    filePath = await realpath(candidate);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      text(response, 404, "Not Found\n");
      return;
    }
    throw error;
  }
  const realOffset = relative(realRoot, filePath);
  const withinRoot = realOffset === "" || (!realOffset.startsWith(`..${sep}`) && realOffset !== ".." && !isAbsolute(realOffset));
  if (!withinRoot || !(await stat(filePath)).isFile()) {
    text(response, 404, "Not Found\n");
    return;
  }

  const body = await readFile(filePath);
  response.writeHead(200, {
    ...securityHeaders,
    "Content-Type": mimeTypes.get(extname(filePath).toLowerCase()) ?? "application/octet-stream",
    "Content-Length": body.byteLength,
  });
  response.end(request.method === "HEAD" ? undefined : body);
}

export async function createCommitCanvasServer({
  root = DEFAULT_ROOT,
  live = false,
  github,
  csrfToken = randomBytes(24).toString("base64url"),
} = {}) {
  const resolvedRoot = resolve(root);
  const realRoot = await realpath(resolvedRoot);
  if (live && !github) throw new TypeError("github service is required in live mode");

  const jobs = new Map();
  let activeJobId = null;

  const server = createServer(async (request, response) => {
    try {
      requireTrustedRequest(request, csrfToken);
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const isApi = requestUrl.pathname === "/api/session" || requestUrl.pathname.startsWith("/api/");
      if (!isApi) {
        await serveStatic({ request, response, root: resolvedRoot, realRoot });
        return;
      }
      if (!live) {
        apiError(response, 404, new Error("Live GitHub mode is available only from the local companion"), "LIVE_UNAVAILABLE");
        return;
      }

      if (requestUrl.pathname === "/api/session" && request.method === "GET") {
        const account = await github.getSession();
        json(response, 200, { live: true, csrfToken, account });
        return;
      }

      if (requestUrl.pathname === "/api/contributions" && request.method === "POST") {
        const body = await readJson(request);
        exactKeys(body, ["endDate"], "contribution request");
        const snapshot = await github.getContributionSnapshot(body.endDate);
        json(response, 200, snapshot);
        return;
      }

      if (requestUrl.pathname === "/api/repository" && request.method === "POST") {
        const body = await readJson(request);
        exactKeys(body, ["name", "visibility"], "repository request");
        const repository = await github.createOrGetManagedRepository(body.name, body.visibility);
        json(response, 200, { repository });
        return;
      }

      if (requestUrl.pathname === "/api/submissions" && request.method === "POST") {
        if (activeJobId && ["queued", "running"].includes(jobs.get(activeJobId)?.status)) {
          apiError(response, 409, new Error("Another submission is still running"), "SUBMISSION_ACTIVE");
          return;
        }
        const body = await readJson(request);
        exactKeys(body, ["confirmation", "design", "expectedDefaultBranch", "expectedHead", "repository"], "submission request");
        const account = await github.getSession();
        const freshSnapshot = await github.getContributionSnapshot(body.design?.endDate);
        if (freshSnapshot.account !== account.login) {
          throw codedError("ACCOUNT_MISMATCH", "Contribution calendar account does not match the authenticated account", 409);
        }
        const plan = core.buildCommitPlan(
          { ...body.design, email: account.noreplyEmail },
          freshSnapshot,
        );
        if (body.confirmation !== plan.confirmationPhrase) {
          throw codedError("CONFIRMATION_MISMATCH", "Confirmation phrase does not match the reviewed plan", 400);
        }
        const repository = await github.validateManagedRepository(body.repository);
        if (repository.defaultBranch !== body.expectedDefaultBranch || repository.head !== body.expectedHead) {
          throw codedError("REPOSITORY_CHANGED", "Repository changed after review; reconnect it and review again", 409);
        }

        const id = randomBytes(16).toString("hex");
        const job = {
          id,
          status: "queued",
          phase: "queued",
          completed: 0,
          total: plan.totalCommits,
          created: 0,
          skipped: 0,
        };
        jobs.set(id, job);
        activeJobId = id;
        pruneJobs(jobs);
        json(response, 202, { job: publicJob(job) });

        queueMicrotask(async () => {
          job.status = "running";
          job.phase = "validating repository";
          try {
            job.result = await github.submitPlan({
              repository: repository.fullName,
              expectedDefaultBranch: body.expectedDefaultBranch,
              expectedHead: repository.head,
              expectedAccount: account.login,
              plan,
              onProgress: (progress) => normalizeProgress(job, progress),
            });
            job.status = "succeeded";
            job.phase = "pushed to GitHub";
            job.completed = job.total;
            if (Number.isSafeInteger(job.result?.created)) job.created = job.result.created;
            if (Number.isSafeInteger(job.result?.skipped)) job.skipped = job.result.skipped;
          } catch (error) {
            job.status = "failed";
            job.phase = "failed";
            job.error = apiErrorPayload(error);
          } finally {
            if (activeJobId === id) activeJobId = null;
          }
        });
        return;
      }

      const jobMatch = /^\/api\/submissions\/([a-f0-9]{32})$/.exec(requestUrl.pathname);
      if (jobMatch && request.method === "GET") {
        if (request.headers["x-commit-canvas-csrf"] !== csrfToken) {
          apiError(response, 403, new Error("Missing or invalid request token"), "REQUEST_FORBIDDEN");
          return;
        }
        const job = jobs.get(jobMatch[1]);
        if (!job) {
          apiError(response, 404, new Error("Submission job was not found"), "JOB_NOT_FOUND");
          return;
        }
        json(response, 200, { job: publicJob(job) });
        return;
      }

      response.setHeader("Allow", "GET, POST");
      apiError(response, 404, new Error("API route was not found"), "API_NOT_FOUND");
    } catch (error) {
      if (error instanceof URIError) {
        apiError(response, 400, error);
        return;
      }
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 400;
      apiError(response, status >= 400 && status <= 599 ? status : 500, error);
    }
  });

  return { server, csrfToken, jobs };
}

function openBrowser(url) {
  if (process.env.COMMIT_CANVAS_NO_OPEN === "1") return;
  const platform = process.platform;
  const command = platform === "win32" ? "cmd" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const live = argv.includes("--live");
  const unknown = argv.filter((argument) => argument !== "--live" && argument !== "--no-open");
  if (unknown.length > 0) throw new TypeError(`Unknown option: ${unknown[0]}`);
  if (argv.includes("--no-open")) process.env.COMMIT_CANVAS_NO_OPEN = "1";
  const port = parsePort(process.env.PORT);
  let github;
  if (live) {
    const serviceModule = dependencies.serviceModule ?? await import("./github-service.mjs");
    github = dependencies.github ?? serviceModule.createGithubService();
  }
  const { server } = await createCommitCanvasServer({ live, github });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  const url = `http://127.0.0.1:${port}`;
  process.stdout.write(
    live
      ? `Commit Canvas live mode is connected through the local GitHub CLI at ${url}\n`
      : `Commit Canvas static preview is available at ${url}\n`,
  );
  if (live) openBrowser(url);
  return server;
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`Unable to start Commit Canvas: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
