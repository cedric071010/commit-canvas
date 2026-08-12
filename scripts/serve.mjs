import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const realRoot = await realpath(root);
const port = parsePort(process.env.PORT);

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
    "connect-src 'none'",
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

function parsePort(value) {
  if (value === undefined || value === "") return 4173;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new TypeError(`PORT must be an integer from 1 to 65535; received ${value}`);
  }
  return parsed;
}

function isWithinRoot(path) {
  const offset = relative(realRoot, path);
  return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !isAbsolute(offset));
}

function respond(response, status, body = "") {
  response.writeHead(status, {
    ...securityHeaders,
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

const server = createServer(async (request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    respond(response, 405, "Method Not Allowed\n");
    return;
  }

  try {
    const url = new URL(request.url ?? "/", "http://localhost");
    const pathname = decodeURIComponent(url.pathname);
    if (pathname.includes("\0")) {
      respond(response, 400, "Bad Request\n");
      return;
    }

    if (pathname.split("/").some((segment) => segment.startsWith("."))) {
      respond(response, 404, "Not Found\n");
      return;
    }

    const requestedPath = pathname === "/" ? "/index.html" : pathname;
    const localPath = requestedPath.split("/").join(sep);
    const candidate = resolve(root, `.${localPath}`);
    const candidateOffset = relative(root, candidate);
    if (
      candidateOffset.startsWith(`..${sep}`) ||
      candidateOffset === ".." ||
      isAbsolute(candidateOffset)
    ) {
      respond(response, 403, "Forbidden\n");
      return;
    }

    let filePath;
    try {
      filePath = await realpath(candidate);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
        respond(response, 404, "Not Found\n");
        return;
      }
      throw error;
    }

    if (!isWithinRoot(filePath) || !(await stat(filePath)).isFile()) {
      respond(response, 404, "Not Found\n");
      return;
    }

    const body = await readFile(filePath);
    response.writeHead(200, {
      ...securityHeaders,
      "Content-Type": mimeTypes.get(extname(filePath).toLowerCase()) ?? "application/octet-stream",
      "Content-Length": body.byteLength,
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    if (error instanceof URIError || error instanceof TypeError) {
      respond(response, 400, "Bad Request\n");
      return;
    }
    console.error(error);
    respond(response, 500, "Internal Server Error\n");
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Commit Canvas is available at http://127.0.0.1:${port}`);
});
