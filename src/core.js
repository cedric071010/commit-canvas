export const COLS = 53;
export const ROWS = 7;
export const DEFAULT_LEVEL_COUNTS = Object.freeze([0, 1, 3, 6, 10]);
export const MAX_COMMITS = 500;

const CELL_COUNT = COLS * ROWS;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LEVEL_COUNT = DEFAULT_LEVEL_COUNTS.length;
const CONTRIBUTION_SNAPSHOT_KIND = 'commit-canvas-contribution-snapshot';
const GITHUB_ACCOUNT_RE = /^(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const RFC3339_RE =
  /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export function isoDateLocal(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError('date must be a valid Date');
  }
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseDate(dateStr, label = 'date') {
  if (typeof dateStr !== 'string') {
    throw new TypeError(`${label} must be a YYYY-MM-DD string`);
  }
  const match = DATE_RE.exec(dateStr);
  if (!match) throw new RangeError(`${label} must use YYYY-MM-DD`);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    year < 1 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw new RangeError(`${label} is not a valid calendar date`);
  }
  return { year, month, day };
}

function utcDateString(instant) {
  return `${String(instant.getUTCFullYear()).padStart(4, '0')}-${String(
    instant.getUTCMonth() + 1,
  ).padStart(2, '0')}-${String(instant.getUTCDate()).padStart(2, '0')}`;
}

function currentDateInTimeZone(timeZone) {
  if (timeZone === undefined) return isoDateLocal(new Date());
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new TypeError('timeZone must be a non-empty IANA time zone string');
  }
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.create(null);
  for (const part of formatter.formatToParts(new Date())) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function gridDates(endDateStr, timeZone) {
  const { year, month, day } = parseDate(endDateStr, 'endDate');
  const end = new Date(Date.UTC(year, month - 1, day));
  const sunday = new Date(end);
  sunday.setUTCDate(end.getUTCDate() - end.getUTCDay());
  const first = new Date(sunday);
  first.setUTCDate(sunday.getUTCDate() - (COLS - 1) * ROWS);
  const today = currentDateInTimeZone(timeZone);

  return Array.from({ length: CELL_COUNT }, (_, index) => {
    const col = Math.floor(index / ROWS);
    const row = index % ROWS;
    const instant = new Date(first);
    instant.setUTCDate(first.getUTCDate() + index);
    const date = utcDateString(instant);
    return { index, col, row, date, isFuture: date > endDateStr || date > today };
  });
}

function zonedParts(formatter, instant) {
  const parts = Object.create(null);
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = part.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function resolveTimeZoneOffset(dateStr, timeZone) {
  const { year, month, day } = parseDate(dateStr);
  if (typeof timeZone !== 'string' || timeZone.length === 0) {
    throw new TypeError('timeZone must be a non-empty IANA time zone string');
  }

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    calendar: 'gregory',
    numberingSystem: 'latn',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const desired = Date.UTC(year, month - 1, day, 12, 0, 0);
  let instant = desired;

  // Iteration converts target-zone wall noon to an instant, including DST.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(formatter, new Date(instant));
    const represented = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
    );
    const correction = desired - represented;
    instant += correction;
    if (correction === 0) break;
  }

  const offsetMinutes = Math.round((desired - instant) / 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
  const minutes = String(absolute % 60).padStart(2, '0');
  return `${sign}${hours}:${minutes}`;
}

export function timestampForDate(dateStr, timeZone) {
  parseDate(dateStr);
  return `${dateStr}T12:00:00${resolveTimeZoneOffset(dateStr, timeZone)}`;
}

function validateCounts(counts) {
  if (!Array.isArray(counts) || counts.length !== LEVEL_COUNT) {
    throw new RangeError(`counts must contain exactly ${LEVEL_COUNT} entries`);
  }
  return counts.map((count, index) => {
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new RangeError(`counts[${index}] must be a non-negative safe integer`);
    }
    return count;
  });
}

function validateLevels(levels) {
  if (!Array.isArray(levels) || levels.length !== CELL_COUNT) {
    throw new RangeError(`levels must contain exactly ${CELL_COUNT} entries`);
  }
  return levels.map((level, index) => {
    if (!Number.isInteger(level) || level < 0 || level >= LEVEL_COUNT) {
      throw new RangeError(`levels[${index}] must be an integer from 0 to 4`);
    }
    return level;
  });
}

export function computeSummary(levels, counts = DEFAULT_LEVEL_COUNTS) {
  const safeLevels = validateLevels(levels);
  const safeCounts = validateCounts(counts);
  let totalCommits = 0;
  let paintedDays = 0;
  let activeCells = 0;

  for (const level of safeLevels) {
    totalCommits += safeCounts[level];
    if (level > 0) paintedDays += 1;
    if (safeCounts[level] > 0) activeCells += 1;
  }
  return { totalCommits, paintedDays, activeCells };
}

function validateDesign(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('design must be an object');
  }
  const levels = validateLevels(value.levels);
  const counts = validateCounts(value.counts);
  if (value.version !== undefined && value.version !== 1) {
    throw new RangeError('unsupported design version');
  }
  parseDate(value.endDate, 'endDate');
  resolveTimeZoneOffset(value.endDate, value.timeZone);
  return { version: 1, endDate: value.endDate, timeZone: value.timeZone, counts, levels };
}

export function serializeDesign(design) {
  const safe = validateDesign(design);
  return JSON.stringify(safe);
}

export function parseDesign(text) {
  if (typeof text !== 'string') throw new TypeError('serialized design must be text');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SyntaxError('serialized design is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('serialized design must contain an object');
  }
  const expectedKeys = ['counts', 'endDate', 'levels', 'timeZone', 'version'];
  const actualKeys = Object.keys(parsed).sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new RangeError('serialized design has missing or unknown fields');
  }
  if (parsed.version !== 1) throw new RangeError('unsupported design version');
  return validateDesign(parsed);
}

function requireExactFields(value, expectedKeys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  if (
    actualKeys.length !== sortedExpectedKeys.length ||
    actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
  ) {
    throw new RangeError(`${label} has missing or unknown fields`);
  }
}

function validateContributionSnapshot(value) {
  requireExactFields(
    value,
    ['kind', 'version', 'account', 'generatedAt', 'rangeStart', 'rangeEnd', 'days'],
    'contribution snapshot',
  );
  if (value.kind !== CONTRIBUTION_SNAPSHOT_KIND) {
    throw new RangeError('unsupported contribution snapshot kind');
  }
  if (value.version !== 1) throw new RangeError('unsupported contribution snapshot version');
  if (typeof value.account !== 'string' || !GITHUB_ACCOUNT_RE.test(value.account)) {
    throw new RangeError('contribution snapshot account is not a valid GitHub account name');
  }
  if (typeof value.generatedAt !== 'string' || !RFC3339_RE.test(value.generatedAt)) {
    throw new RangeError('contribution snapshot generatedAt must be an RFC 3339 timestamp');
  }
  const generatedDate = RFC3339_RE.exec(value.generatedAt)[1];
  try {
    parseDate(generatedDate, 'contribution snapshot generatedAt date');
  } catch {
    throw new RangeError('contribution snapshot generatedAt is not a valid timestamp');
  }
  if (Number.isNaN(Date.parse(value.generatedAt))) {
    throw new RangeError('contribution snapshot generatedAt is not a valid timestamp');
  }

  parseDate(value.rangeStart, 'contribution snapshot rangeStart');
  parseDate(value.rangeEnd, 'contribution snapshot rangeEnd');
  if (!Array.isArray(value.days) || value.days.length === 0 || value.days.length > CELL_COUNT) {
    throw new RangeError(`contribution snapshot days must contain 1 to at most ${CELL_COUNT} entries`);
  }

  const days = value.days.map((day, index) => {
    const label = `contribution snapshot days[${index}]`;
    requireExactFields(day, ['date', 'count', 'level'], label);
    parseDate(day.date, `${label}.date`);
    if (!Number.isSafeInteger(day.count) || day.count < 0) {
      throw new RangeError(`${label}.count must be a non-negative safe integer`);
    }
    if (!Number.isInteger(day.level) || day.level < 0 || day.level >= LEVEL_COUNT) {
      throw new RangeError(`${label}.level must be an integer from 0 to 4`);
    }
    if ((day.count === 0) !== (day.level === 0)) {
      throw new RangeError(`${label}.count and level must both be zero or both be non-zero`);
    }
    return { date: day.date, count: day.count, level: day.level };
  });

  if (days[0].date !== value.rangeStart) {
    throw new RangeError('contribution snapshot first day must match rangeStart');
  }
  if (days.at(-1).date !== value.rangeEnd) {
    throw new RangeError('contribution snapshot last day must match rangeEnd');
  }
  const expectedRangeStart = gridDates(value.rangeEnd, 'UTC')[0].date;
  if (value.rangeStart !== expectedRangeStart) {
    throw new RangeError(
      `contribution snapshot must cover the complete contribution grid from ${expectedRangeStart}`,
    );
  }
  for (let index = 1; index < days.length; index += 1) {
    const expected = new Date(`${days[index - 1].date}T00:00:00Z`);
    expected.setUTCDate(expected.getUTCDate() + 1);
    if (days[index].date !== utcDateString(expected)) {
      throw new RangeError('contribution snapshot days must be consecutive');
    }
  }

  return {
    kind: CONTRIBUTION_SNAPSHOT_KIND,
    version: 1,
    account: value.account,
    generatedAt: value.generatedAt,
    rangeStart: value.rangeStart,
    rangeEnd: value.rangeEnd,
    days,
  };
}

export function parseContributionSnapshot(text) {
  if (typeof text !== 'string') throw new TypeError('serialized contribution snapshot must be text');
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new SyntaxError('serialized contribution snapshot is not valid JSON');
  }
  return validateContributionSnapshot(parsed);
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function powerShellSingleQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function confirmationPhrase(totalCommits, exportId) {
  if (exportId === undefined) return `CREATE ${totalCommits} COMMITS`;
  return `CREATE ${totalCommits} COMMITS FOR ${exportId}`;
}

function stableExportId(design) {
  if (design.exportId !== undefined) {
    if (typeof design.exportId !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(design.exportId)) {
      throw new RangeError('exportId must use 1-64 letters, digits, dots, underscores, or hyphens');
    }
    return design.exportId;
  }
  const canonical = serializeDesign(design);
  let hash = 0x811c9dc5;
  for (let index = 0; index < canonical.length; index += 1) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `design-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function validatedEmail(email) {
  if (email === undefined || email === '') return undefined;
  if (
    typeof email !== 'string' ||
    email.length > 254 ||
    email.includes('..') ||
    !/^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(email)
  ) {
    throw new RangeError('email must be a conservative, valid email address');
  }
  return email;
}

function commitPlan(design, exportId) {
  const safe = validateDesign(design);
  const dates = gridDates(safe.endDate, safe.timeZone);
  let totalCommits = 0;
  for (const cell of dates) {
    if (cell.isFuture) continue;
    totalCommits += safe.counts[safe.levels[cell.index]];
    if (totalCommits > MAX_COMMITS) {
      throw new RangeError(`design exceeds the ${MAX_COMMITS} commit limit`);
    }
  }
  if (totalCommits === 0) {
    throw new RangeError('design must create at least one non-future commit');
  }

  const commits = [];
  for (const cell of dates) {
    if (cell.isFuture) continue;
    const count = safe.counts[safe.levels[cell.index]];
    for (let sequence = 1; sequence <= count; sequence += 1) {
      commits.push({
        timestamp: timestampForDate(cell.date, safe.timeZone),
        marker: `[contribution-art:${exportId}:${cell.date}:${sequence}]`,
        message: `Contribution art ${cell.date} (${sequence}/${count}) [contribution-art:${exportId}:${cell.date}:${sequence}]`,
      });
    }
  }
  return commits;
}

function assertSnapshotDoesNotOverlap(design, snapshot) {
  const safeDesign = validateDesign(design);
  const safeSnapshot = validateContributionSnapshot(snapshot);
  const dates = gridDates(safeDesign.endDate, safeDesign.timeZone);
  const expectedRangeStart = dates[0].date;
  if (safeSnapshot.rangeStart !== expectedRangeStart) {
    throw new RangeError(
      `contribution snapshot must cover design rangeStart ${expectedRangeStart}`,
    );
  }
  if (safeSnapshot.rangeEnd !== safeDesign.endDate) {
    throw new RangeError(
      `contribution snapshot must cover design rangeEnd ${safeDesign.endDate}`,
    );
  }

  for (const cell of dates) {
    if (cell.isFuture || cell.date > safeDesign.endDate) continue;
    const plannedCount = safeDesign.counts[safeDesign.levels[cell.index]];
    if (plannedCount > 0 && safeSnapshot.days[cell.index].count > 0) {
      throw new RangeError(
        `contribution snapshot overlap: ${cell.date} already has contributions`,
      );
    }
  }
}

function bashScript(commits, phrase, email) {
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    "command -v git >/dev/null 2>&1 || { printf '%s\\n' 'Git is required.' >&2; exit 1; }",
    "git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { printf '%s\\n' 'Run this inside an existing Git worktree.' >&2; exit 1; }",
    "git symbolic-ref --quiet HEAD >/dev/null 2>&1 || { printf '%s\\n' 'Detached HEAD is not supported.' >&2; exit 1; }",
    '[[ -z "$(git status --porcelain)" ]] || { printf \'%s\\n\' \'Worktree must be clean (including untracked files).\' >&2; exit 1; }',
    '[[ -n "$(git config --get user.name 2>/dev/null)" ]] || { printf \'%s\\n\' \'Git user.name must be configured before creating commits.\' >&2; exit 1; }',
    'git_dir="$(git rev-parse --git-dir)"',
    'for state_path in "$git_dir/MERGE_HEAD" "$git_dir/CHERRY_PICK_HEAD" "$git_dir/REVERT_HEAD" "$git_dir/rebase-merge" "$git_dir/rebase-apply"; do',
    "  [[ ! -e \"$state_path\" ]] || { printf '%s\\n' 'Finish the merge, rebase, cherry-pick, or revert first.' >&2; exit 1; }",
    'done',
    '',
    `CONFIRM_PHRASE=${shellSingleQuote(phrase)}`,
    `printf 'This will create ${commits.length} empty commits in the current branch.\\nType exactly: %s\\n> ' "$CONFIRM_PHRASE"`,
    'IFS= read -r confirmation',
    '[[ "$confirmation" == "$CONFIRM_PHRASE" ]] || { printf \'%s\\n\' \'Confirmation did not match; no commits created.\' >&2; exit 1; }',
    '',
    'created_count=0',
    'skipped_count=0',
  ];
  const identity = email
    ? ` GIT_AUTHOR_EMAIL=${shellSingleQuote(email)} GIT_COMMITTER_EMAIL=${shellSingleQuote(email)}`
    : '';
  for (const commit of commits) {
    lines.push(
      `marker=${shellSingleQuote(commit.marker)}`,
      'if git log HEAD --fixed-strings --grep="$marker" --format=%H -1 2>/dev/null | grep -q .; then',
      "  printf 'Skipping existing marker: %s\\n' \"$marker\"",
      '  skipped_count=$((skipped_count + 1))',
      'else',
      `  GIT_AUTHOR_DATE=${shellSingleQuote(commit.timestamp)} GIT_COMMITTER_DATE=${shellSingleQuote(commit.timestamp)}${identity} git commit --allow-empty -m ${shellSingleQuote(commit.message)}`,
      '  created_count=$((created_count + 1))',
      'fi',
    );
  }
  lines.push(
    '',
    `printf 'Created %d empty commits; skipped %d existing commits.\\n' "$created_count" "$skipped_count"`,
    '',
  );
  return lines.join('\n');
}

function powerShellScript(commits, phrase, email) {
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    '',
    "if (-not (Get-Command git -ErrorAction SilentlyContinue)) { throw 'Git is required.' }",
    'git rev-parse --is-inside-work-tree *> $null',
    "if ($LASTEXITCODE -ne 0) { throw 'Run this inside an existing Git worktree.' }",
    'git symbolic-ref --quiet HEAD *> $null',
    "if ($LASTEXITCODE -ne 0) { throw 'Detached HEAD is not supported.' }",
    '$worktreeStatus = @(git status --porcelain)',
    "if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect the Git worktree.' }",
    "if ($worktreeStatus.Count -ne 0) { throw 'Worktree must be clean (including untracked files).' }",
    '$configuredUserName = @(git config --get user.name 2>$null)',
    "if ($LASTEXITCODE -ne 0 -or $configuredUserName.Count -eq 0 -or [string]::IsNullOrWhiteSpace([string]$configuredUserName[0])) { throw 'Git user.name must be configured before creating commits.' }",
    '$gitDirectory = git rev-parse --absolute-git-dir',
    "if ($LASTEXITCODE -ne 0) { throw 'Unable to locate Git metadata.' }",
    "foreach ($stateName in @('MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply')) {",
    "  if (Test-Path (Join-Path $gitDirectory $stateName)) { throw 'Finish the merge, rebase, cherry-pick, or revert first.' }",
    '}',
    'git show-ref --verify --quiet HEAD 2>$null',
    '$hasHead = $LASTEXITCODE -eq 0',
    '',
    `$confirmationPhrase = ${powerShellSingleQuote(phrase)}`,
    `Write-Host ${powerShellSingleQuote(`This will create ${commits.length} empty commits in the current branch.`)}`,
    'Write-Host "Type exactly: $confirmationPhrase"',
    '$confirmation = Read-Host',
    "if ($confirmation -cne $confirmationPhrase) { throw 'Confirmation did not match; no commits created.' }",
    '',
    "$previousAuthorDate = [Environment]::GetEnvironmentVariable('GIT_AUTHOR_DATE', 'Process')",
    "$previousCommitterDate = [Environment]::GetEnvironmentVariable('GIT_COMMITTER_DATE', 'Process')",
    "$previousAuthorEmail = [Environment]::GetEnvironmentVariable('GIT_AUTHOR_EMAIL', 'Process')",
    "$previousCommitterEmail = [Environment]::GetEnvironmentVariable('GIT_COMMITTER_EMAIL', 'Process')",
    '$createdCount = 0',
    '$skippedCount = 0',
    'try {',
  ];
  for (const commit of commits) {
    lines.push(
      `  $marker = ${powerShellSingleQuote(commit.marker)}`,
      '  $alreadyExists = $false',
      '  if ($hasHead) {',
      '    $existingCommit = @(git log HEAD --fixed-strings "--grep=$marker" --format=%H -1)',
      "    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect existing commit markers.' }",
      '    $alreadyExists = $existingCommit.Count -gt 0',
      '  }',
      '  if ($alreadyExists) {',
      '    Write-Host "Skipping existing marker: $marker"',
      '    $skippedCount += 1',
      '  } else {',
      `    $env:GIT_AUTHOR_DATE = ${powerShellSingleQuote(commit.timestamp)}`,
      `    $env:GIT_COMMITTER_DATE = ${powerShellSingleQuote(commit.timestamp)}`,
      ...(email
        ? [
            `    $env:GIT_AUTHOR_EMAIL = ${powerShellSingleQuote(email)}`,
            `    $env:GIT_COMMITTER_EMAIL = ${powerShellSingleQuote(email)}`,
          ]
        : []),
      `    git commit --allow-empty -m ${powerShellSingleQuote(commit.message)}`,
      "    if ($LASTEXITCODE -ne 0) { throw 'Git commit failed.' }",
      '    $hasHead = $true',
      '    $createdCount += 1',
      '  }',
    );
  }
  lines.push(
    '} finally {',
    "  [Environment]::SetEnvironmentVariable('GIT_AUTHOR_DATE', $previousAuthorDate, 'Process')",
    "  [Environment]::SetEnvironmentVariable('GIT_COMMITTER_DATE', $previousCommitterDate, 'Process')",
    "  [Environment]::SetEnvironmentVariable('GIT_AUTHOR_EMAIL', $previousAuthorEmail, 'Process')",
    "  [Environment]::SetEnvironmentVariable('GIT_COMMITTER_EMAIL', $previousCommitterEmail, 'Process')",
    '}',
    '',
    'Write-Host "Created $createdCount empty commits; skipped $skippedCount existing commits."',
    '',
  );
  return lines.join('\n');
}

export function generateScript(format, design, snapshot) {
  if (format !== 'bash' && format !== 'powershell') {
    throw new RangeError("format must be 'bash' or 'powershell'");
  }
  if (snapshot !== undefined) assertSnapshotDoesNotOverlap(design, snapshot);
  const email = validatedEmail(design.email);
  const exportId = stableExportId(design);
  const commits = commitPlan(design, exportId);
  const phrase = confirmationPhrase(commits.length, exportId);
  return format === 'bash'
    ? bashScript(commits, phrase, email)
    : powerShellScript(commits, phrase, email);
}
