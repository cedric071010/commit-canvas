#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SNAPSHOT_KIND = "commit-canvas-contribution-snapshot";
const SNAPSHOT_VERSION = 1;
const DAY_MILLISECONDS = 86_400_000;
const MAX_QUERY_DAYS = 365;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ACCOUNT_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

const CONTRIBUTION_LEVELS = Object.freeze({
  NONE: 0,
  FIRST_QUARTILE: 1,
  SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3,
  FOURTH_QUARTILE: 4,
});

export const GRAPHQL_QUERY = `query($from: DateTime!, $to: DateTime!) {
  viewer {
    login
    contributionsCollection(from: $from, to: $to) {
      contributionCalendar {
        weeks {
          contributionDays {
            date
            contributionCount
            contributionLevel
          }
        }
      }
    }
  }
}`;

const HELP = `Create a local Commit Canvas snapshot from the authenticated GitHub account.

Usage:
  npm run snapshot -- [--end-date YYYY-MM-DD] [--output PATH] [--force]

Options:
  --end-date YYYY-MM-DD  Last snapshot date (default: local today; future dates rejected)
  --output PATH          Output file (default includes account, date, and UTC timestamp)
  --force                Replace an existing output file
  -h, --help             Show this help
`;

function localIsoDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.valueOf())) {
    throw new TypeError("now must be a valid Date");
  }
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateToUtcMilliseconds(value) {
  const match = DATE_PATTERN.exec(value);
  if (!match) throw new TypeError("Date must be a valid YYYY-MM-DD calendar date");
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const milliseconds = Date.UTC(year, month - 1, day);
  const parsed = new Date(milliseconds);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw new TypeError("Date must be a valid YYYY-MM-DD calendar date");
  }
  return milliseconds;
}

function utcIsoDate(milliseconds) {
  return new Date(milliseconds).toISOString().slice(0, 10);
}

export function rangeStartFor(endDate) {
  const endMilliseconds = dateToUtcMilliseconds(endDate);
  const weekday = new Date(endMilliseconds).getUTCDay();
  return utcIsoDate(endMilliseconds - (weekday + 52 * 7) * DAY_MILLISECONDS);
}

export function parseArguments(argv, now = new Date()) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  const result = {
    endDate: localIsoDate(now),
    output: undefined,
    force: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "-h" || argument === "--help") {
      result.help = true;
    } else if (argument === "--force") {
      result.force = true;
    } else if (argument === "--end-date" || argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new TypeError(`${argument} requires a value`);
      if (argument === "--end-date") result.endDate = value;
      else result.output = value;
      index += 1;
    } else {
      throw new TypeError(`Unknown option: ${argument}`);
    }
  }

  dateToUtcMilliseconds(result.endDate);
  if (result.endDate > localIsoDate(now)) throw new RangeError("end date cannot be in the future");
  return result;
}

export function buildGhArguments(rangeStart, rangeEnd) {
  dateToUtcMilliseconds(rangeStart);
  dateToUtcMilliseconds(rangeEnd);
  return [
    "api",
    "graphql",
    "--method",
    "POST",
    "--raw-field",
    `query=${GRAPHQL_QUERY}`,
    "--raw-field",
    `from=${rangeStart}T00:00:00Z`,
    "--raw-field",
    `to=${rangeEnd}T23:59:59Z`,
  ];
}

export function splitQueryRanges(rangeStart, rangeEnd) {
  const first = dateToUtcMilliseconds(rangeStart);
  const last = dateToUtcMilliseconds(rangeEnd);
  if (first > last) throw new RangeError("query range start must not follow its end");
  const totalDays = Math.floor((last - first) / DAY_MILLISECONDS) + 1;
  if (totalDays <= MAX_QUERY_DAYS) {
    return [{ rangeStart, rangeEnd }];
  }
  const supplementalDays = totalDays - MAX_QUERY_DAYS;
  if (supplementalDays > 6) {
    throw new RangeError("query range cannot exceed the 371-day contribution grid");
  }
  const authoritativeStart = last - (MAX_QUERY_DAYS - 1) * DAY_MILLISECONDS;
  return [
    {
      rangeStart,
      rangeEnd: utcIsoDate(authoritativeStart - DAY_MILLISECONDS),
    },
    {
      rangeStart: utcIsoDate(authoritativeStart),
      rangeEnd,
    },
  ];
}

function runGhQuery(rangeStart, rangeEnd, runner) {
  const result = runner("gh", buildGhArguments(rangeStart, rangeEnd), {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") {
    throw new Error("GitHub CLI (gh) is not installed or not available on PATH");
  }
  if (result.error) throw new Error(`Unable to run GitHub CLI: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`GitHub CLI request failed (exit code ${result.status ?? "unknown"}); run gh auth status to check login`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("GitHub CLI returned invalid JSON");
  }
}

export function queryGithub(rangeStart, rangeEnd, runner = spawnSync) {
  return splitQueryRanges(rangeStart, rangeEnd).map((range) =>
    runGhQuery(range.rangeStart, range.rangeEnd, runner),
  );
}

function expectedDates(rangeStart, rangeEnd) {
  const first = dateToUtcMilliseconds(rangeStart);
  const last = dateToUtcMilliseconds(rangeEnd);
  if (first > last) throw new RangeError("snapshot range start must not follow its end");
  const dates = [];
  for (let cursor = first; cursor <= last; cursor += DAY_MILLISECONDS) {
    dates.push(utcIsoDate(cursor));
  }
  return dates;
}

export function buildSnapshot(payload, endDate, generatedAt = new Date().toISOString()) {
  const rangeStart = rangeStartFor(endDate);
  const requiredDates = expectedDates(rangeStart, endDate);
  if (typeof generatedAt !== "string" || Number.isNaN(Date.parse(generatedAt))) {
    throw new TypeError("generatedAt must be an ISO date-time string");
  }

  const payloads = Array.isArray(payload) ? payload : [payload];
  if (payloads.length === 0) throw new TypeError("GitHub response is empty");
  let account;
  const daysByDate = new Map();
  for (const response of payloads) {
    const viewer = response?.data?.viewer;
    if (!viewer || typeof viewer !== "object") throw new TypeError("GitHub response is missing viewer data");
    if (typeof viewer.login !== "string" || !ACCOUNT_PATTERN.test(viewer.login)) {
      throw new TypeError("GitHub response contains an invalid account login");
    }
    if (account !== undefined && account !== viewer.login) {
      throw new TypeError("GitHub responses contain inconsistent account logins");
    }
    account = viewer.login;

    const weeks = viewer.contributionsCollection?.contributionCalendar?.weeks;
    if (!Array.isArray(weeks)) throw new TypeError("GitHub response is missing contribution weeks");
    for (const week of weeks) {
      if (!Array.isArray(week?.contributionDays)) {
        throw new TypeError("GitHub response contains invalid contribution days");
      }
      for (const day of week.contributionDays) {
        if (!day || typeof day.date !== "string") {
          throw new TypeError("GitHub response contains an invalid contribution date");
        }
        dateToUtcMilliseconds(day.date);
        if (day.date < rangeStart || day.date > endDate) continue;
        if (!Number.isSafeInteger(day.contributionCount) || day.contributionCount < 0) {
          throw new TypeError(`GitHub response contains an invalid contribution count for ${day.date}`);
        }
        const level = CONTRIBUTION_LEVELS[day.contributionLevel];
        if (level === undefined) {
          throw new TypeError(`GitHub response contains an invalid contribution level for ${day.date}`);
        }
        if ((day.contributionCount === 0) !== (level === 0)) {
          throw new TypeError(`GitHub response contribution count and level disagree for ${day.date}`);
        }
        const normalized = { date: day.date, count: day.contributionCount, level };
        const existing = daysByDate.get(day.date);
        if (existing && existing.count !== normalized.count) {
          throw new TypeError(`GitHub response contains conflicting duplicate date ${day.date}`);
        }
        // Later payloads are the authoritative 365-day window. Its relative
        // quartile level must win over any padded overlap from the supplement.
        daysByDate.set(day.date, normalized);
      }
    }
  }

  const days = requiredDates.map((date) => daysByDate.get(date));
  if (days.some((day) => day === undefined)) {
    throw new TypeError("GitHub response does not provide complete continuous coverage for the requested range");
  }

  return {
    kind: SNAPSHOT_KIND,
    version: SNAPSHOT_VERSION,
    account,
    generatedAt,
    rangeStart,
    rangeEnd: endDate,
    days,
  };
}

export function defaultOutputName(account, endDate, generatedAt) {
  if (typeof account !== "string" || !ACCOUNT_PATTERN.test(account)) {
    throw new TypeError("account is not safe for a snapshot filename");
  }
  dateToUtcMilliseconds(endDate);
  const dateTime = new Date(generatedAt);
  if (Number.isNaN(dateTime.valueOf())) throw new TypeError("generatedAt must be a valid date-time");
  const timestamp = dateTime.toISOString().replace(/[-:.]/g, "");
  return `${account}-${endDate}-${timestamp}.commit-canvas-snapshot.json`;
}

export function writeSnapshot(path, snapshot, force = false) {
  try {
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, {
      encoding: "utf8",
      flag: force ? "w" : "wx",
    });
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`Output already exists: ${path}`);
    throw error;
  }
}

export function main(argv = process.argv.slice(2), dependencies = {}) {
  const now = dependencies.now ?? new Date();
  const stdout = dependencies.stdout ?? process.stdout;
  const query = dependencies.queryGithub ?? queryGithub;
  const cwd = dependencies.cwd ?? process.cwd();
  const options = parseArguments(argv, now);
  if (options.help) {
    stdout.write(HELP);
    return undefined;
  }

  const rangeStart = rangeStartFor(options.endDate);
  const generatedAt = now.toISOString();
  const snapshot = buildSnapshot(query(rangeStart, options.endDate), options.endDate, generatedAt);
  const output = resolve(cwd, options.output ?? defaultOutputName(snapshot.account, options.endDate, generatedAt));
  writeSnapshot(output, snapshot, options.force);
  stdout.write(`Saved contribution snapshot for ${snapshot.account} to ${output}\n`);
  return output;
}

const isDirectExecution = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectExecution) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Snapshot failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
