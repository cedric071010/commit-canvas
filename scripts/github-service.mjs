import { spawn } from "node:child_process";

import {
  GRAPHQL_QUERY,
  buildSnapshot,
  rangeStartFor,
  splitQueryRanges,
} from "./github-snapshot.mjs";

export const MANAGEMENT_MARKER = "[commit-canvas-managed:v1]";

const MAX_COMMITS = 500;
const MAX_HISTORY_COMMITS = 2_000;
const MANAGEMENT_FILE_PATH = "/contents/.commit-canvas-managed";
const MANAGEMENT_FILE_CONTENT = "Managed by Commit Canvas.\n";
const FRESH_SPLIT_BASE_DAYS = 140;
const FRESH_SPLIT_SLOTS = 90;
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const REPOSITORY_NAME_PATTERN = /^commit-canvas(?:-[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?)?$/;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/;
const MARKER_PATTERN = /^\[contribution-art:([A-Za-z0-9._-]{1,64}):(\d{4}-\d{2}-\d{2}):([1-9]\d{0,2})\]$/;
const MESSAGE_PATTERN = /^Contribution art (\d{4}-\d{2}-\d{2}) \(([1-9]\d{0,2})\/([1-9]\d{0,2})\) (\[contribution-art:[A-Za-z0-9._-]{1,64}:\d{4}-\d{2}-\d{2}:[1-9]\d{0,2}\])$/;
const MARKER_SEARCH_PATTERN = /\[contribution-art:[A-Za-z0-9._-]{1,64}:\d{4}-\d{2}-\d{2}:[1-9]\d{0,2}\]/;

export class GitHubServiceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GitHubServiceError";
    this.code = code;
  }
}

export function defaultRunner(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: null, stdout, stderr, error }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(options.input ?? "");
  });
}

function serviceError(code, message) {
  return new GitHubServiceError(code, message);
}

function safeObject(value, message = "GitHub returned an invalid response") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw serviceError("INVALID_RESPONSE", message);
  return value;
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw serviceError("INVALID_RESPONSE", "GitHub returned invalid JSON");
  }
}

function responseCode(result) {
  if (Number.isInteger(result?.httpStatus)) return result.httpStatus;
  const match = /(?:HTTP|status(?: code)?)\s*[:=]?\s*(\d{3})\b/i.exec(String(result?.stderr ?? ""));
  return match ? Number(match[1]) : undefined;
}

async function runGh(args, options, dependencies) {
  const runner = dependencies?.runner ?? defaultRunner;
  let result;
  try {
    result = await runner("gh", args, options);
  } catch {
    throw serviceError("CLI_UNAVAILABLE", "Unable to run GitHub CLI");
  }
  if (result?.error) {
    const code = result.error.code === "ENOENT" ? "CLI_UNAVAILABLE" : "CLI_FAILED";
    throw serviceError(code, code === "CLI_UNAVAILABLE" ? "GitHub CLI is not available" : "Unable to run GitHub CLI");
  }
  const exitCode = result?.code ?? result?.status;
  if (exitCode !== 0) {
    const error = serviceError("GITHUB_REQUEST_FAILED", "GitHub request failed; check GitHub CLI authentication and permissions");
    error.httpStatus = responseCode(result);
    throw error;
  }
  return parseJson(String(result.stdout ?? ""));
}

async function api(endpoint, { method = "GET", body } = {}, dependencies = {}) {
  const args = ["api", endpoint, "--method", method, "--hostname", "github.com"];
  const options = {};
  if (body !== undefined) {
    args.push("--input", "-");
    options.input = JSON.stringify(body);
  }
  return runGh(args, options, dependencies);
}

function assertLogin(login, label = "account") {
  if (typeof login !== "string" || !LOGIN_PATTERN.test(login)) {
    throw serviceError("INVALID_INPUT", `${label} is invalid`);
  }
  return login;
}

function assertSha(sha, label = "commit SHA") {
  if (typeof sha !== "string" || !SHA_PATTERN.test(sha)) {
    throw serviceError("INVALID_INPUT", `${label} is invalid`);
  }
  return sha;
}

function repositoryParts(fullName) {
  if (typeof fullName !== "string") throw serviceError("INVALID_INPUT", "repository is invalid");
  const parts = fullName.split("/");
  if (parts.length !== 2 || !LOGIN_PATTERN.test(parts[0]) || !/^[A-Za-z0-9._-]{1,100}$/.test(parts[1])) {
    throw serviceError("INVALID_INPUT", "repository is invalid");
  }
  return parts;
}

function assertBranch(branch, label = "default branch") {
  if (typeof branch !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9._\/-]{0,253})$/.test(branch)) {
    throw serviceError("INVALID_INPUT", `${label} is invalid`);
  }
  return branch;
}

function endpointFor(fullName, suffix = "") {
  const [owner, name] = repositoryParts(fullName);
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}${suffix}`;
}

export async function getSession(dependencies = {}) {
  const viewer = safeObject(await api("/user", {}, dependencies));
  const login = assertLogin(viewer.login, "authenticated account");
  if (!Number.isSafeInteger(viewer.id) || viewer.id <= 0) {
    throw serviceError("INVALID_RESPONSE", "GitHub returned an invalid account id");
  }
  if (viewer.name !== null && viewer.name !== undefined && typeof viewer.name !== "string") {
    throw serviceError("INVALID_RESPONSE", "GitHub returned an invalid account name");
  }
  return {
    login,
    id: viewer.id,
    name: viewer.name?.trim() || login,
    noreplyEmail: `${viewer.id}+${login}@users.noreply.github.com`,
  };
}

function shiftIsoDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) throw serviceError("INVALID_INPUT", "end date is invalid");
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function contributionPayload(range, dependencies) {
  const args = [
    "api", "graphql", "--method", "POST", "--hostname", "github.com", "--input", "-",
  ];
  const body = {
    query: GRAPHQL_QUERY,
    variables: {
      from: `${range.rangeStart}T00:00:00Z`,
      to: `${range.rangeEnd}T23:59:59Z`,
    },
  };
  return runGh(args, { input: JSON.stringify(body) }, dependencies);
}

export async function getContributionSnapshot(endDate, dependencies = {}, options = {}) {
  const rangeStart = rangeStartFor(endDate);
  const payloads = [];
  for (const range of splitQueryRanges(rangeStart, endDate)) {
    payloads.push(await contributionPayload(range, dependencies));
  }
  if (Number.isSafeInteger(options.freshnessSlot) && options.freshnessSlot >= 0) {
    // GitHub can briefly cache an identical ContributionCalendar range after
    // a push. Re-query the complete grid as two differently split ranges so
    // every day receives a fresh value, including commits near the old edge
    // of the 53-week canvas. Both halves remain well below GitHub's 365-day
    // range limit while their boundaries change on each refresh.
    const splitOffset = FRESH_SPLIT_BASE_DAYS + (options.freshnessSlot % FRESH_SPLIT_SLOTS);
    const freshFirstEnd = shiftIsoDate(rangeStart, splitOffset);
    const freshSecondStart = shiftIsoDate(freshFirstEnd, 1);
    payloads.push(await contributionPayload({
      rangeStart,
      rangeEnd: freshFirstEnd,
    }, dependencies));
    payloads.push(await contributionPayload({
      rangeStart: freshSecondStart,
      rangeEnd: endDate,
    }, dependencies));
  }
  return buildSnapshot(payloads, endDate, (dependencies.now ?? new Date()).toISOString());
}

function assertRepositoryGates(repo, viewerLogin) {
  safeObject(repo);
  const owner = assertLogin(repo.owner?.login, "repository owner");
  if (owner.toLowerCase() !== viewerLogin.toLowerCase()) throw serviceError("UNMANAGED_REPOSITORY", "Repository is not owned by the authenticated account");
  if (typeof repo.name !== "string" || !REPOSITORY_NAME_PATTERN.test(repo.name)) {
    throw serviceError("UNMANAGED_REPOSITORY", "Repository name is outside the Commit Canvas managed namespace");
  }
  if (repo.fork !== false) throw serviceError("UNMANAGED_REPOSITORY", "Fork repositories are not supported");
  if (repo.archived !== false) throw serviceError("UNMANAGED_REPOSITORY", "Archived repositories are not supported");
  if (repo.permissions?.admin !== true || repo.permissions?.push !== true) {
    throw serviceError("INSUFFICIENT_PERMISSION", "Repository requires admin and push permission");
  }
  if (typeof repo.default_branch !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9._\/-]{0,253})$/.test(repo.default_branch)) {
    throw serviceError("UNMANAGED_REPOSITORY", "Repository does not have a valid default branch");
  }
  if (typeof repo.full_name !== "string" || repo.full_name.toLowerCase() !== `${owner}/${repo.name}`.toLowerCase()) {
    throw serviceError("INVALID_RESPONSE", "GitHub returned invalid repository metadata");
  }
}

async function readHead(fullName, branch, dependencies) {
  const ref = safeObject(await api(endpointFor(fullName, `/git/ref/heads/${encodeURIComponent(branch)}`), {}, dependencies));
  const sha = ref.object?.sha;
  if (ref.object?.type !== "commit" || !SHA_PATTERN.test(sha)) throw serviceError("INVALID_RESPONSE", "GitHub returned an invalid branch head");
  return sha;
}

async function validateManagementFile(fullName, branch, dependencies) {
  let file;
  try {
    file = safeObject(await api(
      endpointFor(fullName, `${MANAGEMENT_FILE_PATH}?ref=${encodeURIComponent(branch)}`),
      {},
      dependencies,
    ));
  } catch (error) {
    if (error instanceof GitHubServiceError && error.httpStatus === 404) {
      throw serviceError("UNMANAGED_REPOSITORY", "Repository management file is missing");
    }
    throw error;
  }
  if (file.type !== "file" || file.encoding !== "base64" || typeof file.content !== "string") {
    throw serviceError("UNMANAGED_REPOSITORY", "Repository management file is invalid");
  }
  const compact = file.content.replaceAll("\n", "");
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)) {
    throw serviceError("UNMANAGED_REPOSITORY", "Repository management file is invalid");
  }
  const content = Buffer.from(compact, "base64").toString("utf8");
  if (content !== MANAGEMENT_FILE_CONTENT) {
    throw serviceError("UNMANAGED_REPOSITORY", "Repository management file is invalid");
  }
}

async function reachableHistory(fullName, head, dependencies) {
  const markers = new Set();
  let tree;
  let previous;
  let lastItem;
  let inspected = 0;
  for (let page = 1; inspected < MAX_HISTORY_COMMITS; page += 1) {
    const query = `?sha=${encodeURIComponent(head)}&per_page=100&page=${page}`;
    const commits = await api(endpointFor(fullName, `/commits${query}`), {}, dependencies);
    if (!Array.isArray(commits)) throw serviceError("INVALID_RESPONSE", "GitHub returned invalid commit history");
    if (commits.length === 0) break;
    if (commits.length > 100) throw serviceError("INVALID_RESPONSE", "GitHub returned an oversized commit history page");
    for (const item of commits) {
      safeObject(item, "GitHub returned invalid commit history");
      if (!SHA_PATTERN.test(item.sha) || !Array.isArray(item.parents) || item.parents.length > 1) {
        throw serviceError("UNMANAGED_REPOSITORY", "Managed repository history must be linear");
      }
      const itemTree = item.commit?.tree?.sha;
      const message = item.commit?.message;
      if (!SHA_PATTERN.test(itemTree) || typeof message !== "string") {
        throw serviceError("INVALID_RESPONSE", "GitHub returned invalid commit metadata");
      }
      if (previous && previous.parents[0]?.sha !== item.sha) {
        throw serviceError("INVALID_RESPONSE", "GitHub returned discontinuous commit history");
      }
      if (item.parents[0] !== undefined && !SHA_PATTERN.test(item.parents[0]?.sha)) {
        throw serviceError("INVALID_RESPONSE", "GitHub returned invalid commit ancestry");
      }
      if (inspected === 0 && item.sha !== head) {
        throw serviceError("INVALID_RESPONSE", "GitHub returned history for an unexpected head");
      }
      tree ??= itemTree;
      const marker = MARKER_SEARCH_PATTERN.exec(message)?.[0];
      if (marker) markers.add(marker);
      inspected += 1;
      lastItem = item;
      if (inspected >= MAX_HISTORY_COMMITS) break;
      previous = item;
    }
    if (commits.length < 100) return { tree, markers, historyTruncated: false };
  }
  if (tree) return { tree, markers, historyTruncated: lastItem?.parents.length === 1 };
  throw serviceError("UNMANAGED_REPOSITORY", "Repository history is empty");
}

export async function validateManagedRepository(fullName, dependencies = {}) {
  repositoryParts(fullName);
  const session = await getSession(dependencies);
  const repo = safeObject(await api(endpointFor(fullName), {}, dependencies));
  assertRepositoryGates(repo, session.login);
  await validateManagementFile(repo.full_name, repo.default_branch, dependencies);
  const head = await readHead(repo.full_name, repo.default_branch, dependencies);
  const history = await reachableHistory(repo.full_name, head, dependencies);
  const result = {
    fullName: repo.full_name,
    owner: repo.owner.login,
    name: repo.name,
    visibility: repo.visibility === "private" || repo.private === true ? "private" : (repo.visibility ?? "public"),
    defaultBranch: repo.default_branch,
    head,
    htmlUrl: typeof repo.html_url === "string" ? repo.html_url : `https://github.com/${repo.full_name}`,
  };
  Object.defineProperty(result, "internal", {
    value: {
      tree: history.tree,
      session,
      reachableMarkers: history.markers,
      historyTruncated: history.historyTruncated,
    },
    enumerable: false,
  });
  return result;
}

async function initializeRepository(fullName, branch, dependencies) {
  assertBranch(branch);
  // GitHub's refs API cannot create the first branch in an empty repository.
  // The Contents API can, so seed one plainly identified management file with
  // a deliberately unassociated identity. This setup commit therefore does not
  // become a contribution for the connected user.
  const initializer = {
    name: "Commit Canvas initializer",
    email: "commit-canvas-initializer@example.invalid",
  };
  const result = safeObject(await api(endpointFor(fullName, "/contents/.commit-canvas-managed"), {
    method: "PUT",
    body: {
      message: MANAGEMENT_MARKER,
      content: Buffer.from(MANAGEMENT_FILE_CONTENT, "utf8").toString("base64"),
      branch,
      author: initializer,
      committer: initializer,
    },
  }, dependencies));
  assertSha(result.commit?.sha, "initial commit SHA");
}

export async function createOrGetManagedRepository(name, visibility = "public", dependencies = {}) {
  if (typeof name !== "string" || !REPOSITORY_NAME_PATTERN.test(name)) {
    throw serviceError("INVALID_INPUT", "Repository name must use the commit-canvas prefix and conservative lowercase characters");
  }
  if (visibility !== "public" && visibility !== "private") throw serviceError("INVALID_INPUT", "Repository visibility is invalid");
  const session = await getSession(dependencies);
  const fullName = `${session.login}/${name}`;
  try {
    await api(endpointFor(fullName), {}, dependencies);
    return validateManagedRepository(fullName, dependencies);
  } catch (error) {
    if (!(error instanceof GitHubServiceError) || error.httpStatus !== 404) throw error;
  }
  const created = safeObject(await api("/user/repos", {
    method: "POST",
    body: { name, visibility, auto_init: false },
  }, dependencies));
  if (created.full_name?.toLowerCase() !== fullName.toLowerCase() || created.fork === true) {
    throw serviceError("INVALID_RESPONSE", "GitHub created an unexpected repository");
  }
  await initializeRepository(fullName, created.default_branch, dependencies);
  return validateManagedRepository(fullName, dependencies);
}

function validatePlan(plan) {
  const entries = Array.isArray(plan) ? plan : plan?.commits;
  if (!Array.isArray(entries) || entries.length === 0) throw serviceError("INVALID_PLAN", "Plan must contain at least one commit");
  if (entries.length > MAX_COMMITS) throw serviceError("INVALID_PLAN", `Plan exceeds the ${MAX_COMMITS} commit limit`);
  const markers = new Set();
  const groups = new Map();
  let exportId;
  let previousTimestamp = "";
  const normalized = entries.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).sort().join(",") !== "marker,message,timestamp") {
      throw serviceError("INVALID_PLAN", "Plan entries must contain only marker, message, and timestamp");
    }
    if (typeof entry.timestamp !== "string" || !TIMESTAMP_PATTERN.test(entry.timestamp) || Number.isNaN(Date.parse(entry.timestamp))) {
      throw serviceError("INVALID_PLAN", "Plan contains an invalid timestamp");
    }
    const markerMatch = typeof entry.marker === "string" ? MARKER_PATTERN.exec(entry.marker) : null;
    const messageMatch = typeof entry.message === "string" ? MESSAGE_PATTERN.exec(entry.message) : null;
    if (!markerMatch || !messageMatch || messageMatch[1] !== markerMatch[2] || messageMatch[2] !== markerMatch[3] || messageMatch[4] !== entry.marker) {
      throw serviceError("INVALID_PLAN", "Plan contains a non-canonical contribution marker or message");
    }
    const sequence = Number(messageMatch[2]);
    const total = Number(messageMatch[3]);
    if (sequence > total || total > MAX_COMMITS || markers.has(entry.marker)) throw serviceError("INVALID_PLAN", "Plan contains an invalid or duplicate sequence");
    if (entry.timestamp.slice(0, 10) !== markerMatch[2]) throw serviceError("INVALID_PLAN", "Plan timestamp and marker date disagree");
    exportId ??= markerMatch[1];
    if (exportId !== markerMatch[1]) throw serviceError("INVALID_PLAN", "Plan contains inconsistent export identifiers");
    const group = groups.get(markerMatch[2]) ?? { total, sequences: [] };
    if (group.total !== total) throw serviceError("INVALID_PLAN", "Plan contains inconsistent daily totals");
    group.sequences.push(sequence);
    groups.set(markerMatch[2], group);
    if (previousTimestamp && Date.parse(entry.timestamp) < Date.parse(previousTimestamp)) throw serviceError("INVALID_PLAN", "Plan timestamps must be chronological");
    previousTimestamp = entry.timestamp;
    markers.add(entry.marker);
    return { ...entry };
  });
  for (const group of groups.values()) {
    group.sequences.sort((left, right) => left - right);
    if (group.sequences.length !== group.total || group.sequences.some((sequence, index) => sequence !== index + 1)) {
      throw serviceError("INVALID_PLAN", "Plan daily sequences must be complete and canonical");
    }
  }
  return normalized;
}

async function progress(callback, value) {
  if (callback) await callback(Object.freeze(value));
}

export async function submitPlan(request, dependencies = {}) {
  if (!request || typeof request !== "object" || Array.isArray(request)) throw serviceError("INVALID_INPUT", "Submission is invalid");
  const { repository, expectedHead, expectedDefaultBranch, plan, expectedAccount, onProgress } = request;
  if (onProgress !== undefined && typeof onProgress !== "function") throw serviceError("INVALID_INPUT", "onProgress must be a function");
  assertLogin(expectedAccount, "expected account");
  assertSha(expectedHead, "expected head");
  assertBranch(expectedDefaultBranch, "expected default branch");
  const fullName = typeof repository === "string" ? repository : repository?.fullName;
  repositoryParts(fullName);
  const commits = validatePlan(plan);
  await progress(onProgress, { phase: "validating", total: commits.length, created: 0, skipped: 0 });
  const managed = await validateManagedRepository(fullName, dependencies);
  if (managed.internal.session.login.toLowerCase() !== expectedAccount.toLowerCase()) throw serviceError("ACCOUNT_CHANGED", "Authenticated GitHub account changed");
  if (managed.defaultBranch !== expectedDefaultBranch) throw serviceError("DEFAULT_BRANCH_CHANGED", "Repository default branch changed; refresh before submitting");
  if (managed.head !== expectedHead) throw serviceError("HEAD_MOVED", "Repository head changed; refresh before submitting");
  if (managed.internal.historyTruncated) {
    throw serviceError("HISTORY_LIMIT_REACHED", "Repository history exceeds the safe writable limit; create a new managed repository");
  }

  let parent = managed.head;
  let created = 0;
  let skipped = 0;
  for (let index = 0; index < commits.length; index += 1) {
    const item = commits[index];
    if (managed.internal.reachableMarkers.has(item.marker)) {
      skipped += 1;
    } else {
      const identity = {
        name: managed.internal.session.name,
        email: managed.internal.session.noreplyEmail,
        date: item.timestamp,
      };
      const result = safeObject(await api(endpointFor(managed.fullName, "/git/commits"), {
        method: "POST",
        body: {
          message: item.message,
          tree: managed.internal.tree,
          parents: [parent],
          author: identity,
          committer: identity,
        },
      }, dependencies));
      parent = assertSha(result.sha);
      created += 1;
    }
    await progress(onProgress, { phase: "creating commits", completed: index + 1, total: commits.length, created, skipped });
  }

  if (created > 0) {
    const finalSession = await getSession(dependencies);
    if (finalSession.login.toLowerCase() !== expectedAccount.toLowerCase()) {
      throw serviceError("ACCOUNT_CHANGED", "Authenticated GitHub account changed; submission was not published");
    }
    const finalRepository = safeObject(await api(endpointFor(managed.fullName), {}, dependencies));
    assertRepositoryGates(finalRepository, finalSession.login);
    if (finalRepository.default_branch !== expectedDefaultBranch) {
      throw serviceError("DEFAULT_BRANCH_CHANGED", "Repository default branch changed; submission was not published");
    }
    await validateManagementFile(managed.fullName, expectedDefaultBranch, dependencies);
    const currentHead = await readHead(managed.fullName, managed.defaultBranch, dependencies);
    if (currentHead !== managed.head) throw serviceError("HEAD_MOVED", "Repository head changed; submission was not published");
    try {
      await api(endpointFor(managed.fullName, `/git/refs/heads/${encodeURIComponent(managed.defaultBranch)}`), {
        method: "PATCH",
        body: { sha: parent, force: false },
      }, dependencies);
    } catch (updateError) {
      const observedHead = await readHead(managed.fullName, managed.defaultBranch, dependencies);
      if (observedHead !== parent) {
        if (observedHead === managed.head) throw updateError;
        throw serviceError("AMBIGUOUS_REF_UPDATE", "Repository head changed during an ambiguous publication attempt; inspect the repository before retrying");
      }
    }
  }
  await progress(onProgress, { phase: "complete", total: commits.length, created, skipped });
  return {
    repository: managed.fullName,
    oldHead: managed.head,
    newHead: parent,
    created,
    skipped,
    commitUrl: `${managed.htmlUrl}/commit/${parent}`,
  };
}

export function createGithubService(dependencies = {}) {
  let freshnessSlot = Math.floor(Date.now() / 1_000) % FRESH_SPLIT_SLOTS;
  return Object.freeze({
    getSession: () => getSession(dependencies),
    getContributionSnapshot: (endDate) =>
      getContributionSnapshot(endDate, dependencies, { freshnessSlot: freshnessSlot++ }),
    createOrGetManagedRepository: (name, visibility) =>
      createOrGetManagedRepository(name, visibility, dependencies),
    validateManagedRepository: (fullName) => validateManagedRepository(fullName, dependencies),
    submitPlan: (request) => submitPlan(request, dependencies),
  });
}
