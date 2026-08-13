import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubServiceError,
  MANAGEMENT_MARKER,
  createGithubService,
  createOrGetManagedRepository,
  getContributionSnapshot,
  getSession,
  submitPlan,
  validateManagedRepository,
} from "../scripts/github-service.mjs";
import { rangeStartFor } from "../scripts/github-snapshot.mjs";

const ROOT = "1".repeat(40);
const HEAD = "2".repeat(40);
const TREE = "a".repeat(40);
const NEW_ONE = "3".repeat(40);
const NEW_TWO = "4".repeat(40);

function ok(value) {
  return { code: 0, stdout: JSON.stringify(value), stderr: "" };
}

function fixtureRepository() {
  return {
    full_name: "octocat/commit-canvas-art",
    name: "commit-canvas-art",
    owner: { login: "octocat" },
    fork: false,
    archived: false,
    permissions: { admin: true, push: true },
    default_branch: "main",
    visibility: "public",
    private: false,
    html_url: "https://github.com/octocat/commit-canvas-art",
  };
}

test("createGithubService binds one dependency boundary for the live server", () => {
  const service = createGithubService({ runner: async () => ok({}) });
  assert.deepEqual(Object.keys(service).sort(), [
    "createOrGetManagedRepository",
    "getContributionSnapshot",
    "getSession",
    "submitPlan",
    "validateManagedRepository",
  ]);
  assert.ok(Object.isFrozen(service));
});

function managedRunner(overrides = {}) {
  const calls = [];
  const queue = overrides.queue ? [...overrides.queue] : null;
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    if (queue) return queue.shift();
    const endpoint = args[1];
    if (endpoint === "/user") return ok({ login: "octocat", id: 42, name: "Octo Cat" });
    if (endpoint === "/repos/octocat/commit-canvas-art") return ok(fixtureRepository());
    if (endpoint.includes("/contents/.commit-canvas-managed?ref=")) {
      return ok({ type: "file", encoding: "base64", content: Buffer.from("Managed by Commit Canvas.\n").toString("base64") });
    }
    if (endpoint.endsWith("/git/ref/heads/main")) return ok({ object: { type: "commit", sha: HEAD } });
    if (endpoint.includes("/commits?sha=")) {
      return ok([
        { sha: HEAD, commit: { tree: { sha: TREE }, message: "existing work" }, parents: [{ sha: ROOT }] },
        { sha: ROOT, commit: { tree: { sha: TREE }, message: MANAGEMENT_MARKER }, parents: [] },
      ]);
    }
    throw new Error(`unexpected mock call: ${args.join(" ")}`);
  };
  return { runner, calls };
}

function planEntry(sequence = 1, total = 2, date = "2025-01-01") {
  const marker = `[contribution-art:demo:${date}:${sequence}]`;
  return {
    timestamp: `${date}T12:00:00+08:00`,
    marker,
    message: `Contribution art ${date} (${sequence}/${total}) ${marker}`,
  };
}

function dates(start, end) {
  const result = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function contributionResponse(allDays, from, to, override = {}) {
  return ok({
    data: {
      viewer: {
        login: "octocat",
        contributionsCollection: {
          contributionCalendar: {
            weeks: [{
              contributionDays: allDays.filter((date) => date >= from && date <= to).map((date) => ({
                date,
                contributionCount: override[date]?.count ?? 0,
                contributionLevel: override[date]?.level ?? "NONE",
              })),
            }],
          },
        },
      },
    },
  });
}

test("getSession derives numeric-id noreply identity without requesting a token", async () => {
  const calls = [];
  const session = await getSession({
    runner: async (command, args, options) => {
      calls.push({ command, args, options });
      return ok({ login: "octocat", id: 583231, name: "The Octocat" });
    },
  });
  assert.deepEqual(session, {
    login: "octocat",
    id: 583231,
    name: "The Octocat",
    noreplyEmail: "583231+octocat@users.noreply.github.com",
  });
  assert.equal(calls[0].command, "gh");
  assert.deepEqual(calls[0].args, ["api", "/user", "--method", "GET", "--hostname", "github.com"]);
  assert.doesNotMatch(JSON.stringify(calls), /auth token|--shell|shell.*true/i);
});

test("GitHub failures redact stdout, stderr, and thrown runner secrets", async () => {
  for (const runner of [
    async () => ({ code: 1, stdout: "secret-out", stderr: "secret-error" }),
    async () => { throw new Error("secret-thrown"); },
  ]) {
    await assert.rejects(
      getSession({ runner }),
      (error) => error instanceof GitHubServiceError
        && !/secret-out|secret-error|secret-thrown/.test(error.message),
    );
  }
});

test("getContributionSnapshot sends the reusable GraphQL shape through JSON stdin", async () => {
  const endDate = "2025-01-01";
  const start = rangeStartFor(endDate);
  const calls = [];
  const allDays = dates(start, endDate);
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    const body = JSON.parse(options.input);
    const from = body.variables.from.slice(0, 10);
    const to = body.variables.to.slice(0, 10);
    return ok({
      data: {
        viewer: {
          login: "octocat",
          contributionsCollection: {
            contributionCalendar: {
              weeks: [{
                contributionDays: allDays.filter((date) => date >= from && date <= to).map((date) => ({
                  date,
                  contributionCount: 0,
                  contributionLevel: "NONE",
                })),
              }],
            },
          },
        },
      },
    });
  };
  const snapshot = await getContributionSnapshot(endDate, {
    runner,
    now: new Date("2025-01-02T00:00:00Z"),
  });
  assert.equal(snapshot.account, "octocat");
  assert.equal(snapshot.days.length, allDays.length);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ["api", "graphql", "--method", "POST", "--hostname", "github.com", "--input", "-"]);
  assert.match(JSON.parse(calls[0].options.input).query, /contributionsCollection/);
});

test("service snapshot refresh sends identity plus a fresh full-grid overlay", async () => {
  const endDate = "2025-01-01";
  const start = rangeStartFor(endDate);
  const allDays = dates(start, endDate);
  const calls = [];
  const originalDateNow = Date.now;
  Date.now = () => 0;
  try {
    const service = createGithubService({
      now: new Date("2025-01-02T00:00:00Z"),
      runner: async (command, args, options = {}) => {
        calls.push({ command, args, options });
        if (args[1] === "/user") return ok({ login: "octocat", id: 42, name: "Octo Cat" });
        const body = JSON.parse(options.input);
        return contributionResponse(
          allDays,
          body.variables.from.slice(0, 10),
          body.variables.to.slice(0, 10),
        );
      },
    });
    await service.getSession();
    const snapshot = await service.getContributionSnapshot(endDate);
    assert.equal(snapshot.account, "octocat");
  } finally {
    Date.now = originalDateNow;
  }

  assert.equal(calls.length, 5, "one identity request plus four contribution queries");
  assert.deepEqual(calls[0].args, ["api", "/user", "--method", "GET", "--hostname", "github.com"]);
  const ranges = calls.slice(1).map((call) => {
    assert.deepEqual(call.args, ["api", "graphql", "--method", "POST", "--hostname", "github.com", "--input", "-"]);
    const variables = JSON.parse(call.options.input).variables;
    return [variables.from.slice(0, 10), variables.to.slice(0, 10)];
  });
  assert.deepEqual(ranges, [
    ["2023-12-31", "2024-01-02"],
    ["2024-01-03", "2025-01-01"],
    ["2023-12-31", "2024-05-19"],
    ["2024-05-20", "2025-01-01"],
  ]);
});

test("fresh full-grid overlay overrides an older value near the start of the wall", async () => {
  const endDate = "2025-01-01";
  const start = rangeStartFor(endDate);
  const changedDate = "2024-01-15";
  const allDays = dates(start, endDate);
  let graphqlCall = 0;
  const originalDateNow = Date.now;
  Date.now = () => 0;
  try {
    const service = createGithubService({
      now: new Date("2025-01-02T00:00:00Z"),
      runner: async (command, args, options = {}) => {
        graphqlCall += 1;
        const body = JSON.parse(options.input);
        const override = graphqlCall === 3
          ? { [changedDate]: { count: 7, level: "FOURTH_QUARTILE" } }
          : { [changedDate]: { count: 1, level: "FIRST_QUARTILE" } };
        return contributionResponse(
          allDays,
          body.variables.from.slice(0, 10),
          body.variables.to.slice(0, 10),
          override,
        );
      },
    });
    const snapshot = await service.getContributionSnapshot(endDate);
    assert.deepEqual(snapshot.days.find((day) => day.date === changedDate), {
      date: changedDate,
      count: 7,
      level: 4,
    });
  } finally {
    Date.now = originalDateNow;
  }
});

test("consecutive service refreshes vary both full-grid freshness ranges", async () => {
  const endDate = "2025-01-01";
  const start = rangeStartFor(endDate);
  const allDays = dates(start, endDate);
  const queryStarts = [];
  const originalDateNow = Date.now;
  Date.now = () => 0;
  try {
    const service = createGithubService({
      now: new Date("2025-01-02T00:00:00Z"),
      runner: async (command, args, options = {}) => {
        const body = JSON.parse(options.input);
        const from = body.variables.from.slice(0, 10);
        queryStarts.push(from);
        return contributionResponse(allDays, from, body.variables.to.slice(0, 10));
      },
    });
    await service.getContributionSnapshot(endDate);
    await service.getContributionSnapshot(endDate);
  } finally {
    Date.now = originalDateNow;
  }
  assert.equal(queryStarts.length, 8);
  assert.deepEqual(queryStarts.slice(0, 4), ["2023-12-31", "2024-01-03", "2023-12-31", "2024-05-20"]);
  assert.deepEqual(queryStarts.slice(4), ["2023-12-31", "2024-01-03", "2023-12-31", "2024-05-21"]);
  assert.notEqual(queryStarts[3], queryStarts[7]);
});

test("validateManagedRepository rechecks gates and walks to the reachable marker", async () => {
  const mock = managedRunner();
  const repository = await validateManagedRepository("octocat/commit-canvas-art", mock);
  assert.deepEqual({
    fullName: repository.fullName,
    owner: repository.owner,
    defaultBranch: repository.defaultBranch,
    head: repository.head,
  }, {
    fullName: "octocat/commit-canvas-art",
    owner: "octocat",
    defaultBranch: "main",
    head: HEAD,
  });
  assert.deepEqual(Object.keys(repository).sort(), ["defaultBranch", "fullName", "head", "htmlUrl", "name", "owner", "visibility"]);
  assert.equal(repository.internal.tree, TREE);
  const historyCall = mock.calls.find((call) => call.args[1].includes("/commits?sha="));
  assert.match(historyCall.args[1], new RegExp(`sha=${HEAD}.*per_page=100.*page=1`));
  assert.ok(mock.calls.every((call) => call.args.includes("--hostname") && call.args.includes("github.com")));

  const wrongOwner = managedRunner({
    queue: [ok({ login: "octocat", id: 42, name: null }), ok({ ...fixtureRepository(), owner: { login: "someone" } })],
  });
  await assert.rejects(validateManagedRepository("octocat/commit-canvas-art", wrongOwner), /not owned/);

  const renamedRepository = managedRunner({
    queue: [
      ok({ login: "octocat", id: 42, name: null }),
      ok({ ...fixtureRepository(), name: "production", full_name: "octocat/production" }),
    ],
  });
  await assert.rejects(
    validateManagedRepository("octocat/production", renamedRepository),
    /managed namespace/,
  );
});

test("createOrGetManagedRepository safely initializes the first branch", async () => {
  const calls = [];
  const rootCommit = "5".repeat(40);
  const runner = async (command, args, options = {}) => {
    calls.push({ command, args, options });
    const endpoint = args[1];
    const method = args[3];
    if (endpoint === "/user") return ok({ login: "octocat", id: 42, name: "Octo" });
    if (endpoint === "/repos/octocat/commit-canvas-new" && method === "GET" && calls.filter((call) => call.args[1] === endpoint).length === 1) {
      return { code: 1, httpStatus: 404, stdout: "", stderr: "not found" };
    }
    if (endpoint === "/user/repos") return ok({ ...fixtureRepository(), name: "commit-canvas-new", full_name: "octocat/commit-canvas-new" });
    if (endpoint.endsWith("/contents/.commit-canvas-managed") && method === "PUT") return ok({ commit: { sha: rootCommit } });
    if (endpoint === "/repos/octocat/commit-canvas-new") return ok({ ...fixtureRepository(), name: "commit-canvas-new", full_name: "octocat/commit-canvas-new" });
    if (endpoint.includes("/contents/.commit-canvas-managed?ref=")) {
      return ok({ type: "file", encoding: "base64", content: Buffer.from("Managed by Commit Canvas.\n").toString("base64") });
    }
    if (endpoint.endsWith("/git/ref/heads/main")) return ok({ object: { type: "commit", sha: rootCommit } });
    if (endpoint.includes("/commits?sha=")) return ok([{ sha: rootCommit, commit: { tree: { sha: TREE }, message: MANAGEMENT_MARKER }, parents: [] }]);
    throw new Error(`unexpected: ${args.join(" ")}`);
  };
  const result = await createOrGetManagedRepository("commit-canvas-new", "private", { runner });
  assert.equal(result.fullName, "octocat/commit-canvas-new");
  const createRepo = calls.find((call) => call.args[1] === "/user/repos");
  assert.deepEqual(JSON.parse(createRepo.options.input), { name: "commit-canvas-new", visibility: "private", auto_init: false });
  const root = calls.find((call) => call.args[1].endsWith("/contents/.commit-canvas-managed") && call.args[3] === "PUT");
  const body = JSON.parse(root.options.input);
  assert.equal(body.message, MANAGEMENT_MARKER);
  assert.equal(body.branch, "main");
  assert.equal(Buffer.from(body.content, "base64").toString("utf8"), "Managed by Commit Canvas.\n");
  assert.equal(body.author.email, "commit-canvas-initializer@example.invalid");
  assert.deepEqual(body.committer, body.author);
});

test("submitPlan creates one same-tree chain and publishes with one non-force ref update", async () => {
  const mock = managedRunner();
  const created = [NEW_ONE, NEW_TWO];
  const baseRunner = mock.runner;
  mock.runner = async (command, args, options = {}) => {
    if (args[1].endsWith("/git/commits") && args[3] === "POST") {
      mock.calls.push({ command, args, options });
      return ok({ sha: created.shift() });
    }
    if (args[1].endsWith("/git/refs/heads/main") && args[3] === "PATCH") {
      mock.calls.push({ command, args, options });
      return ok({});
    }
    return baseRunner(command, args, options);
  };
  const progress = [];
  const result = await submitPlan({
    repository: "octocat/commit-canvas-art",
    expectedDefaultBranch: "main",
    expectedHead: HEAD,
    expectedAccount: "octocat",
    plan: { commits: [planEntry(1), planEntry(2)] },
    onProgress: (event) => progress.push(event.phase),
  }, mock);
  assert.deepEqual(result, {
    repository: "octocat/commit-canvas-art",
    oldHead: HEAD,
    newHead: NEW_TWO,
    created: 2,
    skipped: 0,
    commitUrl: `https://github.com/octocat/commit-canvas-art/commit/${NEW_TWO}`,
  });
  const commitCalls = mock.calls.filter((call) => call.args[1].endsWith("/git/commits") && call.args[3] === "POST");
  assert.equal(commitCalls.length, 2);
  const first = JSON.parse(commitCalls[0].options.input);
  const second = JSON.parse(commitCalls[1].options.input);
  assert.equal(first.tree, TREE);
  assert.deepEqual(first.parents, [HEAD]);
  assert.deepEqual(second.parents, [NEW_ONE]);
  assert.equal(first.author.email, "42+octocat@users.noreply.github.com");
  assert.equal(first.author.date, "2025-01-01T12:00:00+08:00");
  const refCalls = mock.calls.filter((call) => call.args[1].endsWith("/git/refs/heads/main") && call.args[3] === "PATCH");
  assert.equal(refCalls.length, 1);
  assert.deepEqual(JSON.parse(refCalls[0].options.input), { sha: NEW_TWO, force: false });
  assert.deepEqual(progress, ["validating", "creating commits", "creating commits", "complete"]);
});

test("submitPlan aborts before creation when expected head moved", async () => {
  const mock = managedRunner();
  await assert.rejects(submitPlan({
    repository: "octocat/commit-canvas-art",
    expectedDefaultBranch: "main",
    expectedHead: "9".repeat(40),
    expectedAccount: "octocat",
    plan: [planEntry(1, 1)],
  }, mock), (error) => error.code === "HEAD_MOVED");
  assert.equal(mock.calls.filter((call) => call.args[1].endsWith("/git/commits") && call.args[3] === "POST").length, 0);
});

test("submitPlan rejects a same-SHA default branch change before creating objects", async () => {
  const mock = managedRunner();
  const baseRunner = mock.runner;
  mock.runner = async (command, args, options = {}) => {
    if (args[1] === "/repos/octocat/commit-canvas-art") {
      mock.calls.push({ command, args, options });
      return ok({ ...fixtureRepository(), default_branch: "develop" });
    }
    if (args[1].endsWith("/git/ref/heads/develop")) {
      mock.calls.push({ command, args, options });
      return ok({ object: { type: "commit", sha: HEAD } });
    }
    return baseRunner(command, args, options);
  };
  await assert.rejects(submitPlan({
    repository: "octocat/commit-canvas-art",
    expectedDefaultBranch: "main",
    expectedHead: HEAD,
    expectedAccount: "octocat",
    plan: [planEntry(1, 1)],
  }, mock), (error) => error.code === "DEFAULT_BRANCH_CHANGED");
  assert.equal(mock.calls.filter((call) => call.args[1].endsWith("/git/commits") && call.args[3] === "POST").length, 0);
  assert.equal(mock.calls.filter((call) => call.args[3] === "PATCH").length, 0);
});

test("submitPlan detects a head race after creating orphan objects and never updates the ref", async () => {
  const mock = managedRunner();
  const baseRunner = mock.runner;
  let refReads = 0;
  mock.runner = async (command, args, options = {}) => {
    if (args[1].endsWith("/git/commits") && args[3] === "POST") {
      mock.calls.push({ command, args, options });
      return ok({ sha: NEW_ONE });
    }
    if (args[1].endsWith("/git/ref/heads/main")) {
      refReads += 1;
      if (refReads === 2) {
        mock.calls.push({ command, args, options });
        return ok({ object: { type: "commit", sha: "8".repeat(40) } });
      }
    }
    return baseRunner(command, args, options);
  };
  await assert.rejects(submitPlan({
    repository: "octocat/commit-canvas-art",
    expectedDefaultBranch: "main",
    expectedHead: HEAD,
    expectedAccount: "octocat",
    plan: [planEntry(1, 1)],
  }, mock), (error) => error.code === "HEAD_MOVED");
  assert.equal(mock.calls.filter((call) => call.args[1].endsWith("/git/refs/heads/main") && call.args[3] === "PATCH").length, 0);
});

test("submitPlan does not publish orphan objects after the active account switches", async () => {
  const mock = managedRunner();
  const baseRunner = mock.runner;
  let sessionReads = 0;
  mock.runner = async (command, args, options = {}) => {
    if (args[1] === "/user") {
      sessionReads += 1;
      if (sessionReads === 2) {
        mock.calls.push({ command, args, options });
        return ok({ login: "attacker", id: 99, name: "Other Account" });
      }
    }
    if (args[1].endsWith("/git/commits") && args[3] === "POST") {
      mock.calls.push({ command, args, options });
      return ok({ sha: NEW_ONE });
    }
    return baseRunner(command, args, options);
  };
  await assert.rejects(submitPlan({
    repository: "octocat/commit-canvas-art",
    expectedDefaultBranch: "main",
    expectedHead: HEAD,
    expectedAccount: "octocat",
    plan: [planEntry(1, 1)],
  }, mock), (error) => error.code === "ACCOUNT_CHANGED");
  assert.equal(mock.calls.filter((call) => call.args[1].endsWith("/git/commits") && call.args[3] === "POST").length, 1);
  assert.equal(mock.calls.filter((call) => call.args[3] === "PATCH").length, 0);
  assert.equal(mock.calls.filter((call) => call.args[1].includes("/git/ref/heads/")).length, 1);
});

test("submitPlan does not publish orphan objects after the default branch switches mid-flight", async () => {
  const mock = managedRunner();
  const baseRunner = mock.runner;
  let repositoryReads = 0;
  mock.runner = async (command, args, options = {}) => {
    if (args[1] === "/repos/octocat/commit-canvas-art") {
      repositoryReads += 1;
      if (repositoryReads === 2) {
        mock.calls.push({ command, args, options });
        return ok({ ...fixtureRepository(), default_branch: "develop" });
      }
    }
    if (args[1].endsWith("/git/commits") && args[3] === "POST") {
      mock.calls.push({ command, args, options });
      return ok({ sha: NEW_ONE });
    }
    return baseRunner(command, args, options);
  };
  await assert.rejects(submitPlan({
    repository: "octocat/commit-canvas-art",
    expectedDefaultBranch: "main",
    expectedHead: HEAD,
    expectedAccount: "octocat",
    plan: [planEntry(1, 1)],
  }, mock), (error) => error.code === "DEFAULT_BRANCH_CHANGED");
  assert.equal(mock.calls.filter((call) => call.args[1].endsWith("/git/commits") && call.args[3] === "POST").length, 1);
  assert.equal(mock.calls.filter((call) => call.args[3] === "PATCH").length, 0);
  assert.equal(mock.calls.filter((call) => call.args[1].includes("/git/ref/heads/")).length, 1);
});

test("submitPlan treats a failed PATCH as successful when the branch reached the new head", async () => {
  const mock = managedRunner();
  const baseRunner = mock.runner;
  let refReads = 0;
  mock.runner = async (command, args, options = {}) => {
    if (args[1].endsWith("/git/commits") && args[3] === "POST") {
      mock.calls.push({ command, args, options });
      return ok({ sha: NEW_ONE });
    }
    if (args[1].endsWith("/git/ref/heads/main")) {
      refReads += 1;
      if (refReads === 3) {
        mock.calls.push({ command, args, options });
        return ok({ object: { type: "commit", sha: NEW_ONE } });
      }
    }
    if (args[1].endsWith("/git/refs/heads/main") && args[3] === "PATCH") {
      mock.calls.push({ command, args, options });
      return { code: 1, stdout: "", stderr: "connection lost" };
    }
    return baseRunner(command, args, options);
  };
  const result = await submitPlan({
    repository: "octocat/commit-canvas-art",
    expectedDefaultBranch: "main",
    expectedHead: HEAD,
    expectedAccount: "octocat",
    plan: [planEntry(1, 1)],
  }, mock);
  assert.equal(result.newHead, NEW_ONE);
  assert.equal(result.created, 1);
  assert.equal(mock.calls.filter((call) => call.args[3] === "PATCH").length, 1);
});

test("submitPlan preserves a failed PATCH error when the branch head is unchanged", async () => {
  const mock = managedRunner();
  const baseRunner = mock.runner;
  mock.runner = async (command, args, options = {}) => {
    if (args[1].endsWith("/git/commits") && args[3] === "POST") {
      mock.calls.push({ command, args, options });
      return ok({ sha: NEW_ONE });
    }
    if (args[1].endsWith("/git/refs/heads/main") && args[3] === "PATCH") {
      mock.calls.push({ command, args, options });
      return { code: 1, stdout: "", stderr: "connection lost" };
    }
    return baseRunner(command, args, options);
  };
  await assert.rejects(submitPlan({
    repository: "octocat/commit-canvas-art",
    expectedDefaultBranch: "main",
    expectedHead: HEAD,
    expectedAccount: "octocat",
    plan: [planEntry(1, 1)],
  }, mock), (error) => error.code === "GITHUB_REQUEST_FAILED");
  assert.equal(mock.calls.filter((call) => call.args[3] === "PATCH").length, 1);
  assert.equal(mock.calls.filter((call) => call.args[1].endsWith("/git/ref/heads/main")).length, 3);
});

test("submitPlan rejects over-cap and malformed plans without calling GitHub", async () => {
  const cases = [
    Array.from({ length: 501 }, (_, index) => ({ ...planEntry(1, 1), marker: `x-${index}` })),
    [{ ...planEntry(1, 1), timestamp: "not-a-time" }],
    [{ ...planEntry(1, 1), message: "arbitrary commit message" }],
    [{ ...planEntry(1, 1), extra: true }],
  ];
  for (const plan of cases) {
    let called = false;
    await assert.rejects(submitPlan({
      repository: "octocat/commit-canvas-art",
      expectedDefaultBranch: "main",
      expectedHead: HEAD,
      expectedAccount: "octocat",
      plan,
    }, { runner: async () => { called = true; return ok({}); } }), (error) => error.code === "INVALID_PLAN");
    assert.equal(called, false);
  }
});

test("submitPlan recognizes dotted export ids and markers embedded in commit messages", async () => {
  const marker = "[contribution-art:demo.v1:2025-01-01:1]";
  const mock = managedRunner();
  const baseRunner = mock.runner;
  mock.runner = async (command, args, options = {}) => {
    if (args[1].includes("/commits?sha=")) {
      mock.calls.push({ command, args, options });
      return ok([
        { sha: HEAD, commit: { tree: { sha: TREE }, message: `Contribution art 2025-01-01 (1/1) ${marker}` }, parents: [{ sha: ROOT }] },
        { sha: ROOT, commit: { tree: { sha: TREE }, message: MANAGEMENT_MARKER }, parents: [] },
      ]);
    }
    return baseRunner(command, args, options);
  };
  const result = await submitPlan({
    repository: "octocat/commit-canvas-art",
    expectedDefaultBranch: "main",
    expectedHead: HEAD,
    expectedAccount: "octocat",
    plan: { commits: [{
      timestamp: "2025-01-01T12:00:00+08:00",
      marker,
      message: `Contribution art 2025-01-01 (1/1) ${marker}`,
    }] },
  }, mock);
  assert.equal(result.created, 0);
  assert.equal(result.skipped, 1);
  assert.equal(mock.calls.filter((call) => call.args[3] === "POST").length, 0);
  assert.equal(mock.calls.filter((call) => call.args[3] === "PATCH").length, 0);
});

test("repository validation follows bounded history pagination", async () => {
  const mock = managedRunner();
  const baseRunner = mock.runner;
  const chain = Array.from({ length: 101 }, (_, index) => (index + 10).toString(16).padStart(40, "0"));
  mock.runner = async (command, args, options = {}) => {
    if (args[1].includes("/commits?sha=") && args[1].endsWith("page=1")) {
      mock.calls.push({ command, args, options });
      return ok(Array.from({ length: 100 }, (_, index) => ({
        sha: index === 0 ? HEAD : chain[index - 1],
        commit: { tree: { sha: TREE }, message: `work ${index}` },
        parents: [{ sha: chain[index] }],
      })));
    }
    if (args[1].includes("/commits?sha=") && args[1].endsWith("page=2")) {
      mock.calls.push({ command, args, options });
      return ok([{ sha: chain[99], commit: { tree: { sha: TREE }, message: MANAGEMENT_MARKER }, parents: [] }]);
    }
    return baseRunner(command, args, options);
  };
  const repository = await validateManagedRepository("octocat/commit-canvas-art", mock);
  assert.equal(repository.head, HEAD);
  const historyCalls = mock.calls.filter((call) => call.args[1].includes("/commits?sha="));
  assert.equal(historyCalls.length, 2);
  assert.ok(historyCalls[0].args[1].endsWith("page=1"));
  assert.ok(historyCalls[1].args[1].endsWith("page=2"));
});

test("repository remains managed when its root marker is beyond the bounded history window", async () => {
  const mock = managedRunner();
  const baseRunner = mock.runner;
  const shas = [HEAD, ...Array.from({ length: 2_000 }, (_, index) => (index + 100).toString(16).padStart(40, "0"))];
  mock.runner = async (command, args, options = {}) => {
    const match = /\/commits\?sha=.*&per_page=100&page=(\d+)$/.exec(args[1]);
    if (match) {
      mock.calls.push({ command, args, options });
      const offset = (Number(match[1]) - 1) * 100;
      return ok(Array.from({ length: 100 }, (_, index) => {
        const position = offset + index;
        return {
          sha: shas[position],
          commit: { tree: { sha: TREE }, message: `recent work ${position}` },
          parents: [{ sha: shas[position + 1] }],
        };
      }));
    }
    return baseRunner(command, args, options);
  };
  const repository = await validateManagedRepository("octocat/commit-canvas-art", mock);
  assert.equal(repository.head, HEAD);
  assert.equal(repository.internal.historyTruncated, true);
  assert.equal(mock.calls.filter((call) => call.args[1].includes("/commits?sha=")).length, 20);

  await assert.rejects(submitPlan({
    repository: "octocat/commit-canvas-art",
    expectedDefaultBranch: "main",
    expectedHead: HEAD,
    expectedAccount: "octocat",
    plan: [planEntry(1, 1)],
  }, mock), (error) => error.code === "HISTORY_LIMIT_REACHED" && /new managed repository/i.test(error.message));
  assert.equal(mock.calls.filter((call) => call.args[1].endsWith("/git/commits") && call.args[3] === "POST").length, 0);
  assert.equal(mock.calls.filter((call) => call.args[3] === "PATCH").length, 0);
});

test("repository validation rejects a missing or invalid management file", async () => {
  for (const response of [
    { code: 1, httpStatus: 404, stdout: "", stderr: "not found" },
    ok({ type: "file", encoding: "base64", content: Buffer.from("tampered\n").toString("base64") }),
    ok({ type: "dir", encoding: "base64", content: Buffer.from("Managed by Commit Canvas.\n").toString("base64") }),
  ]) {
    const mock = managedRunner();
    const baseRunner = mock.runner;
    mock.runner = async (command, args, options = {}) => {
      if (args[1].includes("/contents/.commit-canvas-managed?ref=")) {
        mock.calls.push({ command, args, options });
        return response;
      }
      return baseRunner(command, args, options);
    };
    await assert.rejects(
      validateManagedRepository("octocat/commit-canvas-art", mock),
      (error) => error.code === "UNMANAGED_REPOSITORY",
    );
    assert.equal(mock.calls.some((call) => call.args[1].includes("/commits?sha=")), false);
  }
});
