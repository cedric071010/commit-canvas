import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  COLS,
  ROWS,
  DEFAULT_LEVEL_COUNTS,
  MAX_COMMITS,
  isoDateLocal,
  gridDates,
  resolveTimeZoneOffset,
  timestampForDate,
  computeSummary,
  serializeDesign,
  parseDesign,
  parseContributionSnapshot,
  generateScript,
} from '../src/core.js';

const blankLevels = () => Array(COLS * ROWS).fill(0);
const design = (overrides = {}) => ({
  levels: blankLevels(),
  endDate: '2025-01-01',
  timeZone: 'Asia/Singapore',
  counts: [...DEFAULT_LEVEL_COUNTS],
  ...overrides,
});

function contributionSnapshot(endDate = '2025-01-01', overrides = {}) {
  const rangeStart = gridDates(endDate, 'Asia/Singapore')[0].date;
  const days = [];
  const cursor = new Date(`${rangeStart}T00:00:00Z`);
  while (cursor.toISOString().slice(0, 10) <= endDate) {
    days.push({ date: cursor.toISOString().slice(0, 10), count: 0, level: 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return {
    kind: 'commit-canvas-contribution-snapshot',
    version: 1,
    account: 'octocat',
    generatedAt: '2025-01-02T03:04:05.678Z',
    rangeStart,
    rangeEnd: endDate,
    days,
    ...overrides,
  };
}

function availableShell(candidates) {
  return candidates.find((candidate) => {
    const result = spawnSync(candidate.command, candidate.probe, { stdio: 'ignore' });
    return result.status === 0;
  });
}

function runScriptTwice(format, shell) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'commit-canvas-script-'));
  const repository = join(temporaryDirectory, 'repository');
  mkdirSync(repository);
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Commit Canvas Test'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'commit-canvas@example.com'], {
      cwd: repository,
    });

    const endDate = '2025-01-01';
    const levels = blankLevels();
    const endDateIndex = gridDates(endDate, 'Asia/Singapore').findIndex(
      (cell) => cell.date === endDate,
    );
    levels[endDateIndex] = 1;
    const exportId = `integration-${format}`;
    const script = generateScript(
      format,
      design({ levels, endDate, counts: [0, 1, 0, 0, 0], exportId }),
    );
    const extension = format === 'bash' ? 'sh' : 'ps1';
    writeFileSync(join(temporaryDirectory, `design.${extension}`), script);
    const confirmation = `CREATE 1 COMMITS FOR ${exportId}\n`;
    const argumentsForScript =
      format === 'bash'
        ? ['../design.sh']
        : ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '../design.ps1'];
    const options = { cwd: repository, input: confirmation, encoding: 'utf8' };

    const first = spawnSync(shell.command, argumentsForScript, options);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stderr, '');
    assert.match(first.stdout, /Created 1 empty commits; skipped 0 existing commits\./);

    const second = spawnSync(shell.command, argumentsForScript, options);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.stderr, '');
    assert.match(second.stdout, /Created 0 empty commits; skipped 1 existing commits\./);
    assert.equal(execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(), '1');
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

test('exports fixed grid and safety constants', () => {
  assert.equal(COLS, 53);
  assert.equal(ROWS, 7);
  assert.deepEqual(DEFAULT_LEVEL_COUNTS, [0, 1, 3, 6, 10]);
  assert.equal(MAX_COMMITS, 500);
  assert.throws(() => DEFAULT_LEVEL_COUNTS.push(20), TypeError);
});

test('isoDateLocal uses local calendar fields and validates input', () => {
  const date = new Date(2024, 1, 29, 23, 59);
  assert.equal(isoDateLocal(date), '2024-02-29');
  assert.throws(() => isoDateLocal(new Date('invalid')), /valid Date/);
  assert.throws(() => isoDateLocal('2024-01-01'), TypeError);
});

test('gridDates is column-major, consecutive, and puts end date in final column', () => {
  const cells = gridDates('2025-01-01');
  assert.equal(cells.length, 371);
  assert.deepEqual(cells[0], {
    index: 0,
    col: 0,
    row: 0,
    date: '2023-12-31',
    isFuture: false,
  });
  assert.deepEqual(cells[7], {
    index: 7,
    col: 1,
    row: 0,
    date: '2024-01-07',
    isFuture: false,
  });
  assert.equal(cells.at(-1).date, '2025-01-04');
  assert.equal(cells.find((cell) => cell.date === '2025-01-01').col, 52);
  for (let index = 1; index < cells.length; index += 1) {
    const previous = new Date(`${cells[index - 1].date}T00:00:00Z`);
    const current = new Date(`${cells[index].date}T00:00:00Z`);
    assert.equal(current - previous, 86_400_000);
  }
});

test('gridDates crosses leap days and year boundaries without gaps', () => {
  const dates = gridDates('2024-03-01').map((cell) => cell.date);
  const leapIndex = dates.indexOf('2024-02-29');
  assert.ok(leapIndex > 0);
  assert.equal(dates[leapIndex - 1], '2024-02-28');
  assert.equal(dates[leapIndex + 1], '2024-03-01');
  assert.ok(dates.includes('2023-12-31'));
  assert.ok(dates.includes('2024-01-01'));
  assert.throws(() => gridDates('2023-02-29'), /valid calendar date/);
});

test('gridDates marks dates after local today as future', () => {
  const today = isoDateLocal(new Date());
  const cells = gridDates(today);
  assert.equal(cells.find((cell) => cell.date === today).isFuture, false);
  for (const cell of cells) assert.equal(cell.isFuture, cell.date > today);
});

test('gridDates marks cells after a historical midweek end date as unavailable', () => {
  const cells = gridDates('2025-01-01', 'Asia/Singapore');
  assert.equal(cells.find((cell) => cell.date === '2025-01-01').isFuture, false);
  for (const date of ['2025-01-02', '2025-01-03', '2025-01-04']) {
    assert.equal(cells.find((cell) => cell.date === date).isFuture, true);
  }
});

test('gridDates compares today in the optional IANA time zone', () => {
  for (const timeZone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
        .formatToParts(new Date())
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]),
    );
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const end = new Date(`${today}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 10);
    const endDate = end.toISOString().slice(0, 10);
    const cells = gridDates(endDate, timeZone);
    for (const cell of cells) {
      assert.equal(cell.isFuture, cell.date > endDate || cell.date > today);
    }
  }
  assert.throws(() => gridDates('2025-01-01', 'Mars/Olympus'), RangeError);
});

test('time zone offsets support fixed zones and New York DST', () => {
  assert.equal(resolveTimeZoneOffset('2025-01-15', 'Asia/Singapore'), '+08:00');
  assert.equal(resolveTimeZoneOffset('2025-01-15', 'America/New_York'), '-05:00');
  assert.equal(resolveTimeZoneOffset('2025-07-15', 'America/New_York'), '-04:00');
  assert.equal(resolveTimeZoneOffset('2025-01-15', 'Asia/Kathmandu'), '+05:45');
  assert.equal(timestampForDate('2025-07-15', 'America/New_York'), '2025-07-15T12:00:00-04:00');
  assert.throws(() => resolveTimeZoneOffset('2025-01-15', 'Mars/Olympus'), RangeError);
});

test('computeSummary reports totals, painted days, and active cells', () => {
  const levels = blankLevels();
  levels[0] = 1;
  levels[1] = 2;
  levels[2] = 2;
  levels[3] = 4;
  assert.deepEqual(computeSummary(levels, [0, 2, 4, 8, 16]), {
    totalCommits: 26,
    paintedDays: 4,
    activeCells: 4,
  });
  assert.throws(() => computeSummary(levels.slice(1)), /exactly 371/);
  assert.throws(() => computeSummary(levels, [0, 1, -1, 3, 4]), /non-negative/);
});

test('design serialization round-trips canonical version 1 data', () => {
  const original = design({ levels: blankLevels().map((_, index) => index % 5) });
  const text = serializeDesign(original);
  assert.deepEqual(JSON.parse(text), { version: 1, ...original });
  assert.deepEqual(parseDesign(text), { version: 1, ...original });
});

test('design parsing strictly rejects malformed, unknown, and unsafe data', () => {
  assert.throws(() => parseDesign('{'), SyntaxError);
  assert.throws(() => parseDesign('[]'), /object/);
  assert.throws(() => parseDesign(JSON.stringify({ version: 2, ...design() })), /version/);
  assert.throws(
    () => parseDesign(JSON.stringify({ version: 1, ...design(), surprise: true })),
    /missing or unknown/,
  );
  assert.throws(
    () => parseDesign(JSON.stringify({ version: 1, ...design(), levels: blankLevels().fill(5) })),
    /0 to 4/,
  );
  assert.throws(
    () => parseDesign(JSON.stringify({ version: 1, ...design(), counts: [0, 1, 2] })),
    /exactly 5/,
  );
  assert.throws(
    () => parseDesign(JSON.stringify({ version: 1, ...design(), endDate: '2025-02-29' })),
    /valid calendar/,
  );
});

test('contribution snapshot parsing returns strict, canonical snapshot data', () => {
  const snapshot = contributionSnapshot();
  const parsed = parseContributionSnapshot(JSON.stringify(snapshot));

  assert.deepEqual(parsed, snapshot);
  assert.notEqual(parsed, snapshot);
  assert.notEqual(parsed.days, snapshot.days);
  assert.equal(parsed.days.length, 368);
  assert.equal(parsed.days[0].date, parsed.rangeStart);
  assert.equal(parsed.days.at(-1).date, parsed.rangeEnd);

  const offsetTimestamp = contributionSnapshot(undefined, {
    generatedAt: '2025-01-02T11:04:05+08:00',
  });
  assert.doesNotThrow(() => parseContributionSnapshot(JSON.stringify(offsetTimestamp)));
});

test('contribution snapshot parsing rejects malformed schemas and unsafe scalar values', () => {
  assert.throws(() => parseContributionSnapshot('{'), SyntaxError);
  assert.throws(() => parseContributionSnapshot('[]'), /object/);
  assert.throws(() => parseContributionSnapshot(JSON.stringify({ ...contributionSnapshot(), extra: true })), /unknown/);
  assert.throws(
    () => parseContributionSnapshot(JSON.stringify({ ...contributionSnapshot(), kind: 'other' })),
    /kind/,
  );
  assert.throws(
    () => parseContributionSnapshot(JSON.stringify({ ...contributionSnapshot(), version: 2 })),
    /version/,
  );
  for (const account of ['', '-octocat', 'octocat-', 'octo--cat', 'a'.repeat(40), 'octo_cat']) {
    assert.throws(
      () => parseContributionSnapshot(JSON.stringify({ ...contributionSnapshot(), account })),
      /account/,
    );
  }
  for (const generatedAt of [
    '2025-01-02',
    '2025-02-29T03:04:05Z',
    '2025-01-02T24:00:00Z',
    '2025-01-02T03:60:05Z',
    'not-a-time',
  ]) {
    assert.throws(
      () => parseContributionSnapshot(JSON.stringify({ ...contributionSnapshot(), generatedAt })),
      /generatedAt/,
    );
  }
  assert.throws(
    () => parseContributionSnapshot(JSON.stringify({ ...contributionSnapshot(), rangeStart: '2025-02-29' })),
    /rangeStart/,
  );
});

test('contribution snapshot parsing rejects invalid, inconsistent, or non-contiguous days', () => {
  const unknownDayField = contributionSnapshot();
  unknownDayField.days[0] = { ...unknownDayField.days[0], extra: true };
  assert.throws(() => parseContributionSnapshot(JSON.stringify(unknownDayField)), /unknown/);

  for (const replacement of [
    { count: -1 },
    { count: 1.5 },
    { count: Number.MAX_SAFE_INTEGER + 1 },
    { level: -1 },
    { level: 5 },
    { level: 1.5 },
    { count: 0, level: 1 },
    { count: 1, level: 0 },
  ]) {
    const invalid = contributionSnapshot();
    invalid.days[10] = { ...invalid.days[10], ...replacement };
    assert.throws(() => parseContributionSnapshot(JSON.stringify(invalid)), /days\[10\]/);
  }

  const gap = contributionSnapshot();
  gap.days.splice(10, 1);
  assert.throws(() => parseContributionSnapshot(JSON.stringify(gap)), /consecutive/);

  const wrongFirst = contributionSnapshot();
  wrongFirst.rangeStart = wrongFirst.days[1].date;
  assert.throws(() => parseContributionSnapshot(JSON.stringify(wrongFirst)), /rangeStart/);

  const wrongLast = contributionSnapshot();
  wrongLast.rangeEnd = wrongLast.days.at(-2).date;
  assert.throws(() => parseContributionSnapshot(JSON.stringify(wrongLast)), /rangeEnd/);

  const truncated = contributionSnapshot();
  truncated.days.splice(0, 7);
  truncated.rangeStart = truncated.days[0].date;
  assert.throws(
    () => parseContributionSnapshot(JSON.stringify(truncated)),
    /complete contribution grid/,
  );

  const tooLong = contributionSnapshot('2025-01-04');
  assert.equal(tooLong.days.length, 371);
  tooLong.days.push({ date: '2025-01-05', count: 0, level: 0 });
  tooLong.rangeEnd = '2025-01-05';
  assert.throws(() => parseContributionSnapshot(JSON.stringify(tooLong)), /at most 371/);
});

test('snapshot-aware script generation rejects incomplete coverage and existing contributions', () => {
  const endDate = '2025-01-01';
  const cells = gridDates(endDate, 'Asia/Singapore');
  const levels = blankLevels();
  const paintedDate = '2024-01-08';
  levels[cells.findIndex((cell) => cell.date === paintedDate)] = 1;
  const paintedDesign = design({ levels, endDate, counts: [0, 1, 0, 0, 0] });

  const shortAtStart = contributionSnapshot(endDate);
  shortAtStart.days.shift();
  shortAtStart.rangeStart = shortAtStart.days[0].date;
  assert.throws(
    () => generateScript('bash', paintedDesign, shortAtStart),
    /complete contribution grid/i,
  );

  const wrongEnd = contributionSnapshot(endDate);
  wrongEnd.days.pop();
  wrongEnd.rangeEnd = wrongEnd.days.at(-1).date;
  assert.throws(
    () => generateScript('bash', paintedDesign, wrongEnd),
    /cover.*rangeEnd/i,
  );

  const overlap = contributionSnapshot(endDate);
  const overlapDay = overlap.days.find((day) => day.date === paintedDate);
  overlapDay.count = 2;
  overlapDay.level = 1;
  assert.throws(
    () => generateScript('bash', paintedDesign, parseContributionSnapshot(JSON.stringify(overlap))),
    new RegExp(`overlap.*${paintedDate}`, 'i'),
  );
});

test('non-overlapping snapshots do not alter scripts, design JSON, or stable export IDs', () => {
  const endDate = '2025-01-01';
  const cells = gridDates(endDate, 'Asia/Singapore');
  const levels = blankLevels();
  levels[cells.findIndex((cell) => cell.date === endDate)] = 1;
  const paintedDesign = design({ levels, endDate, counts: [0, 1, 0, 0, 0] });
  const snapshot = parseContributionSnapshot(JSON.stringify(contributionSnapshot(endDate)));

  const withoutSnapshot = generateScript('bash', paintedDesign);
  const withSnapshot = generateScript('bash', paintedDesign, snapshot);
  assert.equal(withSnapshot, withoutSnapshot);
  assert.equal(serializeDesign(paintedDesign), serializeDesign({ ...paintedDesign, snapshot }));

  assert.throws(() => generateScript('bash', paintedDesign, { ...snapshot, surprise: true }), /unknown/);
});

test('bash generation emits chronological empty commits and safety gates', () => {
  const levels = blankLevels();
  levels[0] = 1;
  levels[8] = 2;
  const script = generateScript('bash', design({ levels, counts: [0, 1, 2, 0, 0], exportId: 'demo-1' }));
  assert.match(script, /^#!\/usr\/bin\/env bash\nset -euo pipefail/);
  assert.match(script, /git rev-parse --is-inside-work-tree/);
  assert.match(script, /git symbolic-ref --quiet HEAD/);
  assert.match(script, /git status --porcelain/);
  assert.match(script, /git config --get user\.name/);
  assert.match(script, /MERGE_HEAD/);
  assert.match(script, /CREATE 3 COMMITS FOR demo-1/);
  assert.equal((script.match(/git commit --allow-empty/g) ?? []).length, 3);
  assert.equal((script.match(/GIT_AUTHOR_DATE=/g) ?? []).length, 3);
  assert.equal((script.match(/GIT_COMMITTER_DATE=/g) ?? []).length, 3);
  assert.equal((script.match(/\[contribution-art:demo-1:/g) ?? []).length, 6);
  assert.match(script, /git log HEAD --fixed-strings/);
  assert.match(script, /created_count=0/);
  assert.match(script, /skipped_count=0/);
  assert.match(script, /created_count=\$\(\(created_count \+ 1\)\)/);
  assert.match(script, /skipped_count=\$\(\(skipped_count \+ 1\)\)/);
  assert.match(
    script,
    /Created %d empty commits; skipped %d existing commits.*"\$created_count" "\$skipped_count"/,
  );
  const timestamps = [...script.matchAll(/GIT_AUTHOR_DATE='([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(timestamps, [
    '2023-12-31T12:00:00+08:00',
    '2024-01-08T12:00:00+08:00',
    '2024-01-08T12:00:00+08:00',
  ]);
  assert.doesNotMatch(script, /\bgit\s+(?:init|push|reset)\b/);
  assert.doesNotMatch(script, /\bgit\s+(?:remote|checkout|switch)\b/);
});

test('PowerShell generation sets and restores Git date and optional email variables', () => {
  const levels = blankLevels();
  const endDateIndex = gridDates('2025-01-01', 'Asia/Singapore').findIndex(
    (cell) => cell.date === '2025-01-01',
  );
  levels[endDateIndex] = 1;
  const script = generateScript(
    'powershell',
    design({ levels, exportId: 'ps_demo', email: 'artist@example.com' }),
  );
  assert.match(script, /Get-Command git/);
  assert.match(script, /git status --porcelain/);
  assert.match(script, /git symbolic-ref --quiet HEAD/);
  assert.match(script, /git config --get user\.name 2>\$null/);
  assert.match(script, /CHERRY_PICK_HEAD/);
  assert.match(script, /Read-Host/);
  assert.match(script, /CREATE 1 COMMITS FOR ps_demo/);
  assert.match(script, /\$env:GIT_AUTHOR_DATE = '2025-01-01T12:00:00\+08:00'/);
  assert.match(script, /\$env:GIT_COMMITTER_DATE = '2025-01-01T12:00:00\+08:00'/);
  assert.match(script, /git commit --allow-empty/);
  assert.match(script, /git log HEAD --fixed-strings/);
  assert.match(script, /\[contribution-art:ps_demo:/);
  assert.match(script, /\$env:GIT_AUTHOR_EMAIL = 'artist@example.com'/);
  assert.match(script, /\$env:GIT_COMMITTER_EMAIL = 'artist@example.com'/);
  assert.match(script, /SetEnvironmentVariable\('GIT_AUTHOR_DATE', \$previousAuthorDate/);
  assert.match(script, /SetEnvironmentVariable\('GIT_COMMITTER_DATE', \$previousCommitterDate/);
  assert.match(script, /SetEnvironmentVariable\('GIT_AUTHOR_EMAIL', \$previousAuthorEmail/);
  assert.match(script, /git show-ref --verify --quiet HEAD 2>\$null/);
  assert.doesNotMatch(script, /git rev-parse --verify HEAD/);
  assert.match(script, /\$createdCount = 0/);
  assert.match(script, /\$skippedCount = 0/);
  assert.match(script, /\$createdCount \+= 1/);
  assert.match(script, /\$skippedCount \+= 1/);
  assert.match(
    script,
    /Write-Host "Created \$createdCount empty commits; skipped \$skippedCount existing commits\."/,
  );
  assert.doesNotMatch(script, /\bgit\s+(?:init|push|reset|remote)\b/);
});

test('script generation never exports cells after a historical midweek end date', () => {
  const endDate = '2025-01-01';
  const cells = gridDates(endDate, 'Asia/Singapore');
  const levels = blankLevels();
  for (const date of [endDate, '2025-01-02', '2025-01-03', '2025-01-04']) {
    levels[cells.findIndex((cell) => cell.date === date)] = 1;
  }

  for (const format of ['bash', 'powershell']) {
    const script = generateScript(
      format,
      design({ levels, endDate, counts: [0, 1, 0, 0, 0], exportId: `wed-${format}` }),
    );
    assert.equal((script.match(/git commit --allow-empty/g) ?? []).length, 1);
    assert.match(script, /Contribution art 2025-01-01/);
    assert.doesNotMatch(script, /Contribution art 2025-01-0[234]/);
  }
});

test('script generation validates format, export identifiers, and commit cap', () => {
  assert.throws(() => generateScript('fish', design()), /format/);
  assert.throws(() => generateScript('bash', design({ exportId: 'bad id; rm' })), /exportId/);
  assert.throws(
    () => generateScript('bash', design({ levels: blankLevels().fill(1), email: 'bad;email@example.com' })),
    /email/,
  );
  assert.throws(() => generateScript('bash', design()), /at least one/);
  assert.throws(
    () => generateScript('bash', design({ levels: blankLevels().fill(4), counts: [0, 0, 0, 0, 2] })),
    /500 commit limit/,
  );
  assert.throws(
    () => generateScript('bash', design({ levels: blankLevels().fill(1), counts: [0, Number.MAX_SAFE_INTEGER, 0, 0, 0] })),
    /500 commit limit/,
  );
  assert.doesNotThrow(() =>
    generateScript('bash', design({ levels: blankLevels().fill(4), counts: [0, 0, 0, 0, 1] })),
  );
});

test('script generation skips future grid cells and derives stable markers', () => {
  const today = isoDateLocal(new Date());
  const cells = gridDates(today);
  const levels = blankLevels();
  const todayIndex = cells.findIndex((cell) => cell.date === today);
  levels[todayIndex] = 1;
  for (const cell of cells) if (cell.isFuture) levels[cell.index] = 1;

  const first = generateScript('bash', design({ levels, endDate: today, counts: [0, 1, 0, 0, 0] }));
  const second = generateScript('bash', design({ levels, endDate: today, counts: [0, 1, 0, 0, 0] }));
  assert.equal(first, second);
  assert.equal((first.match(/git commit --allow-empty/g) ?? []).length, 1);
  assert.match(first, new RegExp(`Contribution art ${today.replaceAll('-', '\\-')}`));
  assert.doesNotMatch(first, /Contribution art .*\(2\/|Contribution art .*future/i);
  assert.match(first, /\[contribution-art:design-[0-9a-f]{8}:/);
  assert.doesNotMatch(first, /\beval\b|\bgit\s+(?:init|push|remote|reset)\b/);
});

const bashCandidates = [{ command: 'bash', probe: ['--version'] }];
const gitForWindowsBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
if (existsSync(gitForWindowsBash)) {
  bashCandidates.push({ command: gitForWindowsBash, probe: ['--version'] });
}
const bash = availableShell(bashCandidates);
test('generated Bash reports actual created and skipped counts', { skip: !bash }, () => {
  runScriptTwice('bash', bash);
});

const powerShell = availableShell([
  { command: 'powershell.exe', probe: ['-NoLogo', '-NoProfile', '-Command', 'exit 0'] },
  { command: 'pwsh', probe: ['-NoLogo', '-NoProfile', '-Command', 'exit 0'] },
]);
test('generated PowerShell reports actual created and skipped counts in an unborn repository', { skip: !powerShell }, () => {
  runScriptTwice('powershell', powerShell);
});
