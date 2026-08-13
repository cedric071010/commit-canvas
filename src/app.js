import { DEFAULT_LOCALE, createI18n, localizeDocument } from './i18n.js';

const REQUIRED_EXPORTS = [
  'COLS',
  'ROWS',
  'DEFAULT_LEVEL_COUNTS',
  'MAX_COMMITS',
  'isoDateLocal',
  'gridDates',
  'computeSummary',
  'serializeDesign',
  'parseDesign',
  'parseContributionSnapshot',
  'buildCommitPlan',
  'generateScript',
];

const IMPORT_LIMIT_BYTES = 1024 * 1024;
const WARNING_COMMITS = 200;
const PENDING_JOB_STORAGE_KEY = 'commit-canvas-pending-job-id';
const API_ERROR_CODES = new Set([
  'ACCOUNT_CHANGED',
  'AMBIGUOUS_REF_UPDATE',
  'CLI_FAILED',
  'CLI_UNAVAILABLE',
  'DEFAULT_BRANCH_CHANGED',
  'GITHUB_REQUEST_FAILED',
  'HEAD_MOVED',
  'HISTORY_LIMIT_REACHED',
  'INSUFFICIENT_PERMISSION',
  'INVALID_INPUT',
  'INVALID_PLAN',
  'INVALID_RESPONSE',
  'UNMANAGED_REPOSITORY',
  'ACCOUNT_MISMATCH',
  'API_NOT_FOUND',
  'CONFIRMATION_MISMATCH',
  'INTERNAL_ERROR',
  'JOB_NOT_FOUND',
  'LIVE_UNAVAILABLE',
  'PAYLOAD_TOO_LARGE',
  'REPOSITORY_CHANGED',
  'REQUEST_FORBIDDEN',
  'REQUEST_INVALID',
  'SUBMISSION_ACTIVE',
  'UNSUPPORTED_MEDIA_TYPE',
]);
const TIME_ZONES = [
  'UTC',
  'Asia/Singapore',
  'Asia/Shanghai',
  'Asia/Hong_Kong',
  'Asia/Taipei',
  'Asia/Tokyo',
  'Asia/Seoul',
  'Asia/Kolkata',
  'Australia/Sydney',
  'Europe/London',
  'Europe/Paris',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'America/Toronto',
  'America/Sao_Paulo',
];

const ui = createI18n(DEFAULT_LOCALE);

let toastTimer;

export function projectPlanOntoDates(plannedByDate, nextDates, blockedByDate = new Map()) {
  if (!(plannedByDate instanceof Map) || !(blockedByDate instanceof Map) || !Array.isArray(nextDates)) {
    throw new TypeError('plan projection requires maps and a date array');
  }
  const nextDateSet = new Set(nextDates.map((dateInfo) => dateInfo.date));
  const lostOutsideRange = [...plannedByDate].filter(
    ([date, level]) => level > 0 && !nextDateSet.has(date),
  ).length;
  let clearedExisting = 0;
  const levels = nextDates.map((dateInfo) => {
    const plannedLevel = plannedByDate.get(dateInfo.date) ?? 0;
    if (plannedLevel > 0 && (blockedByDate.get(dateInfo.date)?.count ?? 0) > 0) {
      clearedExisting += 1;
      return 0;
    }
    return dateInfo.isFuture ? 0 : plannedLevel;
  });
  return { levels, lostOutsideRange, clearedExisting };
}

export function contributionCellLabel(snapshotLoaded, existingCount, plannedCount, locale = DEFAULT_LOCALE) {
  const labels = createI18n(locale);
  const baseline = snapshotLoaded
    ? labels.plural('cell.existing', existingCount)
    : labels.t('cell.unchecked');
  return labels.t('cell.combined', { baseline, planned: labels.plural('cell.planned', plannedCount) });
}

export function contributionGrowthConfirmed(beforeByDate, plannedByDate, afterByDate) {
  if (!(beforeByDate instanceof Map) || !(plannedByDate instanceof Map) || !(afterByDate instanceof Map)) {
    throw new TypeError('contribution growth confirmation requires maps');
  }
  if (plannedByDate.size === 0) return false;
  return [...plannedByDate].every(([date, plannedCount]) => (
    Number.isInteger(plannedCount)
    && plannedCount > 0
    && (afterByDate.get(date)?.count ?? 0) >= (beforeByDate.get(date)?.count ?? 0) + plannedCount
  ));
}

export function liveConfirmationReady(typedPhrase, expectedPhrase, totalCommits, highVolumeAccepted) {
  return typedPhrase === expectedPhrase
    && (totalCommits < WARNING_COMMITS || highVolumeAccepted === true);
}

function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(ui.t('error.missingElement', { id }));
  return node;
}

function showFatal(error) {
  const toast = document.getElementById('toast');
  if (toast) {
    toast.textContent = ui.t('error.startup', { message: friendlyError(error) });
    toast.classList.add('is-visible', 'is-error');
  }
  document.querySelectorAll('button, input, select').forEach((control) => {
    control.disabled = true;
  });
}

function friendlyError(error) {
  if (!(error instanceof Error)) return ui.t('error.unknownRefresh');
  if (API_ERROR_CODES.has(error.code)) return ui.t(`apiError.${error.code}`);
  const translations = [
    [/limit is (\d+)/i, (match) => ui.t('error.limit', { count: match[1] })],
    [/at least one non-future commit/i, () => ui.t('error.noCommit')],
    [/valid email address/i, () => ui.t('error.email')],
    [/not valid JSON/i, () => ui.t('error.json')],
    [/contribution snapshot|snapshot/i, () => ui.t('error.snapshot')],
    [/unsupported design version/i, () => ui.t('error.designVersion')],
    [/missing or unknown fields/i, () => ui.t('error.fields')],
    [/time zone/i, () => ui.t('error.timeZone')],
    [/levels/i, () => ui.t('error.levels')],
    [/counts/i, () => ui.t('error.counts')],
    [/endDate|calendar date|YYYY-MM-DD/i, () => ui.t('error.date')],
  ];
  for (const [pattern, message] of translations) {
    const match = error.message.match(pattern);
    if (match) return message(match);
  }
  return error.message || ui.t('error.unknown');
}

function apiErrorMessage(code) {
  return ui.t(API_ERROR_CODES.has(code) ? `apiError.${code}` : 'apiError.INTERNAL_ERROR');
}

function translatedPhase(phase) {
  try {
    return ui.t(`phase.${phase}`);
  } catch {
    return String(phase ?? '');
  }
}

async function main() {
  localizeDocument(document, ui);
  const core = await import('./core.js');
  for (const name of REQUIRED_EXPORTS) {
    if (!(name in core)) throw new Error(ui.t('error.coreExport', { name }));
  }

  const { COLS, ROWS, DEFAULT_LEVEL_COUNTS, MAX_COMMITS } = core;
  const cellCount = COLS * ROWS;
  if (COLS !== 53 || ROWS !== 7 || DEFAULT_LEVEL_COUNTS.length !== 5) {
    throw new Error(ui.t('error.coreConfig'));
  }

  const elements = {
    grid: byId('commit-grid'),
    monthLabels: byId('month-labels'),
    canvasShell: byId('canvas-shell'),
    endDate: byId('end-date'),
    timezone: byId('timezone'),
    email: byId('email'),
    total: byId('total-commits'),
    paintedDays: byId('painted-days'),
    dateRange: byId('date-range'),
    limitStatus: byId('limit-status'),
    undo: byId('undo-button'),
    redo: byId('redo-button'),
    clear: byId('clear-button'),
    zoom: byId('zoom-button'),
    zoomLabel: byId('zoom-label'),
    pan: byId('pan-button'),
    panLabel: byId('pan-label'),
    exportJson: byId('export-json-button'),
    importJson: byId('import-json-button'),
    importFile: byId('import-file'),
    importSnapshot: byId('import-snapshot-button'),
    unloadSnapshot: byId('unload-snapshot-button'),
    snapshotFile: byId('snapshot-file'),
    snapshotAccount: byId('snapshot-account'),
    snapshotGeneratedAt: byId('snapshot-generated-at'),
    snapshotRange: byId('snapshot-range'),
    snapshotExistingStatus: byId('snapshot-existing-status'),
    snapshotNotice: byId('snapshot-notice'),
    exportForm: byId('export-form'),
    confirmDialog: byId('confirm-dialog'),
    confirmTitle: byId('confirm-title'),
    confirmMessage: byId('confirm-message'),
    confirmAction: byId('confirm-action'),
    scriptDialog: byId('script-dialog'),
    scriptOutput: byId('script-output'),
    scriptMeta: byId('script-meta'),
    reviewConfirm: byId('review-confirm'),
    copyScript: byId('copy-script-button'),
    downloadScript: byId('download-script-button'),
    closeScript: byId('close-script-button'),
    liveModeBadge: byId('live-mode-badge'),
    connectStatus: byId('connect-status'),
    refreshContributions: byId('refresh-contributions-button'),
    liveAccount: byId('live-account'),
    liveRepository: byId('live-repository'),
    managedRepoName: byId('managed-repo-name'),
    managedRepoVisibility: byId('managed-repo-visibility'),
    setupRepository: byId('setup-repository-button'),
    livePlanSummary: byId('live-plan-summary'),
    submitLive: byId('submit-live-button'),
    resumeSubmission: byId('resume-submission-button'),
    dismissSubmission: byId('dismiss-submission-button'),
    liveSubmitStatus: byId('live-submit-status'),
    liveProgress: byId('live-progress'),
    liveDialog: byId('live-dialog'),
    liveReviewAccount: byId('live-review-account'),
    liveReviewRepository: byId('live-review-repository'),
    liveReviewBranch: byId('live-review-branch'),
    liveReviewCount: byId('live-review-count'),
    liveReviewDates: byId('live-review-dates'),
    liveConfirmInput: byId('live-confirm-input'),
    liveConfirmPhrase: byId('live-confirm-phrase'),
    liveHighVolumeConfirmWrap: byId('live-high-volume-confirm-wrap'),
    liveHighVolumeConfirm: byId('live-high-volume-confirm'),
    confirmLiveSubmit: byId('confirm-live-submit-button'),
    closeLiveDialog: byId('close-live-dialog-button'),
    toast: byId('toast'),
  };

  const state = {
    levels: Array(cellCount).fill(0),
    dates: [],
    selectedLevel: 0,
    counts: [...DEFAULT_LEVEL_COUNTS],
    undo: [],
    redo: [],
    cells: [],
    renderedEndDate: '',
    renderedTimeZone: '',
    panMode: false,
    pointerStroke: null,
    generatedScript: '',
    generatedFormat: 'bash',
    snapshot: null,
    byDate: new Map(),
    live: false,
    csrfToken: '',
    account: null,
    repository: null,
    liveSnapshotAccount: '',
    livePlan: null,
    submitting: false,
    pendingJobId: '',
    submissionContext: null,
  };
  let liveStatusDescriptor = { key: 'live.status.initial', values: {}, kind: 'info', link: null };

  function applyLocale(locale) {
    window.clearTimeout(toastTimer);
    elements.toast.classList.remove('is-visible');
    ui.setLocale(locale);
    localizeDocument(document, ui);
    document.querySelectorAll('[data-locale]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.locale === ui.locale));
    });
    const browserOption = elements.timezone.querySelector('[data-browser-time-zone="true"]');
    if (browserOption) browserOption.textContent = ui.t('timezone.browser', { timeZone: browserOption.value });
    if (state.dates.length) {
      renderMonths();
      renderAllCells();
      updateSummary();
    }
    renderSnapshotStatus();
    renderLiveMode();
    renderLiveStatusDescriptor();
    setLiveProgress(elements.liveProgress.value, elements.liveProgress.max);
    elements.zoomLabel.textContent = ui.t(elements.canvasShell.classList.contains('is-zoomed') ? 'view.zoomOut' : 'view.zoomIn');
    elements.panLabel.textContent = ui.t(state.panMode ? 'view.draw' : 'view.pan');
    renderLiveReview();
    renderGeneratedScriptMeta();
  }

  function toast(message, kind = 'info') {
    window.clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.classList.toggle('is-error', kind === 'error');
    elements.toast.classList.add('is-visible');
    toastTimer = window.setTimeout(() => elements.toast.classList.remove('is-visible'), 3300);
  }

  function safeSummary(levels = state.levels) {
    try {
      return core.computeSummary(levels, state.counts);
    } catch (error) {
      showFatal(error);
      return { totalCommits: 0, paintedDays: 0, activeCells: 0 };
    }
  }

  function totalOf(summary) {
    return Number(summary.totalCommits ?? summary.total ?? 0);
  }

  function paintedOf(summary) {
    return Number(summary.paintedDays ?? summary.activeCells ?? 0);
  }

  function updateHistoryButtons() {
    elements.undo.disabled = state.undo.length === 0;
    elements.redo.disabled = state.redo.length === 0;
  }

  function updateSummary() {
    const summary = safeSummary();
    const total = totalOf(summary);
    elements.total.textContent = ui.formatNumber(total);
    elements.paintedDays.textContent = ui.formatNumber(paintedOf(summary));
    const lastUsable = [...state.dates].reverse().find((cell) => !cell.isFuture);
    elements.dateRange.textContent = state.dates.length && lastUsable
      ? `${ui.formatIsoDate(state.dates[0].date)} — ${ui.formatIsoDate(lastUsable.date)}`
      : '—';

    elements.limitStatus.classList.remove('is-warning', 'is-error');
    const statusText = elements.limitStatus.lastElementChild;
    if (total >= MAX_COMMITS) {
      elements.limitStatus.classList.add('is-error');
      statusText.textContent = ui.t('summary.limit', { count: ui.formatNumber(MAX_COMMITS) });
    } else if (total >= WARNING_COMMITS) {
      elements.limitStatus.classList.add('is-warning');
      statusText.textContent = ui.t('summary.warning', { total: ui.formatNumber(total), limit: ui.formatNumber(MAX_COMMITS) });
    } else {
      statusText.textContent = ui.t('summary.ready', { limit: ui.formatNumber(MAX_COMMITS) });
    }
    renderLivePlanSummary();
  }

  function updateCell(index) {
    const cell = state.cells[index];
    const dateInfo = state.dates[index];
    if (!cell || !dateInfo) return;
    const level = state.levels[index];
    const count = state.counts[level];
    const existing = state.byDate.get(dateInfo.date);
    const existingCount = existing?.count ?? 0;
    cell.dataset.level = String(level);
    cell.dataset.existingLevel = String(existing?.level ?? 0);
    cell.classList.toggle('has-existing', existingCount > 0);
    cell.classList.toggle('has-plan', level > 0);
    cell.disabled = dateInfo.isFuture;
    cell.dataset.date = dateInfo.date;
    const contributionLabel = contributionCellLabel(Boolean(state.snapshot), existingCount, count, ui.locale);
    const qualifiers = [
      existingCount > 0 ? ui.t('cell.readOnly') : '',
      dateInfo.isFuture ? ui.t('cell.future') : '',
    ].filter(Boolean).map((value) => ui.t('cell.qualifier', { value })).join('');
    cell.setAttribute('aria-label', ui.t('cell.parts', {
      date: ui.formatIsoDate(dateInfo.date),
      weekday: ui.formatWeekday(dateInfo.date),
      contribution: contributionLabel,
      qualifiers,
    }));
    cell.title = [ui.formatIsoDate(dateInfo.date), contributionLabel, existingCount > 0 ? ui.t('cell.readOnly') : ''].filter(Boolean).join(' · ');
  }

  function renderAllCells() {
    for (let index = 0; index < cellCount; index += 1) updateCell(index);
  }

  function renderMonths() {
    elements.monthLabels.replaceChildren();
    let previousMonth = '';
    for (let col = 0; col < COLS; col += 1) {
      const date = state.dates[col * ROWS]?.date;
      const label = document.createElement('span');
      label.className = 'month-label';
      if (date) {
        const month = date.slice(0, 7);
        if (month !== previousMonth) {
          label.textContent = ui.formatMonth(date);
          previousMonth = month;
        }
      }
      elements.monthLabels.append(label);
    }
  }

  function setRovingIndex(index, focus = false) {
    const safeIndex = Math.max(0, Math.min(cellCount - 1, index));
    for (const cell of state.cells) cell.tabIndex = -1;
    const target = state.cells[safeIndex];
    if (target && !target.disabled) {
      target.tabIndex = 0;
      if (focus) target.focus();
      return;
    }
    const fallback = state.cells.find((cell) => !cell.disabled);
    if (fallback) {
      fallback.tabIndex = 0;
      if (focus) fallback.focus();
    }
  }

  function renderDates() {
    state.dates = core.gridDates(elements.endDate.value, elements.timezone.value);
    if (!Array.isArray(state.dates) || state.dates.length !== cellCount) {
      throw new Error(ui.t('error.coreGrid'));
    }
    for (const dateInfo of state.dates) {
      if (dateInfo.isFuture) state.levels[dateInfo.index] = 0;
    }
    renderMonths();
    renderAllCells();
    const current = document.activeElement?.dataset?.index;
    setRovingIndex(current === undefined ? 0 : Number(current));
    updateSummary();
    state.renderedEndDate = elements.endDate.value;
    state.renderedTimeZone = elements.timezone.value;
  }

  function makeCells() {
    const fragment = document.createDocumentFragment();
    state.cells = Array(cellCount);
    for (let row = 0; row < ROWS; row += 1) {
      const rowElement = document.createElement('div');
      rowElement.className = 'grid-row';
      rowElement.setAttribute('role', 'row');
      rowElement.setAttribute('aria-rowindex', String(row + 1));
      for (let col = 0; col < COLS; col += 1) {
        const index = col * ROWS + row;
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'grid-cell';
        cell.dataset.index = String(index);
        cell.dataset.level = '0';
        cell.setAttribute('role', 'gridcell');
        cell.setAttribute('aria-colindex', String(col + 1));
        cell.tabIndex = index === 0 ? 0 : -1;
        state.cells[index] = cell;
        rowElement.append(cell);
      }
      fragment.append(rowElement);
    }
    elements.grid.replaceChildren(fragment);
  }

  function snapshot(renderedControls = false) {
    return {
      levels: [...state.levels],
      endDate: renderedControls ? state.renderedEndDate : elements.endDate.value,
      timeZone: renderedControls ? state.renderedTimeZone : elements.timezone.value,
    };
  }

  function snapshotsEqual(left, right) {
    return left.endDate === right.endDate
      && left.timeZone === right.timeZone
      && left.levels.every((level, index) => level === right.levels[index]);
  }

  function pushUndo(before) {
    if (snapshotsEqual(before, snapshot())) return;
    state.undo.push(before);
    if (state.undo.length > 100) state.undo.shift();
    state.redo.length = 0;
    updateHistoryButtons();
  }

  function restoreSnapshot(saved) {
    ensureTimeZoneOption(saved.timeZone);
    elements.endDate.value = saved.endDate;
    elements.timezone.value = saved.timeZone;
    state.levels = [...saved.levels];
    renderDates();
  }

  function restoreLevels(levels) {
    state.levels = [...levels];
    renderAllCells();
    updateSummary();
  }

  function undo() {
    const previous = state.undo.pop();
    if (!previous) return;
    state.redo.push(snapshot());
    restoreSnapshot(previous);
    updateHistoryButtons();
    toast(ui.t('toast.undo'));
  }

  function redo() {
    const next = state.redo.pop();
    if (!next) return;
    state.undo.push(snapshot());
    restoreSnapshot(next);
    updateHistoryButtons();
    toast(ui.t('toast.redo'));
  }

  function selectLevel(level) {
    if (!Number.isInteger(level) || level < 0 || level >= state.counts.length) return;
    state.selectedLevel = level;
    document.querySelectorAll('[data-level].level-button').forEach((button) => {
      const selected = Number(button.dataset.level) === level;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    toast(level === 0
      ? ui.t('toast.eraser')
      : ui.t('toast.level', { level: ui.formatNumber(level), count: ui.formatNumber(state.counts[level]) }));
  }

  function paint(index, quiet = false) {
    const dateInfo = state.dates[index];
    if (!dateInfo || dateInfo.isFuture || (state.byDate.get(dateInfo.date)?.count ?? 0) > 0 || state.levels[index] === state.selectedLevel) return false;
    const summary = safeSummary();
    const projected = totalOf(summary) - state.counts[state.levels[index]] + state.counts[state.selectedLevel];
    if (projected > MAX_COMMITS) {
      if (!quiet) toast(ui.t('toast.planLimit', { count: ui.formatNumber(MAX_COMMITS) }), 'error');
      return false;
    }
    state.levels[index] = state.selectedLevel;
    updateCell(index);
    updateSummary();
    return true;
  }

  function endPointerStroke() {
    const stroke = state.pointerStroke;
    if (!stroke) return;
    state.pointerStroke = null;
    elements.grid.classList.remove('is-drawing');
    pushUndo(stroke.before);
  }

  function focusNearest(targetIndex, direction, fallbackIndex) {
    let index = Math.max(0, Math.min(cellCount - 1, targetIndex));
    const step = direction || 1;
    while (index >= 0 && index < cellCount && state.cells[index]?.disabled) index += step;
    if (index < 0 || index >= cellCount) index = fallbackIndex;
    setRovingIndex(index, true);
  }

  function confirmAction({ title, message, confirmLabel = ui.t('dialog.confirm'), danger = true }) {
    elements.confirmTitle.textContent = title;
    elements.confirmMessage.textContent = message;
    elements.confirmAction.textContent = confirmLabel;
    elements.confirmAction.classList.toggle('button-danger', danger);
    elements.confirmAction.classList.toggle('button-primary', !danger);
    elements.confirmDialog.returnValue = '';
    elements.confirmDialog.showModal();
    return new Promise((resolve) => {
      elements.confirmDialog.addEventListener('close', () => {
        resolve(elements.confirmDialog.returnValue === 'confirm');
      }, { once: true });
    });
  }

  function templateLevels(name) {
    const levels = Array(cellCount).fill(0);
    const set = (col, row, level = 3) => {
      if (col >= 0 && col < COLS && row >= 0 && row < ROWS) levels[col * ROWS + row] = level;
    };

    if (name === 'heart') {
      const rows = [
        '01100110',
        '11111111',
        '11111111',
        '01111110',
        '00111100',
        '00011000',
        '00000000',
      ];
      const start = 22;
      rows.forEach((row, y) => [...row].forEach((pixel, x) => pixel === '1' && set(start + x, y, 3)));
    } else if (name === 'hello') {
      const font = {
        H: ['101', '101', '111', '101', '101'],
        E: ['111', '100', '110', '100', '111'],
        L: ['100', '100', '100', '100', '111'],
        O: ['111', '101', '101', '101', '111'],
      };
      let col = 16;
      for (const letter of 'HELLO') {
        font[letter].forEach((row, y) => [...row].forEach((pixel, x) => pixel === '1' && set(col + x, y + 1, 2)));
        col += 4;
      }
    } else if (name === 'wave') {
      for (let col = 3; col < 50; col += 1) {
        const row = Math.round(3 + Math.sin((col - 3) / 3.2) * 2);
        set(col, row, col % 3 === 0 ? 4 : 2);
        if (col % 2 === 0) set(col, Math.min(6, row + 1), 1);
      }
    } else if (name === 'stars') {
      const stars = [[7, 1], [15, 4], [25, 2], [35, 5], [45, 1]];
      for (const [col, row] of stars) {
        set(col, row, 4);
        set(col - 1, row, 2);
        set(col + 1, row, 2);
        set(col, row - 1, 2);
        set(col, row + 1, 2);
      }
    }
    state.dates.forEach((dateInfo) => {
      if (dateInfo.isFuture || (state.byDate.get(dateInfo.date)?.count ?? 0) > 0) levels[dateInfo.index] = 0;
    });
    return levels;
  }

  async function applyTemplate(name) {
    if (paintedOf(safeSummary()) > 0) {
      const accepted = await confirmAction({
        title: ui.t('template.replace.title'),
        message: ui.t('template.replace.body'),
        confirmLabel: ui.t('template.replace.confirm'),
      });
      if (!accepted) return;
    }
    const next = templateLevels(name);
    if (totalOf(safeSummary(next)) > MAX_COMMITS) {
      toast(ui.t('template.limit', { count: ui.formatNumber(MAX_COMMITS) }), 'error');
      return;
    }
    const before = snapshot();
    restoreLevels(next);
    pushUndo(before);
    toast(ui.t('template.applied'));
  }

  function currentDesign() {
    return {
      version: 1,
      endDate: elements.endDate.value,
      timeZone: elements.timezone.value,
      counts: [...state.counts],
      levels: [...state.levels],
    };
  }

  function plannedLevelsByDate() {
    return new Map(state.dates.map((dateInfo) => [dateInfo.date, state.levels[dateInfo.index]]));
  }

  function renderSnapshotStatus() {
    const loaded = Boolean(state.snapshot);
    elements.unloadSnapshot.disabled = !loaded;
    elements.snapshotNotice.classList.toggle('is-loaded', loaded);
    if (!loaded) {
      elements.snapshotAccount.textContent = '—';
      elements.snapshotGeneratedAt.textContent = '—';
      elements.snapshotRange.textContent = '—';
      elements.snapshotExistingStatus.textContent = ui.t('snapshot.unchecked');
      elements.snapshotNotice.textContent = ui.t('snapshot.none.notice');
      return;
    }
    const existingDays = state.snapshot.days.filter((day) => day.count > 0).length;
    const generatedAt = new Date(state.snapshot.generatedAt);
    elements.snapshotAccount.textContent = state.snapshot.account;
    elements.snapshotGeneratedAt.textContent = Number.isNaN(generatedAt.valueOf())
      ? state.snapshot.generatedAt
      : ui.formatDateTime(generatedAt);
    elements.snapshotRange.textContent = `${ui.formatIsoDate(state.snapshot.rangeStart)} — ${ui.formatIsoDate(state.snapshot.rangeEnd)}`;
    elements.snapshotExistingStatus.textContent = ui.plural('snapshot.days', existingDays);
    elements.snapshotNotice.textContent = state.liveSnapshotAccount === state.snapshot.account
      ? ui.t('snapshot.liveLoaded', { account: state.snapshot.account })
      : ui.t('snapshot.fileLoaded', { account: state.snapshot.account });
  }

  function unloadSnapshot(message = ui.t('snapshot.unloaded')) {
    state.snapshot = null;
    state.byDate = new Map();
    state.liveSnapshotAccount = '';
    renderSnapshotStatus();
    renderAllCells();
    toast(message);
  }

  async function applyContributionSnapshot(parsed, { source = 'file', confirmChanges = true } = {}) {
    const before = snapshot();
    const nextByDate = new Map(parsed.days.map((day) => [day.date, day]));
    const nextDates = core.gridDates(parsed.rangeEnd, elements.timezone.value);
    const projection = projectPlanOntoDates(plannedLevelsByDate(), nextDates, nextByDate);
    if (confirmChanges && (projection.clearedExisting > 0 || projection.lostOutsideRange > 0)) {
      const effects = [
        projection.clearedExisting > 0 ? ui.plural('snapshot.effect.clear', projection.clearedExisting) : '',
        projection.lostOutsideRange > 0 ? ui.plural('snapshot.effect.lose', projection.lostOutsideRange) : '',
      ].filter(Boolean).reduce((first, second) => first ? ui.t('snapshot.effect.join', { first, second }) : second, '');
      const accepted = await confirmAction({
        title: ui.t('snapshot.adjust.title'),
        message: ui.t('snapshot.adjust.body', { date: ui.formatIsoDate(parsed.rangeEnd), effects }),
        confirmLabel: ui.t('snapshot.adjust.confirm'),
      });
      if (!accepted) return null;
    }
    elements.endDate.value = parsed.rangeEnd;
    state.snapshot = parsed;
    state.liveSnapshotAccount = source === 'live' ? parsed.account : '';
    state.byDate = nextByDate;
    state.dates = nextDates;
    state.levels = projection.levels;
    const planChanged = projection.clearedExisting > 0 || projection.lostOutsideRange > 0;
    if (source === 'live') {
      if (planChanged) pushUndo(before);
    } else {
      state.undo.length = 0;
      state.redo.length = 0;
    }
    renderDates();
    renderSnapshotStatus();
    updateHistoryButtons();
    return projection;
  }

  async function importContributionSnapshot(file) {
    if (!file) return;
    if (file.size > IMPORT_LIMIT_BYTES) {
      toast(ui.t('error.fileTooLarge'), 'error');
      return;
    }
    try {
      const parsed = core.parseContributionSnapshot(await file.text());
      const projection = await applyContributionSnapshot(parsed, { source: 'file' });
      if (!projection) return;
      const changes = [
        projection.clearedExisting > 0 ? ui.plural('snapshot.change.clear', projection.clearedExisting) : '',
        projection.lostOutsideRange > 0 ? ui.plural('snapshot.change.remove', projection.lostOutsideRange) : '',
      ].filter(Boolean).join(ui.locale === 'zh-Hans' ? '，' : ', ');
      toast(ui.t('snapshot.imported', {
        account: parsed.account,
        changes: changes ? `${ui.t('snapshot.changePrefix')}${changes}` : '',
      }));
    } catch (error) {
      toast(ui.t('snapshot.importFailed', { message: friendlyError(error) }), 'error');
    } finally {
      elements.snapshotFile.value = '';
    }
  }

  function renderLiveStatus(message, kind = 'info', link = null) {
    elements.liveSubmitStatus.replaceChildren(document.createTextNode(message));
    elements.liveSubmitStatus.classList.toggle('is-error', kind === 'error');
    if (link?.href) {
      const anchor = document.createElement('a');
      try {
        const url = new URL(link.href, window.location.origin);
        if (url.protocol !== 'https:' && url.origin !== window.location.origin) return;
        anchor.href = url.href;
      } catch {
        return;
      }
      anchor.textContent = link.labelKey ? ui.t(link.labelKey) : (link.label || ui.t('link.github'));
      anchor.target = '_blank';
      anchor.rel = 'noopener';
      elements.liveSubmitStatus.append(' ', anchor);
    }
  }

  function renderLiveStatusDescriptor() {
    const descriptor = liveStatusDescriptor;
    const values = typeof descriptor.values === 'function' ? descriptor.values() : descriptor.values;
    const message = descriptor.key
      ? (descriptor.pluralCount === undefined
        ? ui.t(descriptor.key, values)
        : ui.plural(descriptor.key, descriptor.pluralCount, values))
      : descriptor.message;
    renderLiveStatus(message, descriptor.kind, descriptor.link);
  }

  function setLiveStatusKey(key, values = {}, kind = 'info', link = null, pluralCount) {
    liveStatusDescriptor = { key, values, kind, link, pluralCount };
    renderLiveStatusDescriptor();
  }

  function setLiveProgress(completed = 0, total = 0, phase = '') {
    const safeTotal = Math.max(0, Number(total) || 0);
    const safeCompleted = Math.max(0, Math.min(safeTotal, Number(completed) || 0));
    elements.liveProgress.max = safeTotal || 1;
    elements.liveProgress.value = safeCompleted;
    const displayPhase = phase ? translatedPhase(phase) : '';
    elements.liveProgress.setAttribute('aria-valuetext', ui.t('progress.value', {
      completed: ui.formatNumber(safeCompleted),
      total: ui.formatNumber(safeTotal),
      phase: displayPhase ? ui.t('progress.phase', { phase: displayPhase }) : '',
    }));
  }

  function renderLivePlanSummary() {
    const total = totalOf(safeSummary());
    elements.livePlanSummary.textContent = total > 0
      ? ui.plural('live.plan.count', total)
      : ui.t('live.plan.empty');
    elements.submitLive.disabled = !state.live || state.submitting || state.pendingJobId || total === 0 || !state.repository;
  }

  function renderLiveMode() {
    const connected = state.live && Boolean(state.account);
    elements.liveModeBadge.textContent = ui.t(connected ? 'live.badge.live' : 'live.badge.static');
    elements.liveModeBadge.classList.toggle('is-live', connected);
    elements.connectStatus.textContent = connected
      ? ui.t('live.connected', { account: state.account.login })
      : ui.t('live.static');
    elements.liveAccount.textContent = connected
      ? (state.account.name
        ? ui.t('live.accountName', { account: state.account.login, name: state.account.name })
        : `@${state.account.login}`)
      : ui.t('live.notConnected');
    elements.liveRepository.textContent = state.repository
      ? ui.t('live.repositoryFact', {
        repository: state.repository.fullName,
        visibility: ui.t(`repo.visibility.${state.repository.visibility}`),
        branch: state.repository.defaultBranch,
      })
      : ui.t('live.notConfigured');
    elements.refreshContributions.disabled = !connected || state.submitting;
    elements.managedRepoName.disabled = !connected || state.submitting;
    elements.managedRepoVisibility.disabled = !connected || state.submitting;
    elements.setupRepository.disabled = !connected || state.submitting;
    elements.resumeSubmission.hidden = !state.pendingJobId;
    elements.resumeSubmission.disabled = !connected || state.submitting;
    elements.dismissSubmission.hidden = !state.pendingJobId;
    elements.dismissSubmission.disabled = state.submitting;
    renderLivePlanSummary();
  }

  function rememberPendingJob(jobId) {
    if (!/^[a-f0-9]{32}$/.test(jobId)) throw new Error(ui.t('error.jobId'));
    state.pendingJobId = jobId;
    sessionStorage.setItem(PENDING_JOB_STORAGE_KEY, jobId);
  }

  function forgetPendingJob() {
    state.pendingJobId = '';
    state.submissionContext = null;
    sessionStorage.removeItem(PENDING_JOB_STORAGE_KEY);
  }

  function restorePendingJob() {
    const jobId = sessionStorage.getItem(PENDING_JOB_STORAGE_KEY) || '';
    if (/^[a-f0-9]{32}$/.test(jobId)) state.pendingJobId = jobId;
    else sessionStorage.removeItem(PENDING_JOB_STORAGE_KEY);
  }

  async function apiJson(path, { method = 'GET', body } = {}) {
    const options = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
    if (state.csrfToken) options.headers['X-Commit-Canvas-CSRF'] = state.csrfToken;
    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    let response;
    if (path === '/api/session') response = await fetch('/api/session', options);
    else if (path === '/api/contributions') response = await fetch('/api/contributions', options);
    else if (path === '/api/repository') response = await fetch('/api/repository', options);
    else if (path === '/api/submissions') response = await fetch('/api/submissions', options);
    else throw new Error(ui.t('error.apiPath'));
    return readApiResponse(response);
  }

  async function readApiResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('application/json')) {
      throw new Error(response.ok
        ? ui.t('error.apiUnavailable')
        : ui.t('error.serverStatus', { status: response.status }));
    }
    const payload = await response.json();
    if (!response.ok) {
      const code = API_ERROR_CODES.has(payload?.error?.code) ? payload.error.code : 'INTERNAL_ERROR';
      const error = new Error(apiErrorMessage(code));
      error.code = code;
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function getSubmissionJob(jobId) {
    const response = await fetch(`/api/submissions/${encodeURIComponent(jobId)}`, {
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json',
        'X-Commit-Canvas-CSRF': state.csrfToken,
      },
    });
    return readApiResponse(response);
  }

  async function refreshLiveContributions({ quiet = false, confirmChanges = true } = {}) {
    if (!state.live || !state.account) throw new Error(ui.t('error.liveDisconnected'));
    elements.refreshContributions.disabled = true;
    if (!quiet) setLiveStatusKey('live.refreshing');
    try {
      const payload = await apiJson('/api/contributions', {
        method: 'POST',
        body: { endDate: elements.endDate.value },
      });
      const parsed = core.parseContributionSnapshot(JSON.stringify(payload));
      if (parsed.account !== state.account.login) throw new Error(ui.t('error.accountMismatch'));
      const projection = await applyContributionSnapshot(parsed, { source: 'live', confirmChanges });
      if (!projection) return null;
      if (!quiet) {
        if (projection.clearedExisting > 0) {
          setLiveStatusKey('live.refreshedCleared', {}, 'info', null, projection.clearedExisting);
        } else {
          setLiveStatusKey('live.refreshed');
        }
      }
      return projection;
    } finally {
      renderLiveMode();
    }
  }

  async function setupManagedRepository() {
    if (!state.live) return;
    const name = elements.managedRepoName.value.trim();
    const visibility = elements.managedRepoVisibility.value;
    if (!/^commit-canvas(?:-[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?)?$/.test(name)) {
      setLiveStatusKey('repo.name.error', {}, 'error');
      elements.managedRepoName.focus();
      return;
    }
    elements.setupRepository.disabled = true;
    setLiveStatusKey('repo.settingUp');
    try {
      const payload = await apiJson('/api/repository', { method: 'POST', body: { name, visibility } });
      if (!payload?.repository?.fullName || !payload.repository.defaultBranch || !payload.repository.head) {
        throw new Error(ui.t('error.repositoryPayload'));
      }
      state.repository = payload.repository;
      renderLiveMode();
      setLiveStatusKey('repo.ready', {}, 'info', payload.repository.htmlUrl
        ? { href: payload.repository.htmlUrl, labelKey: 'repo.open' }
        : null);
    } catch (error) {
      setLiveStatusKey('repo.failed', () => ({ message: friendlyError(error) }), 'error');
    } finally {
      renderLiveMode();
    }
  }

  function liveDesign() {
    return { ...currentDesign(), email: state.account.noreplyEmail };
  }

  function renderLiveReview() {
    const plan = state.livePlan;
    if (!plan || !state.account || !state.repository) return;
    const dates = [...new Set(plan.commits.map((commit) => commit.timestamp.slice(0, 10)))];
    elements.liveReviewAccount.textContent = `@${state.account.login} · ${state.account.noreplyEmail}`;
    elements.liveReviewRepository.textContent = state.repository.fullName;
    elements.liveReviewBranch.textContent = state.repository.defaultBranch;
    elements.liveReviewCount.textContent = ui.formatNumber(plan.totalCommits);
    elements.liveReviewDates.textContent = `${ui.formatIsoDate(dates[0])} — ${ui.formatIsoDate(dates.at(-1))}`;
    elements.liveConfirmPhrase.textContent = plan.confirmationPhrase;
  }

  async function openLiveReview() {
    if (state.submitting) return;
    if (state.pendingJobId) {
      setLiveStatusKey('live.pendingBlocked', { id: state.pendingJobId }, 'error');
      return;
    }
    if (!state.live || !state.account) {
      setLiveStatusKey('live.openLocal', {}, 'error');
      return;
    }
    if (!state.repository) {
      setLiveStatusKey('live.setupFirst', {}, 'error');
      return;
    }
    if (totalOf(safeSummary()) === 0) {
      setLiveStatusKey('live.drawFirst', {}, 'error');
      return;
    }
    elements.submitLive.disabled = true;
    setLiveStatusKey('live.refreshBefore');
    try {
      const projection = await refreshLiveContributions({ quiet: true, confirmChanges: true });
      if (!projection) {
        setLiveStatusKey('live.refreshCancelled', {}, 'error');
        return;
      }
      if (projection.clearedExisting > 0) {
        setLiveStatusKey('live.overlap', {}, 'error', null, projection.clearedExisting);
        return;
      }
      if (state.liveSnapshotAccount !== state.account.login) throw new Error(ui.t('error.currentSnapshot'));
      const design = liveDesign();
      const plan = core.buildCommitPlan(design, state.snapshot);
      if (!plan?.confirmationPhrase || !Array.isArray(plan.commits) || plan.totalCommits < 1) {
        throw new Error(ui.t('error.plan'));
      }
      state.livePlan = {
        ...plan,
        design,
        expectedHead: state.repository.head,
        expectedDefaultBranch: state.repository.defaultBranch,
      };
      renderLiveReview();
      elements.liveConfirmInput.value = '';
      elements.liveHighVolumeConfirm.checked = false;
      elements.liveHighVolumeConfirmWrap.hidden = plan.totalCommits < WARNING_COMMITS;
      elements.confirmLiveSubmit.disabled = true;
      elements.liveDialog.showModal();
      elements.liveConfirmInput.focus();
    } catch (error) {
      setLiveStatusKey('live.reviewFailed', () => ({ message: friendlyError(error) }), 'error');
    } finally {
      renderLiveMode();
    }
  }

  async function pollSubmission(job) {
    let current = job;
    while (current.status !== 'succeeded' && current.status !== 'failed') {
      setLiveProgress(current.completed, current.total, current.phase);
      setLiveStatusKey('live.taskAccepted', () => ({
        phase: translatedPhase(current.phase || current.status),
        completed: ui.formatNumber(current.completed || 0),
        total: ui.formatNumber(current.total || 0),
      }));
      await new Promise((resolve) => window.setTimeout(resolve, 750));
      const payload = await getSubmissionJob(current.id);
      current = payload.job;
      if (!current?.id) throw new Error(ui.t('error.jobPayload'));
    }
    setLiveProgress(current.completed, current.total, current.phase);
    return current;
  }

  function acceptedJobInterrupted(error) {
    const jobId = state.pendingJobId;
    if (error?.status === 404) {
      setLiveStatusKey('live.taskLost', { id: jobId }, 'error');
      return;
    }
    setLiveStatusKey('live.pollInterrupted', () => ({ id: jobId, message: friendlyError(error) }), 'error');
  }

  async function dismissPendingSubmission() {
    if (!state.pendingJobId || state.submitting) return;
    const accepted = await confirmAction({
      title: ui.t('live.dismiss.title'),
      message: ui.t('live.dismiss.body', { id: state.pendingJobId }),
      confirmLabel: ui.t('live.dismiss.confirm'),
    });
    if (!accepted) return;
    forgetPendingJob();
    renderLiveMode();
    setLiveStatusKey('live.dismiss.done');
  }

  async function finishSuccessfulSubmission(completed, context) {
    if (context) {
      const submittedDates = new Set(context.plan.commits.map((commit) => commit.timestamp.slice(0, 10)));
      const before = snapshot();
      for (const dateInfo of state.dates) {
        if (submittedDates.has(dateInfo.date)) state.levels[dateInfo.index] = 0;
      }
      restoreLevels(state.levels);
      pushUndo(before);
    }
    if (state.repository && completed.result?.newHead) state.repository.head = completed.result.newHead;
    const resultUrl = completed.result?.commitUrl || completed.result?.htmlUrl || state.repository?.htmlUrl;
    const resultSha = completed.result?.newHead;
    const created = Number.isSafeInteger(completed.result?.created) ? completed.result.created : completed.created;
    const skipped = Number.isSafeInteger(completed.result?.skipped) ? completed.result.skipped : completed.skipped;
    let contributionConfirmed = false;
    if (context && created > 0 && skipped === 0) {
      try {
        await refreshLiveContributions({ quiet: true, confirmChanges: false });
        contributionConfirmed = contributionGrowthConfirmed(
          context.contributionCountsBeforeSubmit,
          context.plannedCountsByDate,
          state.byDate,
        );
      } catch { /* A failed indexing check does not change the successful push result. */ }
    }
    const detailsForLocale = () => {
      const countDetails = ui.t('live.countDetails', {
        created: ui.formatNumber(created ?? 0),
        skipped: ui.formatNumber(skipped ?? 0),
      });
      const resultDetails = resultSha ? ui.t('live.shaDetails', { sha: resultSha.slice(0, 12) }) : '';
      return `${countDetails}${resultDetails}`;
    };
    let messageKey;
    if (created === 0) {
      messageKey = 'live.result.none';
    } else if (skipped > 0) {
      messageKey = 'live.result.partial';
    } else if (contributionConfirmed) {
      messageKey = 'live.result.confirmed';
    } else {
      messageKey = 'live.result.indexing';
    }
    setLiveStatusKey(messageKey, () => ({ details: detailsForLocale() }), 'info', resultUrl
      ? { href: resultUrl, labelKey: 'live.result.link' }
      : null);
  }

  async function continueAcceptedSubmission(initialJob = null) {
    if (!state.pendingJobId || state.submitting) return;
    state.submitting = true;
    renderLiveMode();
    try {
      const firstJob = initialJob || (await getSubmissionJob(state.pendingJobId)).job;
      const completed = await pollSubmission(firstJob);
      if (completed.status === 'failed') {
        const code = API_ERROR_CODES.has(completed.error?.code) ? completed.error.code : 'INTERNAL_ERROR';
        forgetPendingJob();
        setLiveStatusKey('live.failed', () => ({ message: apiErrorMessage(code) }), 'error');
        return;
      }
      if (completed.status !== 'succeeded') throw new Error(ui.t('error.jobUnknownStatus'));
      await finishSuccessfulSubmission(completed, state.submissionContext);
      forgetPendingJob();
    } catch (error) {
      acceptedJobInterrupted(error);
    } finally {
      state.submitting = false;
      state.livePlan = null;
      elements.closeLiveDialog.disabled = false;
      renderLiveMode();
    }
  }

  async function confirmLiveSubmission() {
    const plan = state.livePlan;
    if (state.submitting || state.pendingJobId || !plan) return;
    if (!liveConfirmationReady(
      elements.liveConfirmInput.value,
      plan.confirmationPhrase,
      plan.totalCommits,
      elements.liveHighVolumeConfirm.checked,
    )) return;
    state.submitting = true;
    elements.confirmLiveSubmit.disabled = true;
    elements.closeLiveDialog.disabled = true;
    renderLiveMode();
    setLiveProgress(0, plan.totalCommits, 'queued');
    setLiveStatusKey('live.handingOff');
    const plannedCountsByDate = new Map();
    for (const commit of plan.commits) {
      const date = commit.timestamp.slice(0, 10);
      plannedCountsByDate.set(date, (plannedCountsByDate.get(date) ?? 0) + 1);
    }
    const contributionCountsBeforeSubmit = new Map(
      [...plannedCountsByDate.keys()].map((date) => [date, { count: state.byDate.get(date)?.count ?? 0 }]),
    );
    try {
      const payload = await apiJson('/api/submissions', {
        method: 'POST',
        body: {
          repository: state.repository.fullName,
          expectedHead: plan.expectedHead,
          expectedDefaultBranch: plan.expectedDefaultBranch,
          design: plan.design,
          confirmation: plan.confirmationPhrase,
        },
      });
      if (!payload?.job?.id) throw new Error(ui.t('error.jobMissing'));
      rememberPendingJob(payload.job.id);
      state.submissionContext = { plan, contributionCountsBeforeSubmit, plannedCountsByDate };
      elements.liveDialog.close();
      state.submitting = false;
      await continueAcceptedSubmission(payload.job);
    } catch (error) {
      if (state.pendingJobId) acceptedJobInterrupted(error);
      else setLiveStatusKey('live.submitFailed', () => ({ message: friendlyError(error) }), 'error');
    } finally {
      state.submitting = false;
      if (!state.pendingJobId) state.livePlan = null;
      elements.closeLiveDialog.disabled = false;
      renderLiveMode();
    }
  }

  async function initializeLiveMode() {
    renderLiveMode();
    try {
      const session = await apiJson('/api/session');
      if (session?.live !== true || !session.csrfToken || !session.account?.login || !session.account?.noreplyEmail) {
        throw new Error(ui.t('error.liveSession'));
      }
      state.live = true;
      state.csrfToken = session.csrfToken;
      state.account = session.account;
      restorePendingJob();
      renderLiveMode();
      if (state.pendingJobId) {
        await continueAcceptedSubmission();
        return;
      }
      try {
        await refreshLiveContributions();
      } catch (error) {
        setLiveStatusKey('live.connectedRefreshFailed', () => ({ message: friendlyError(error) }), 'error');
      }
    } catch {
      state.live = false;
      state.csrfToken = '';
      state.account = null;
      renderLiveMode();
    }
  }

  function downloadText(contents, filename, type) {
    const blob = new Blob([contents], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJson() {
    try {
      const serialized = core.serializeDesign(currentDesign());
      downloadText(serialized, `commit-canvas-${elements.endDate.value}.json`, 'application/json;charset=utf-8');
      toast(ui.t('archive.downloaded'));
    } catch (error) {
      toast(friendlyError(error), 'error');
    }
  }

  async function importJson(file) {
    if (!file) return;
    if (file.size > IMPORT_LIMIT_BYTES) {
      toast(ui.t('error.fileTooLarge'), 'error');
      return;
    }
    try {
      const parsed = core.parseDesign(await file.text());
      if (!parsed.counts.every((count, index) => count === DEFAULT_LEVEL_COUNTS[index])) {
        throw new Error(ui.t('error.unsupportedCounts'));
      }
      if (totalOf(core.computeSummary(parsed.levels, parsed.counts)) > MAX_COMMITS) {
        throw new Error(ui.t('error.archiveLimit', { count: ui.formatNumber(MAX_COMMITS) }));
      }
      const hasContent = paintedOf(safeSummary()) > 0;
      const unloadForDateChange = Boolean(state.snapshot && parsed.endDate !== state.snapshot.rangeEnd);
      const parsedDates = core.gridDates(parsed.endDate, parsed.timeZone);
      const snapshotConflicts = state.snapshot
        ? parsedDates.filter((dateInfo) => parsed.levels[dateInfo.index] > 0 && (state.byDate.get(dateInfo.date)?.count ?? 0) > 0)
        : [];
      if (hasContent || unloadForDateChange || snapshotConflicts.length > 0) {
        const snapshotEffect = unloadForDateChange
          ? ui.t('archive.importDateUnload')
          : snapshotConflicts.length > 0
            ? ui.plural('archive.importConflicts', snapshotConflicts.length)
            : '';
        const accepted = await confirmAction({
          title: ui.t('archive.import.title'),
          message: ui.t('archive.import.body', { effect: snapshotEffect }),
          confirmLabel: ui.t('archive.import.confirm'),
        });
        if (!accepted) return;
      }
      const before = snapshot();
      if (unloadForDateChange) {
        state.snapshot = null;
        state.byDate = new Map();
        state.liveSnapshotAccount = '';
        renderSnapshotStatus();
      }
      elements.endDate.value = parsed.endDate;
      ensureTimeZoneOption(parsed.timeZone);
      elements.timezone.value = parsed.timeZone;
      state.levels = [...parsed.levels];
      for (const dateInfo of parsedDates) {
        if ((state.byDate.get(dateInfo.date)?.count ?? 0) > 0) state.levels[dateInfo.index] = 0;
      }
      state.counts = [...DEFAULT_LEVEL_COUNTS];
      renderDates();
      pushUndo(before);
      toast(ui.t('archive.imported'));
    } catch (error) {
      toast(ui.t('archive.importFailed', { message: friendlyError(error) }), 'error');
    } finally {
      elements.importFile.value = '';
    }
  }

  function ensureTimeZoneOption(timeZone) {
    if ([...elements.timezone.options].some((option) => option.value === timeZone)) return;
    try {
      new Intl.DateTimeFormat('en', { timeZone }).format();
      const option = document.createElement('option');
      option.value = timeZone;
      option.textContent = ui.t('timezone.browser', { timeZone });
      option.dataset.browserTimeZone = 'true';
      elements.timezone.prepend(option);
    } catch {
      throw new Error('time zone is invalid');
    }
  }

  function populateTimeZones() {
    const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    ensureTimeZoneOption(browserTimeZone);
    for (const timeZone of TIME_ZONES) {
      if ([...elements.timezone.options].some((option) => option.value === timeZone)) continue;
      const option = document.createElement('option');
      option.value = timeZone;
      option.textContent = timeZone;
      elements.timezone.append(option);
    }
    elements.timezone.value = browserTimeZone;
  }

  async function copyText(text) {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.className = 'visually-hidden';
    area.setAttribute('readonly', '');
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    if (!copied) throw new Error(ui.t('error.copy'));
  }

  function renderGeneratedScriptMeta(total = totalOf(safeSummary())) {
    if (!state.generatedScript) return;
    const snapshotMeta = state.snapshot
      ? ui.t('script.meta.snapshot', {
        account: state.snapshot.account,
        generatedAt: ui.formatDateTime(state.snapshot.generatedAt),
        count: ui.formatNumber(state.snapshot.days.filter((day) => day.count > 0).length),
      })
      : ui.t('script.meta.unchecked');
    elements.scriptMeta.textContent = ui.t('script.meta', {
      format: state.generatedFormat === 'bash' ? 'Bash (.sh)' : 'PowerShell (.ps1)',
      count: ui.formatNumber(total),
      date: ui.formatIsoDate(elements.endDate.value),
      timeZone: elements.timezone.value,
      snapshot: snapshotMeta,
    });
  }

  async function generate(event) {
    event.preventDefault();
    if (!elements.exportForm.reportValidity()) return;
    const summary = safeSummary();
    const total = totalOf(summary);
    if (total === 0) {
      toast(ui.t('generate.empty'), 'error');
      return;
    }
    if (total > MAX_COMMITS) {
      toast(ui.t('generate.limit', { count: ui.formatNumber(MAX_COMMITS) }), 'error');
      return;
    }
    if (total >= WARNING_COMMITS) {
      const accepted = await confirmAction({
        title: ui.plural('generate.volume.title', total),
        message: ui.t('generate.volume.body'),
        confirmLabel: ui.t('generate.volume.confirm'),
        danger: false,
      });
      if (!accepted) return;
    }
    if (!state.snapshot) {
      const accepted = await confirmAction({
        title: ui.t('generate.unchecked.title'),
        message: ui.t('generate.unchecked.body'),
        confirmLabel: ui.t('generate.unchecked.confirm'),
        danger: false,
      });
      if (!accepted) return;
    }

    try {
      const format = new FormData(elements.exportForm).get('shell');
      const design = { ...currentDesign(), email: elements.email.value.trim() };
      state.generatedScript = state.snapshot
        ? core.generateScript(format, design, state.snapshot)
        : core.generateScript(format, design);
      state.generatedFormat = format;
      elements.scriptOutput.textContent = state.generatedScript;
      renderGeneratedScriptMeta(total);
      elements.reviewConfirm.checked = false;
      elements.copyScript.disabled = true;
      elements.downloadScript.disabled = true;
      elements.scriptDialog.showModal();
    } catch (error) {
      toast(ui.t('script.generateFailed', { message: friendlyError(error) }), 'error');
    }
  }

  function bindEvents() {
    document.querySelectorAll('[data-locale]').forEach((button) => {
      button.addEventListener('click', () => applyLocale(button.dataset.locale));
    });
    document.querySelectorAll('.level-button').forEach((button) => {
      button.addEventListener('click', () => selectLevel(Number(button.dataset.level)));
    });
    document.querySelectorAll('.template-card').forEach((button) => {
      button.addEventListener('click', () => applyTemplate(button.dataset.template));
    });

    elements.grid.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 && event.pointerType !== 'touch') return;
      if (state.panMode) return;
      const cell = event.target.closest('.grid-cell');
      if (!cell || cell.disabled) return;
      event.preventDefault();
      state.pointerStroke = { before: snapshot(), lastIndex: -1, warned: false };
      elements.grid.classList.add('is-drawing');
      const index = Number(cell.dataset.index);
      state.pointerStroke.lastIndex = index;
      const painted = paint(index, state.pointerStroke.warned);
      if (!painted && state.selectedLevel > 0) state.pointerStroke.warned = true;
    });

    elements.grid.addEventListener('pointermove', (event) => {
      if (!state.pointerStroke) return;
      event.preventDefault();
      const hit = document.elementFromPoint(event.clientX, event.clientY);
      const cell = hit?.closest?.('.grid-cell');
      if (!cell || !elements.grid.contains(cell) || cell.disabled) return;
      const index = Number(cell.dataset.index);
      if (index === state.pointerStroke.lastIndex) return;
      state.pointerStroke.lastIndex = index;
      const painted = paint(index, state.pointerStroke.warned);
      if (!painted && state.selectedLevel > 0) state.pointerStroke.warned = true;
    });
    window.addEventListener('pointerup', endPointerStroke);
    window.addEventListener('pointercancel', endPointerStroke);
    window.addEventListener('blur', endPointerStroke);

    elements.grid.addEventListener('focusin', (event) => {
      const cell = event.target.closest('.grid-cell');
      if (cell) setRovingIndex(Number(cell.dataset.index));
    });

    elements.grid.addEventListener('keydown', (event) => {
      const cell = event.target.closest('.grid-cell');
      if (!cell) return;
      const index = Number(cell.dataset.index);
      const col = Math.floor(index / ROWS);
      const row = index % ROWS;
      let target = null;
      let direction = 1;
      if (event.key === 'ArrowUp' && row > 0) { target = index - 1; direction = -1; }
      else if (event.key === 'ArrowDown' && row < ROWS - 1) target = index + 1;
      else if (event.key === 'ArrowLeft' && col > 0) { target = index - ROWS; direction = -ROWS; }
      else if (event.key === 'ArrowRight' && col < COLS - 1) { target = index + ROWS; direction = ROWS; }
      else if (event.key === 'Home') { target = row; direction = ROWS; }
      else if (event.key === 'End') { target = (COLS - 1) * ROWS + row; direction = -ROWS; }
      else if (event.key === 'PageUp') { target = Math.max(0, col - 7) * ROWS + row; direction = -ROWS; }
      else if (event.key === 'PageDown') { target = Math.min(COLS - 1, col + 7) * ROWS + row; direction = ROWS; }
      else if (event.key === ' ' || event.key === 'Enter') {
        event.preventDefault();
        const before = snapshot();
        if (paint(index)) pushUndo(before);
        return;
      } else if (/^[0-4]$/.test(event.key)) {
        event.preventDefault();
        selectLevel(Number(event.key));
        return;
      }
      if (target !== null) {
        event.preventDefault();
        focusNearest(target, direction, index);
      }
    });

    elements.undo.addEventListener('click', undo);
    elements.redo.addEventListener('click', redo);
    document.addEventListener('keydown', (event) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (document.querySelector('dialog[open]')) return;
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return;
      if (event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redo(); else undo();
      } else if (event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redo();
      }
    });

    elements.clear.addEventListener('click', async () => {
      if (paintedOf(safeSummary()) === 0) {
        toast(ui.t('canvas.alreadyEmpty'));
        return;
      }
      const accepted = await confirmAction({
        title: ui.t('canvas.clear.title'),
        message: ui.t('canvas.clear.body'),
        confirmLabel: ui.t('canvas.clear.confirm'),
      });
      if (!accepted) return;
      const before = snapshot();
      restoreLevels(Array(cellCount).fill(0));
      pushUndo(before);
      toast(ui.t('canvas.cleared'));
    });

    const updateCalendarControl = () => {
      const before = snapshot(true);
      try {
        renderDates();
        pushUndo(before);
      } catch (error) {
        restoreSnapshot(before);
        toast(friendlyError(error), 'error');
      }
    };
    elements.endDate.addEventListener('change', async () => {
      if (state.snapshot && elements.endDate.value !== state.snapshot.rangeEnd) {
        const requestedEndDate = elements.endDate.value;
        let nextDates;
        let projection;
        try {
          nextDates = core.gridDates(requestedEndDate, elements.timezone.value);
          projection = projectPlanOntoDates(plannedLevelsByDate(), nextDates);
        } catch (error) {
          elements.endDate.value = state.renderedEndDate;
          toast(friendlyError(error), 'error');
          return;
        }
        const lossWarning = projection.lostOutsideRange > 0
          ? ui.plural('calendar.loss', projection.lostOutsideRange)
          : ui.t('calendar.keep');
        const accepted = await confirmAction({
          title: ui.t('calendar.unload.title'),
          message: ui.t('calendar.unload.body', { effect: lossWarning }),
          confirmLabel: ui.t('calendar.unload.confirm'),
        });
        if (!accepted) {
          elements.endDate.value = state.renderedEndDate;
          return;
        }
        state.snapshot = null;
        state.byDate = new Map();
        state.liveSnapshotAccount = '';
        elements.endDate.value = requestedEndDate;
        state.dates = nextDates;
        state.levels = projection.levels;
        renderSnapshotStatus();
        renderDates();
        state.undo.length = 0;
        state.redo.length = 0;
        updateHistoryButtons();
        toast(ui.t('calendar.changed', {
          effect: projection.lostOutsideRange > 0 ? ui.plural('calendar.removed', projection.lostOutsideRange) : '',
        }));
        return;
      }
      updateCalendarControl();
    });
    elements.timezone.addEventListener('change', updateCalendarControl);

    elements.zoom.addEventListener('click', () => {
      const zoomed = elements.canvasShell.classList.toggle('is-zoomed');
      elements.zoom.setAttribute('aria-pressed', String(zoomed));
      elements.zoomLabel.textContent = ui.t(zoomed ? 'view.zoomOut' : 'view.zoomIn');
    });

    elements.pan.addEventListener('click', () => {
      endPointerStroke();
      state.panMode = !state.panMode;
      elements.canvasShell.classList.toggle('is-panning', state.panMode);
      elements.pan.setAttribute('aria-pressed', String(state.panMode));
      elements.panLabel.textContent = ui.t(state.panMode ? 'view.draw' : 'view.pan');
      toast(ui.t(state.panMode ? 'view.panOn' : 'view.panOff'));
    });

    elements.exportJson.addEventListener('click', exportJson);
    elements.importJson.addEventListener('click', () => elements.importFile.click());
    elements.importFile.addEventListener('change', () => importJson(elements.importFile.files?.[0]));
    elements.importSnapshot.addEventListener('click', () => elements.snapshotFile.click());
    elements.snapshotFile.addEventListener('change', () => importContributionSnapshot(elements.snapshotFile.files?.[0]));
    elements.unloadSnapshot.addEventListener('click', () => unloadSnapshot());
    elements.exportForm.addEventListener('submit', generate);
    elements.refreshContributions.addEventListener('click', async () => {
      try {
        await refreshLiveContributions();
      } catch (error) {
        setLiveStatusKey('live.refreshFailed', () => ({ message: friendlyError(error) }), 'error');
      }
    });
    elements.setupRepository.addEventListener('click', setupManagedRepository);
    elements.submitLive.addEventListener('click', openLiveReview);
    elements.resumeSubmission.addEventListener('click', () => continueAcceptedSubmission());
    elements.dismissSubmission.addEventListener('click', dismissPendingSubmission);
    const updateLiveConfirmation = () => {
      elements.confirmLiveSubmit.disabled = state.submitting
        || !state.livePlan
        || !liveConfirmationReady(
          elements.liveConfirmInput.value,
          state.livePlan.confirmationPhrase,
          state.livePlan.totalCommits,
          elements.liveHighVolumeConfirm.checked,
        );
    };
    elements.liveConfirmInput.addEventListener('input', updateLiveConfirmation);
    elements.liveHighVolumeConfirm.addEventListener('change', updateLiveConfirmation);
    elements.confirmLiveSubmit.addEventListener('click', confirmLiveSubmission);
    elements.closeLiveDialog.addEventListener('click', () => {
      if (!state.submitting) elements.liveDialog.close();
    });
    elements.liveDialog.addEventListener('cancel', (event) => {
      if (state.submitting) event.preventDefault();
    });
    elements.liveDialog.addEventListener('close', () => {
      if (!state.submitting) state.livePlan = null;
      elements.liveConfirmInput.value = '';
      elements.liveHighVolumeConfirm.checked = false;
      elements.confirmLiveSubmit.disabled = true;
    });

    elements.closeScript.addEventListener('click', () => elements.scriptDialog.close());
    elements.scriptDialog.addEventListener('click', (event) => {
      if (event.target === elements.scriptDialog) elements.scriptDialog.close();
    });
    elements.reviewConfirm.addEventListener('change', () => {
      elements.copyScript.disabled = !elements.reviewConfirm.checked;
      elements.downloadScript.disabled = !elements.reviewConfirm.checked;
    });
    elements.copyScript.addEventListener('click', async () => {
      try {
        await copyText(state.generatedScript);
        toast(ui.t('script.copied'));
      } catch (error) {
        toast(friendlyError(error), 'error');
      }
    });
    elements.downloadScript.addEventListener('click', () => {
      const extension = state.generatedFormat === 'bash' ? 'sh' : 'ps1';
      const mime = state.generatedFormat === 'bash' ? 'text/x-shellscript' : 'text/plain';
      downloadText(state.generatedScript, `commit-canvas.${extension}`, `${mime};charset=utf-8`);
      toast(ui.t('script.downloaded'));
    });
  }

  populateTimeZones();
  elements.endDate.value = core.isoDateLocal(new Date());
  makeCells();
  renderDates();
  renderSnapshotStatus();
  updateHistoryButtons();
  bindEvents();
  await initializeLiveMode();
}

if (typeof document !== 'undefined') main().catch(showFatal);
