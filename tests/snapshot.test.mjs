import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseContributionSnapshot } from "../src/core.js";

import {
  GRAPHQL_QUERY,
  buildGhArguments,
  buildSnapshot,
  defaultOutputName,
  parseArguments,
  queryGithub,
  rangeStartFor,
  splitQueryRanges,
  writeSnapshot,
} from "../scripts/github-snapshot.mjs";

function isoDates(start, end) {
  const dates = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function fixtureRange(start, end, account = "octo-user") {
  const contributionDays = isoDates(start, end).map((date, index) => {
    const contributionLevel = [
      "NONE",
      "FIRST_QUARTILE",
      "SECOND_QUARTILE",
      "THIRD_QUARTILE",
      "FOURTH_QUARTILE",
    ][index % 5];
    return {
      date,
      contributionCount: contributionLevel === "NONE" ? 0 : (index % 7) + 1,
      contributionLevel,
    };
  });
  return {
    data: {
      viewer: {
        login: account,
        contributionsCollection: {
          contributionCalendar: { weeks: [{ contributionDays }] },
        },
      },
    },
  };
}

function fixture(endDate = "2025-01-01") {
  return fixtureRange(rangeStartFor(endDate), endDate);
}

test("rangeStartFor returns the first Sunday of the 53-column grid", () => {
  assert.equal(rangeStartFor("2025-01-01"), "2023-12-31");
  assert.equal(rangeStartFor("2024-03-01"), "2023-02-26");
  assert.throws(() => rangeStartFor("2025-02-29"), /valid YYYY-MM-DD/);
});

test("parseArguments supplies local today and rejects future dates", () => {
  const now = new Date(2025, 4, 6, 23, 30);
  assert.deepEqual(parseArguments([], now), {
    endDate: "2025-05-06",
    output: undefined,
    force: false,
    help: false,
  });
  assert.equal(parseArguments(["--end-date", "2025-05-05"], now).endDate, "2025-05-05");
  assert.throws(() => parseArguments(["--end-date", "2025-05-07"], now), /future/);
  assert.throws(() => parseArguments(["--output"], now), /requires a value/);
  assert.throws(() => parseArguments(["--wat"], now), /Unknown option/);
});

test("GraphQL uses a static query and passes dates only as variables", () => {
  const arguments_ = buildGhArguments("2023-12-31", "2025-01-01");
  assert.deepEqual(arguments_.slice(0, 3), ["api", "graphql", "--method"]);
  assert.match(GRAPHQL_QUERY, /viewer\s*\{/);
  assert.match(GRAPHQL_QUERY, /contributionsCollection\(from: \$from, to: \$to\)/);
  assert.match(GRAPHQL_QUERY, /contributionDays\s*\{[\s\S]*date[\s\S]*contributionCount[\s\S]*contributionLevel/);
  assert.doesNotMatch(GRAPHQL_QUERY, /2023-12-31|2025-01-01/);
  assert.ok(arguments_.includes("from=2023-12-31T00:00:00Z"));
  assert.ok(arguments_.includes("to=2025-01-01T23:59:59Z"));
});

test("long ranges use a 365-day authoritative tail with only a short leading supplement", () => {
  assert.deepEqual(splitQueryRanges("2023-12-31", "2025-01-01"), [
    { rangeStart: "2023-12-31", rangeEnd: "2024-01-02" },
    { rangeStart: "2024-01-03", rangeEnd: "2025-01-01" },
  ]);
  assert.deepEqual(splitQueryRanges("2023-12-31", "2025-01-04"), [
    { rangeStart: "2023-12-31", rangeEnd: "2024-01-05" },
    { rangeStart: "2024-01-06", rangeEnd: "2025-01-04" },
  ]);
  assert.deepEqual(splitQueryRanges("2024-01-01", "2024-12-30"), [
    { rangeStart: "2024-01-01", rangeEnd: "2024-12-30" },
  ]);
});

test("queryGithub rejects gh failures without echoing CLI output", () => {
  const failingRunner = () => ({
    status: 1,
    stdout: "",
    stderr: "do-not-repeat-this-output",
    error: undefined,
  });
  assert.throws(
    () => queryGithub("2024-01-01", "2024-01-02", failingRunner),
    (error) => /request failed/.test(error.message) && !/do-not-repeat/.test(error.message),
  );
});

test("buildSnapshot maps the fixed fixture to the versioned schema", () => {
  const generatedAt = "2025-01-02T03:04:05.000Z";
  const snapshot = buildSnapshot(fixture(), "2025-01-01", generatedAt);
  assert.equal(snapshot.kind, "commit-canvas-contribution-snapshot");
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.account, "octo-user");
  assert.equal(snapshot.generatedAt, generatedAt);
  assert.equal(snapshot.rangeStart, "2023-12-31");
  assert.equal(snapshot.rangeEnd, "2025-01-01");
  assert.equal(snapshot.days.length, 368);
  assert.deepEqual(snapshot.days[0], { date: "2023-12-31", count: 0, level: 0 });
  assert.deepEqual(snapshot.days[4], { date: "2024-01-04", count: 5, level: 4 });
  assert.equal(snapshot.days.at(-1).date, "2025-01-01");
});

test("buildSnapshot lets the authoritative tail replace supplemental levels when counts agree", () => {
  const first = fixtureRange("2023-12-31", "2024-01-05");
  const second = fixtureRange("2024-01-05", "2025-01-04");
  const firstDays = first.data.viewer.contributionsCollection.contributionCalendar.weeks[0].contributionDays;
  const secondDays = second.data.viewer.contributionsCollection.contributionCalendar.weeks[0].contributionDays;
  firstDays.at(-1).contributionCount = 3;
  firstDays.at(-1).contributionLevel = "FIRST_QUARTILE";
  secondDays[0].contributionCount = 3;
  secondDays[0].contributionLevel = "FOURTH_QUARTILE";
  const snapshot = buildSnapshot([first, second], "2025-01-04");
  assert.equal(snapshot.days.find((day) => day.date === "2024-01-05").level, 4);
  assert.equal(snapshot.days.length, 371);
  assert.equal(snapshot.days.at(-1).date, "2025-01-04");
});

test("buildSnapshot lets a later fresh payload replace a cached contribution count", () => {
  const broad = fixture();
  const fresh = fixtureRange("2024-12-20", "2025-01-01");
  const date = "2024-12-31";
  const broadDay = broad.data.viewer.contributionsCollection.contributionCalendar.weeks[0]
    .contributionDays.find((day) => day.date === date);
  const freshDay = fresh.data.viewer.contributionsCollection.contributionCalendar.weeks[0]
    .contributionDays.find((day) => day.date === date);
  broadDay.contributionCount = 0;
  broadDay.contributionLevel = "NONE";
  freshDay.contributionCount = 1;
  freshDay.contributionLevel = "FIRST_QUARTILE";

  const snapshot = buildSnapshot([broad, fresh], "2025-01-01");

  assert.deepEqual(snapshot.days.find((day) => day.date === date), {
    date,
    count: 1,
    level: 1,
  });
});

test("buildSnapshot output satisfies the core contribution snapshot contract", () => {
  const snapshot = buildSnapshot(fixture(), "2025-01-01", "2025-01-02T03:04:05.000Z");
  assert.deepEqual(parseContributionSnapshot(JSON.stringify(snapshot)), snapshot);
});

test("buildSnapshot rejects zero and non-zero count/level mismatches", () => {
  const zeroWithLevel = fixture();
  const zeroDay = zeroWithLevel.data.viewer.contributionsCollection.contributionCalendar.weeks[0].contributionDays[0];
  zeroDay.contributionLevel = "FIRST_QUARTILE";
  assert.throws(() => buildSnapshot(zeroWithLevel, "2025-01-01"), /count and level/);

  const countWithNone = fixture();
  const nonzeroDay = countWithNone.data.viewer.contributionsCollection.contributionCalendar.weeks[0].contributionDays[0];
  nonzeroDay.contributionCount = 1;
  assert.throws(() => buildSnapshot(countWithNone, "2025-01-01"), /count and level/);
});

test("buildSnapshot merges segmented responses and identical padded dates", () => {
  const first = fixtureRange("2023-12-31", "2024-01-02");
  const second = fixtureRange("2024-01-03", "2025-01-01");
  const snapshot = buildSnapshot([first, second], "2025-01-01");
  assert.equal(snapshot.days.length, 368);
  assert.equal(snapshot.days.at(-1).date, "2025-01-01");
});

test("buildSnapshot requires one valid contribution entry for every date", () => {
  const missing = fixture();
  missing.data.viewer.contributionsCollection.contributionCalendar.weeks[0].contributionDays.pop();
  assert.throws(() => buildSnapshot(missing, "2025-01-01"), /complete continuous coverage/);

  const duplicate = fixture();
  const days = duplicate.data.viewer.contributionsCollection.contributionCalendar.weeks[0].contributionDays;
  days.push({ ...days[1], contributionCount: days[1].contributionCount + 1 });
  assert.throws(() => buildSnapshot(duplicate, "2025-01-01"), /conflicting duplicate/);

  const badLevel = fixture();
  badLevel.data.viewer.contributionsCollection.contributionCalendar.weeks[0].contributionDays[0].contributionLevel = "VERY_GREEN";
  assert.throws(() => buildSnapshot(badLevel, "2025-01-01"), /contribution level/);
});

test("default filenames contain only safe account, date, and timestamp characters", () => {
  assert.equal(
    defaultOutputName("octo-user", "2025-01-01", "2025-01-02T03:04:05.678Z"),
    "octo-user-2025-01-01-20250102T030405678Z.commit-canvas-snapshot.json",
  );
  assert.throws(() => defaultOutputName("../octocat", "2025-01-01", "2025-01-02T03:04:05.678Z"), /account/);
});

test("writeSnapshot refuses replacement unless force is enabled", () => {
  const directory = mkdtempSync(join(tmpdir(), "commit-canvas-snapshot-"));
  const path = join(directory, "snapshot.json");
  try {
    writeSnapshot(path, { value: 1 }, false);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { value: 1 });
    assert.throws(() => writeSnapshot(path, { value: 2 }, false), /already exists/);
    writeSnapshot(path, { value: 2 }, true);
    assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { value: 2 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI help works without contacting GitHub", () => {
  const output = execFileSync(process.execPath, [
    fileURLToPath(new URL("../scripts/github-snapshot.mjs", import.meta.url)),
    "--help",
  ], { encoding: "utf8" });
  assert.match(output, /npm run snapshot -- \[--end-date YYYY-MM-DD\]/);
  assert.match(output, /--force/);
});
