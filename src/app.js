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
  'generateScript',
];

const IMPORT_LIMIT_BYTES = 1024 * 1024;
const WARNING_COMMITS = 200;
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

const MONTH_NAMES = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
const WEEKDAY_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

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

export function contributionCellLabel(snapshotLoaded, existingCount, plannedCount) {
  const baseline = snapshotLoaded
    ? `GitHub 已有 ${existingCount} 次贡献`
    : '当前 GitHub 贡献未检查';
  return `${baseline}，计划新增 ${plannedCount} 次`;
}

function byId(id) {
  const node = document.getElementById(id);
  if (!node) throw new Error(`页面缺少必要元素：${id}`);
  return node;
}

function showFatal(error) {
  const toast = document.getElementById('toast');
  if (toast) {
    toast.textContent = `工具未能启动：${friendlyError(error)}`;
    toast.classList.add('is-visible', 'is-error');
  }
  document.querySelectorAll('button, input, select').forEach((control) => {
    control.disabled = true;
  });
}

function friendlyError(error) {
  if (!(error instanceof Error)) return '发生未知错误，请刷新页面重试。';
  const translations = [
    [/limit is (\d+)/i, '计划提交超过安全上限（$1 次）。'],
    [/at least one non-future commit/i, '画布还没有可导出的提交。'],
    [/valid email address/i, '邮箱格式无效，请检查后重试。'],
    [/not valid JSON/i, '文件不是有效的 JSON。'],
    [/contribution snapshot|snapshot/i, '贡献墙快照格式无效。'],
    [/unsupported design version/i, '这个存档版本暂不支持。'],
    [/missing or unknown fields/i, '存档字段不完整或包含未知字段。'],
    [/time zone/i, '存档中的时区无效。'],
    [/levels/i, '存档中的画布数据无效。'],
    [/counts/i, '存档中的强度数据无效。'],
    [/endDate|calendar date|YYYY-MM-DD/i, '日期无效，请检查后重试。'],
  ];
  for (const [pattern, message] of translations) {
    if (pattern.test(error.message)) return error.message.replace(pattern, message);
  }
  return error.message || '发生未知错误，请重试。';
}

async function main() {
  const core = await import('./core.js');
  for (const name of REQUIRED_EXPORTS) {
    if (!(name in core)) throw new Error(`核心模块缺少导出：${name}`);
  }

  const { COLS, ROWS, DEFAULT_LEVEL_COUNTS, MAX_COMMITS } = core;
  const cellCount = COLS * ROWS;
  if (COLS !== 53 || ROWS !== 7 || DEFAULT_LEVEL_COUNTS.length !== 5) {
    throw new Error('核心模块的画布尺寸或强度配置不兼容。');
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
  };

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
    elements.total.textContent = total.toLocaleString('zh-CN');
    elements.paintedDays.textContent = paintedOf(summary).toLocaleString('zh-CN');
    const lastUsable = [...state.dates].reverse().find((cell) => !cell.isFuture);
    elements.dateRange.textContent = state.dates.length && lastUsable
      ? `${state.dates[0].date} — ${lastUsable.date}`
      : '—';

    elements.limitStatus.classList.remove('is-warning', 'is-error');
    const statusText = elements.limitStatus.lastElementChild;
    if (total >= MAX_COMMITS) {
      elements.limitStatus.classList.add('is-error');
      statusText.textContent = `已达 ${MAX_COMMITS} 次安全上限`;
    } else if (total >= WARNING_COMMITS) {
      elements.limitStatus.classList.add('is-warning');
      statusText.textContent = `提交较多：${total} / ${MAX_COMMITS}`;
    } else {
      statusText.textContent = `可以继续创作 · 上限 ${MAX_COMMITS}`;
    }
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
    const contributionLabel = contributionCellLabel(Boolean(state.snapshot), existingCount, count);
    cell.setAttribute('aria-label', `${dateInfo.date}，${WEEKDAY_NAMES[dateInfo.row]}，${contributionLabel}${existingCount > 0 ? '，已有贡献日期只读' : ''}${dateInfo.isFuture ? '，未来日期已锁定' : ''}`);
    cell.title = `${dateInfo.date} · ${contributionLabel}${existingCount > 0 ? ' · 已有贡献日期只读' : ''}`;
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
          label.textContent = MONTH_NAMES[Number(date.slice(5, 7)) - 1];
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
      throw new Error('核心模块返回了不完整的日期网格。');
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
    toast('已撤销上一步。');
  }

  function redo() {
    const next = state.redo.pop();
    if (!next) return;
    state.undo.push(snapshot());
    restoreSnapshot(next);
    updateHistoryButtons();
    toast('已重做。');
  }

  function selectLevel(level) {
    if (!Number.isInteger(level) || level < 0 || level >= state.counts.length) return;
    state.selectedLevel = level;
    document.querySelectorAll('[data-level].level-button').forEach((button) => {
      const selected = Number(button.dataset.level) === level;
      button.classList.toggle('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
    toast(level === 0 ? '已选择橡皮。' : `已选择强度 ${level}：每天 ${state.counts[level]} 次提交。`);
  }

  function paint(index, quiet = false) {
    const dateInfo = state.dates[index];
    if (!dateInfo || dateInfo.isFuture || (state.byDate.get(dateInfo.date)?.count ?? 0) > 0 || state.levels[index] === state.selectedLevel) return false;
    const summary = safeSummary();
    const projected = totalOf(summary) - state.counts[state.levels[index]] + state.counts[state.selectedLevel];
    if (projected > MAX_COMMITS) {
      if (!quiet) toast(`不能继续：设计最多生成 ${MAX_COMMITS} 次提交。`, 'error');
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

  function confirmAction({ title, message, confirmLabel = '确认', danger = true }) {
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
        title: '替换当前画布？',
        message: '应用模板会替换现有图案。你仍可使用“撤销”恢复。',
        confirmLabel: '应用模板',
      });
      if (!accepted) return;
    }
    const next = templateLevels(name);
    if (totalOf(safeSummary(next)) > MAX_COMMITS) {
      toast(`模板超过 ${MAX_COMMITS} 次提交的安全上限。`, 'error');
      return;
    }
    const before = snapshot();
    restoreLevels(next);
    pushUndo(before);
    toast('模板已应用。');
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
      elements.snapshotExistingStatus.textContent = '未检查';
      elements.snapshotNotice.textContent = '尚未导入快照。当前画布无法判断哪些日期已经有贡献。';
      return;
    }
    const existingDays = state.snapshot.days.filter((day) => day.count > 0).length;
    const generatedAt = new Date(state.snapshot.generatedAt);
    elements.snapshotAccount.textContent = state.snapshot.account;
    elements.snapshotGeneratedAt.textContent = Number.isNaN(generatedAt.valueOf())
      ? state.snapshot.generatedAt
      : generatedAt.toLocaleString('zh-CN');
    elements.snapshotRange.textContent = `${state.snapshot.rangeStart} — ${state.snapshot.rangeEnd}`;
    elements.snapshotExistingStatus.textContent = `${existingDays} 天已有贡献`;
    elements.snapshotNotice.textContent = `已载入 @${state.snapshot.account} 的本地快照；画布结束日期已对齐快照范围。`;
  }

  function unloadSnapshot(message = '快照已卸载；现有设计未改变。') {
    state.snapshot = null;
    state.byDate = new Map();
    renderSnapshotStatus();
    renderAllCells();
    toast(message);
  }

  async function importContributionSnapshot(file) {
    if (!file) return;
    if (file.size > IMPORT_LIMIT_BYTES) {
      toast('文件超过 1 MiB，已拒绝导入。', 'error');
      return;
    }
    try {
      const parsed = core.parseContributionSnapshot(await file.text());
      const nextByDate = new Map(parsed.days.map((day) => [day.date, day]));
      const plannedByDate = plannedLevelsByDate();
      const nextDates = core.gridDates(parsed.rangeEnd, elements.timezone.value);
      const projection = projectPlanOntoDates(plannedByDate, nextDates, nextByDate);
      if (projection.clearedExisting > 0 || projection.lostOutsideRange > 0) {
        const effects = [
          projection.clearedExisting > 0 ? `清除 ${projection.clearedExisting} 个与已有贡献重叠的计划日期` : '',
          projection.lostOutsideRange > 0 ? `丢失 ${projection.lostOutsideRange} 个移出新 53 周范围的计划日期` : '',
        ].filter(Boolean).join('，并');
        const accepted = await confirmAction({
          title: '导入快照并调整当前计划？',
          message: `把结束日期对齐到 ${parsed.rangeEnd} 会${effects}。取消将保留当前快照、日期和全部计划。`,
          confirmLabel: '导入并调整',
        });
        if (!accepted) return;
      }
      elements.endDate.value = parsed.rangeEnd;
      state.snapshot = parsed;
      state.byDate = nextByDate;
      state.dates = nextDates;
      state.levels = projection.levels;
      state.undo.length = 0;
      state.redo.length = 0;
      renderDates();
      renderSnapshotStatus();
      updateHistoryButtons();
      const changes = [
        projection.clearedExisting > 0 ? `清除 ${projection.clearedExisting} 个重叠日期` : '',
        projection.lostOutsideRange > 0 ? `移除 ${projection.lostOutsideRange} 个范围外日期` : '',
      ].filter(Boolean).join('，');
      toast(`已导入 @${parsed.account} 的贡献墙快照${changes ? `，并${changes}` : ''}。`);
    } catch (error) {
      toast(`快照导入失败：${friendlyError(error)}`, 'error');
    } finally {
      elements.snapshotFile.value = '';
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
      toast('设计 JSON 已下载。');
    } catch (error) {
      toast(friendlyError(error), 'error');
    }
  }

  async function importJson(file) {
    if (!file) return;
    if (file.size > IMPORT_LIMIT_BYTES) {
      toast('文件超过 1 MiB，已拒绝导入。', 'error');
      return;
    }
    try {
      const parsed = core.parseDesign(await file.text());
      if (!parsed.counts.every((count, index) => count === DEFAULT_LEVEL_COUNTS[index])) {
        throw new Error('存档使用了不受支持的强度映射。');
      }
      if (totalOf(core.computeSummary(parsed.levels, parsed.counts)) > MAX_COMMITS) {
        throw new Error(`存档超过 ${MAX_COMMITS} 次提交的安全上限。`);
      }
      const hasContent = paintedOf(safeSummary()) > 0;
      const unloadForDateChange = Boolean(state.snapshot && parsed.endDate !== state.snapshot.rangeEnd);
      const parsedDates = core.gridDates(parsed.endDate, parsed.timeZone);
      const snapshotConflicts = state.snapshot
        ? parsedDates.filter((dateInfo) => parsed.levels[dateInfo.index] > 0 && (state.byDate.get(dateInfo.date)?.count ?? 0) > 0)
        : [];
      if (hasContent || unloadForDateChange || snapshotConflicts.length > 0) {
        const snapshotEffect = unloadForDateChange
          ? '结束日期不同，因此当前绿墙快照也会卸载。'
          : snapshotConflicts.length > 0
            ? `其中 ${snapshotConflicts.length} 个计划日期已有 GitHub 贡献，将从计划中清除。`
            : '';
        const accepted = await confirmAction({
          title: '导入并替换当前画布？',
          message: `导入会替换当前图案、结束日期和时区。${snapshotEffect}`,
          confirmLabel: '确认导入',
        });
        if (!accepted) return;
      }
      const before = snapshot();
      if (unloadForDateChange) {
        state.snapshot = null;
        state.byDate = new Map();
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
      toast('设计已从 JSON 导入。');
    } catch (error) {
      toast(`导入失败：${friendlyError(error)}`, 'error');
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
      option.textContent = `${timeZone}（当前浏览器）`;
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
    if (!copied) throw new Error('浏览器拒绝复制，请在预览中手动选择文本。');
  }

  async function generate(event) {
    event.preventDefault();
    if (!elements.exportForm.reportValidity()) return;
    const summary = safeSummary();
    const total = totalOf(summary);
    if (total === 0) {
      toast('请先在画布上绘制至少一个非未来日期。', 'error');
      return;
    }
    if (total > MAX_COMMITS) {
      toast(`设计超过 ${MAX_COMMITS} 次提交的安全上限。`, 'error');
      return;
    }
    if (total >= WARNING_COMMITS) {
      const accepted = await confirmAction({
        title: `将生成 ${total} 次提交`,
        message: '这是较多的占位提交。请确认你会使用全新、独立、自己拥有的练习仓库，并在运行前逐行审阅脚本。',
        confirmLabel: '继续审阅',
        danger: false,
      });
      if (!accepted) return;
    }
    if (!state.snapshot) {
      const accepted = await confirmAction({
        title: '未检查当前贡献墙',
        message: '尚未导入当前绿墙快照，脚本可能在已有贡献的日期继续创建提交。仍要生成脚本供审阅吗？',
        confirmLabel: '仍然生成',
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
      const snapshotMeta = state.snapshot
        ? ` · 快照 @${state.snapshot.account} · ${state.snapshot.generatedAt} · 避开 ${state.snapshot.days.filter((day) => day.count > 0).length} 个已有绿点`
        : ' · 未检查当前绿墙';
      elements.scriptMeta.textContent = `${format === 'bash' ? 'Bash (.sh)' : 'PowerShell (.ps1)'} · ${total} 次提交 · ${elements.endDate.value} · ${elements.timezone.value}${snapshotMeta}`;
      elements.reviewConfirm.checked = false;
      elements.copyScript.disabled = true;
      elements.downloadScript.disabled = true;
      elements.scriptDialog.showModal();
    } catch (error) {
      toast(`无法生成脚本：${friendlyError(error)}`, 'error');
    }
  }

  function bindEvents() {
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
        toast('画布已经是空的。');
        return;
      }
      const accepted = await confirmAction({
        title: '清空整张画布？',
        message: '所有已绘制格子都会被擦除。你仍可使用“撤销”恢复。',
        confirmLabel: '清空画布',
      });
      if (!accepted) return;
      const before = snapshot();
      restoreLevels(Array(cellCount).fill(0));
      pushUndo(before);
      toast('画布已清空。');
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
          ? `，并永久移除 ${projection.lostOutsideRange} 个离开新 53 周范围的计划日期`
          : '；当前计划日期都会保留';
        const accepted = await confirmAction({
          title: '卸载当前绿墙快照？',
          message: `快照只对应它记录的日期范围。更改画布结束日期会卸载快照${lossWarning}。取消将恢复原结束日期，快照和计划均不变。`,
          confirmLabel: '卸载并更改',
        });
        if (!accepted) {
          elements.endDate.value = state.renderedEndDate;
          return;
        }
        state.snapshot = null;
        state.byDate = new Map();
        elements.endDate.value = requestedEndDate;
        state.dates = nextDates;
        state.levels = projection.levels;
        renderSnapshotStatus();
        renderDates();
        state.undo.length = 0;
        state.redo.length = 0;
        updateHistoryButtons();
        toast(`结束日期已更改，当前绿墙快照已卸载${projection.lostOutsideRange > 0 ? `，已移除 ${projection.lostOutsideRange} 个范围外计划日期` : ''}。`);
        return;
      }
      updateCalendarControl();
    });
    elements.timezone.addEventListener('change', updateCalendarControl);

    elements.zoom.addEventListener('click', () => {
      const zoomed = elements.canvasShell.classList.toggle('is-zoomed');
      elements.zoom.setAttribute('aria-pressed', String(zoomed));
      elements.zoomLabel.textContent = zoomed ? '缩小格子' : '放大格子';
    });

    elements.pan.addEventListener('click', () => {
      endPointerStroke();
      state.panMode = !state.panMode;
      elements.canvasShell.classList.toggle('is-panning', state.panMode);
      elements.pan.setAttribute('aria-pressed', String(state.panMode));
      elements.panLabel.textContent = state.panMode ? '返回绘制' : '平移画布';
      toast(state.panMode ? '已开启平移：在格子上左右滑动画布。' : '已返回绘制模式。');
    });

    elements.exportJson.addEventListener('click', exportJson);
    elements.importJson.addEventListener('click', () => elements.importFile.click());
    elements.importFile.addEventListener('change', () => importJson(elements.importFile.files?.[0]));
    elements.importSnapshot.addEventListener('click', () => elements.snapshotFile.click());
    elements.snapshotFile.addEventListener('change', () => importContributionSnapshot(elements.snapshotFile.files?.[0]));
    elements.unloadSnapshot.addEventListener('click', () => unloadSnapshot());
    elements.exportForm.addEventListener('submit', generate);

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
        toast('脚本已复制到剪贴板。');
      } catch (error) {
        toast(friendlyError(error), 'error');
      }
    });
    elements.downloadScript.addEventListener('click', () => {
      const extension = state.generatedFormat === 'bash' ? 'sh' : 'ps1';
      const mime = state.generatedFormat === 'bash' ? 'text/x-shellscript' : 'text/plain';
      downloadText(state.generatedScript, `commit-canvas.${extension}`, `${mime};charset=utf-8`);
      toast('脚本已下载；运行前请再次逐行审阅。');
    });
  }

  populateTimeZones();
  elements.endDate.value = core.isoDateLocal(new Date());
  makeCells();
  renderDates();
  renderSnapshotStatus();
  updateHistoryButtons();
  bindEvents();
}

if (typeof document !== 'undefined') main().catch(showFatal);
