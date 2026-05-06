/**
 * FlowSpend — calendar shell with Month / Next Month / Year views
 */

/** Real “today” at page load — refreshed on every full reload so the calendar opens on the current month. */
function calendarInitialYearMonth() {
  const n = new Date();
  return { year: n.getFullYear(), monthIndex: n.getMonth() };
}

const CALENDAR_BOOT = calendarInitialYearMonth();

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const calendarState = {
  view: 'month', // month | next | year
  year: CALENDAR_BOOT.year,
  monthIndex: CALENDAR_BOOT.monthIndex,
  /** When true, each day cell shows summed Rs for items on that date (month / next views only; hidden in year mini cells). */
  showDayTotals: false,
};

function getCalendarDensity() {
  try {
    const v = localStorage.getItem('flowspend_cal_density');
    return v === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

function setCalendarDensityClass(container, density) {
  container.classList.remove('cal-density--compact', 'cal-density--comfortable');
  container.classList.add(density === 'compact' ? 'cal-density--compact' : 'cal-density--comfortable');
}

/** First weekday of month 0=Sun..6=Sat */
function firstWeekday(year, monthIndex) {
  return new Date(year, monthIndex, 1).getDay();
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function resolveYearMonth(baseYear, monthIndex) {
  const y = baseYear + Math.floor(monthIndex / 12);
  const m = ((monthIndex % 12) + 12) % 12;
  return { year: y, monthIndex: m };
}

function getCalendarMeta() {
  const monthOffset = calendarState.view === 'next' ? 1 : 0;
  const resolved = resolveYearMonth(calendarState.year, calendarState.monthIndex + monthOffset);
  return {
    year: resolved.year,
    monthIndex: resolved.monthIndex,
    label: MONTH_NAMES[resolved.monthIndex],
    days: daysInMonth(resolved.year, resolved.monthIndex),
    view: calendarState.view,
  };
}

/** Align spend chart with the calendar: visible month (incl. “next” offset) or full year in year view. */
function getChartDataScope() {
  if (calendarState.view === 'year') {
    return { kind: 'year', year: calendarState.year };
  }
  const meta = getCalendarMeta();
  return { kind: 'month', year: meta.year, monthIndex: meta.monthIndex };
}

/** First calendar day (YYYY-MM-DD) of the month after the one currently shown in Month / Next views. */
function getNextMonthFirstYmd() {
  const meta = getCalendarMeta();
  const d = new Date(meta.year, meta.monthIndex + 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function monthTitle(view) {
  if (view === 'year') return String(calendarState.year);
  const offset = view === 'next' ? 1 : 0;
  const resolved = resolveYearMonth(calendarState.year, calendarState.monthIndex + offset);
  return `${MONTH_NAMES[resolved.monthIndex]} ${resolved.year}`;
}

function monthGridHtml(year, monthIndex, mini) {
  const startPad = firstWeekday(year, monthIndex);
  const days = daysInMonth(year, monthIndex);
  const cells = [];
  for (let i = 0; i < startPad; i++) {
    cells.push('<div class="cal-cell cal-cell--pad"></div>');
  }
  for (let d = 1; d <= days; d++) {
    const ymd = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const miniClass = mini ? ' cal-cell--mini' : '';
    cells.push(
      `<div class="cal-cell${miniClass}" data-date="${ymd}">
        <div class="cal-cell__head">
          <div class="cal-cell__total" data-day-total="${ymd}" hidden></div>
          <div class="cal-daynum">${d}</div>
        </div>
        <div class="cal-dayitems" data-day-items="${ymd}"></div>
      </div>`,
    );
  }
  return cells.join('');
}

function calendarBodyHtml() {
  if (calendarState.view === 'year') {
    const months = [];
    for (let m = 0; m < 12; m++) {
      months.push(
        `<section class="cal-month-card">
          <h3 class="cal-month-card__title">${MONTH_NAMES[m]}</h3>
          <div class="cal-grid cal-grid--mini">${monthGridHtml(calendarState.year, m, true)}</div>
        </section>`,
      );
    }
    return `<div class="cal-year-grid">${months.join('')}</div>`;
  }

  const offset = calendarState.view === 'next' ? 1 : 0;
  const resolved = resolveYearMonth(calendarState.year, calendarState.monthIndex + offset);
  const head = WEEKDAYS.map((d) => `<div class="cal-dow">${d}</div>`).join('');
  return `<div class="cal-grid">${head}${monthGridHtml(resolved.year, resolved.monthIndex, false)}</div>`;
}

function setCalendarFocusDate(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return;
  calendarState.year = Number(m[1]);
  calendarState.monthIndex = Number(m[2]) - 1;
  calendarState.view = 'month';
}

function setCalendarMonth(year, monthIndex) {
  if (!Number.isFinite(year) || !Number.isFinite(monthIndex)) return;
  const resolved = resolveYearMonth(year, monthIndex);
  calendarState.year = resolved.year;
  calendarState.monthIndex = resolved.monthIndex;
  calendarState.view = 'month';
}

function shiftCalendarMonth(delta) {
  setCalendarMonth(calendarState.year, calendarState.monthIndex + delta);
}

/**
 * @param {HTMLElement} container
 * @param {Function|{onSelectDay?:Function,onStructureChange?:Function}} options
 */
function renderCalendarShell(container, options) {
  const onSelectDay = typeof options === 'function' ? options : options?.onSelectDay;
  const onStructureChange = typeof options === 'function' ? null : options?.onStructureChange;
  const density = getCalendarDensity();
  setCalendarDensityClass(container, density);

  container.innerHTML = `
    <div class="cal-header">
      <h2 class="cal-title">${monthTitle(calendarState.view)}</h2>
      <div class="cal-controls" aria-label="Calendar views">
        <button type="button" class="cal-control" data-cal-nav="prev" aria-label="Previous month">‹ Prev</button>
        <button type="button" class="cal-control ${calendarState.view === 'month' ? 'is-active' : ''}" data-cal-view="month">Month</button>
        <button type="button" class="cal-control cal-drop-next-month ${calendarState.view === 'next' ? 'is-active' : ''}" data-cal-view="next" data-cal-drop-next-month title="View or drop here for next month">Next Month</button>
        <button type="button" class="cal-control ${calendarState.view === 'year' ? 'is-active' : ''}" data-cal-view="year">Year</button>
        <button type="button" class="cal-control" data-cal-nav="next" aria-label="Next month">Next ›</button>
        <div class="cal-density-field" role="group" aria-label="Calendar density">
          <button type="button" class="cal-control cal-control--mini ${density === 'comfortable' ? 'is-active' : ''}" data-cal-density="comfortable" title="Comfortable">Comfort</button>
          <button type="button" class="cal-control cal-control--mini ${density === 'compact' ? 'is-active' : ''}" data-cal-density="compact" title="Compact">Compact</button>
        </div>
        <div class="cal-totals-field">
          <span class="cal-totals-field__label" id="calTotalsLabel">Totals</span>
          <button type="button" class="cal-totals-switch ${calendarState.showDayTotals ? 'is-on' : ''}" data-cal-totals-toggle role="switch" aria-checked="${calendarState.showDayTotals ? 'true' : 'false'}" aria-labelledby="calTotalsLabel"></button>
        </div>
        <input type="month" class="cal-picker" value="${calendarState.year}-${String(calendarState.monthIndex + 1).padStart(2, '0')}" aria-label="Pick month" />
      </div>
    </div>
    ${calendarBodyHtml()}
  `;

  container.querySelectorAll('[data-cal-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const view = btn.getAttribute('data-cal-view');
      if (!view || view === calendarState.view) return;
      calendarState.view = view;
      renderCalendarShell(container, { onSelectDay, onStructureChange });
      if (onStructureChange) onStructureChange();
    });
  });

  container.querySelector('[data-cal-nav="prev"]')?.addEventListener('click', () => {
    shiftCalendarMonth(-1);
    renderCalendarShell(container, { onSelectDay, onStructureChange });
    if (onStructureChange) onStructureChange();
  });

  container.querySelector('[data-cal-nav="next"]')?.addEventListener('click', () => {
    shiftCalendarMonth(1);
    renderCalendarShell(container, { onSelectDay, onStructureChange });
    if (onStructureChange) onStructureChange();
  });

  container.querySelector('.cal-picker')?.addEventListener('change', (e) => {
    const m = String(e.target.value || '').match(/^(\d{4})-(\d{2})$/);
    if (!m) return;
    setCalendarMonth(Number(m[1]), Number(m[2]) - 1);
    renderCalendarShell(container, { onSelectDay, onStructureChange });
    if (onStructureChange) onStructureChange();
  });

  const totSwitch = container.querySelector('[data-cal-totals-toggle]');
  if (totSwitch) {
    totSwitch.addEventListener('click', () => {
      calendarState.showDayTotals = !calendarState.showDayTotals;
      totSwitch.classList.toggle('is-on', calendarState.showDayTotals);
      totSwitch.setAttribute('aria-checked', calendarState.showDayTotals ? 'true' : 'false');
      if (onStructureChange) onStructureChange();
    });
  }

  container.querySelectorAll('[data-cal-density]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const v = btn.getAttribute('data-cal-density');
      try {
        localStorage.setItem('flowspend_cal_density', v === 'compact' ? 'compact' : 'comfortable');
      } catch {
        /* ignore */
      }
      renderCalendarShell(container, { onSelectDay, onStructureChange });
      if (onStructureChange) onStructureChange();
    });
  });

  if (onSelectDay) {
    container.querySelectorAll('.cal-cell[data-date]').forEach((el) => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-item-id]')) return;
        const ymd = el.getAttribute('data-date');
        if (ymd) onSelectDay(ymd);
      });
    });
  }
}

/**
 * @param {HTMLElement} container — .app-main__calendar root
 * @param {Array} items — full list
 * @param {(item: object) => void} onItemClick
 */
function paintCalendarItems(container, items, onItemClick) {
  const FS = typeof globalThis !== 'undefined' ? globalThis.FS : window.FS;
  const byDay = new Map();
  FS.getCalendarEvents(items).forEach((event) => {
    if (!event.date) return;
    if (!byDay.has(event.date)) byDay.set(event.date, []);
    byDay.get(event.date).push(event);
  });

  const dayTotals = new Map();
  byDay.forEach((events, ymd) => {
    const sum = events.reduce((acc, ev) => acc + (Number(ev.item.price) || 0), 0);
    dayTotals.set(ymd, sum);
  });

  container.querySelectorAll('[data-day-total]').forEach((slot) => {
    const ymd = slot.getAttribute('data-day-total');
    const mini = Boolean(slot.closest('.cal-cell--mini'));
    if (!calendarState.showDayTotals || mini || !ymd) {
      slot.hidden = true;
      slot.textContent = '';
      return;
    }
    const sum = dayTotals.get(ymd) || 0;
    if (sum <= 0) {
      slot.hidden = true;
      slot.textContent = '';
      return;
    }
    slot.hidden = false;
    slot.textContent = `Rs ${formatMoney(sum)}`;
  });

  function calStageToneClass(stage) {
    const s = String(stage || 'Idea');
    if (s === 'Bought') return 'cal-item--tone-bought';
    if (['Idea', 'Wishlist', 'Research'].includes(s)) return 'cal-item--tone-early';
    return 'cal-item--tone-active';
  }

  container.querySelectorAll('[data-day-items]').forEach((slot) => {
    const ymd = slot.getAttribute('data-day-items');
    const list = ymd ? byDay.get(ymd) || [] : [];
    const mini = Boolean(slot.closest('.cal-cell--mini'));
    const maxVisible = mini ? 1 : 2;
    const visible = list.slice(0, maxVisible);
    const extra = list.length - visible.length;
    slot.innerHTML =
      visible
        .map((event) => {
          const st = event.item.stage || event.item.status || 'Idea';
          const tone = calStageToneClass(st);
          const recurFuture = Boolean(event.projected && event.date !== (event.item.plannedDate || ''));
          const recurCls = recurFuture ? ' cal-item--recur-future' : '';
          const recurIcon = recurFuture ? '<span class="cal-item__recur" aria-hidden="true">↻ </span>' : '';
          return `<button type="button" draggable="true" class="cal-item cal-item--${event.kind}${event.projected ? ' cal-item--projected' : ''}${FS.isImportedItem?.(event.item) ? ' cal-item--imported' : ''} ${tone}${recurCls}" data-item-id="${event.item.id}" title="Edit · drag to move date">
            <span class="cal-item__name">${stageIconHtml(event.item.stage || event.item.status)}${recurIcon}${event.kind === 'deadline' ? 'Deadline: ' : ''}${escapeHtml(event.item.name)}</span>
            <span class="cal-item__price">Rs ${formatMoney(event.item.price)}</span>
          </button>`;
        })
        .join('') +
      (extra > 0 ? `<div class="cal-item cal-item--more" aria-hidden="true">+${extra} more</div>` : '');
  });

  container.querySelectorAll('.cal-item[data-item-id]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = btn.getAttribute('data-item-id');
      const item = items.find((x) => x.id === id);
      if (item) onItemClick(item);
    });
    btn.addEventListener('dragstart', (e) => {
      const id = btn.getAttribute('data-item-id');
      if (id) e.dataTransfer?.setData('text/flowspend-item', id);
      e.dataTransfer.effectAllowed = 'move';
    });
  });
}

function stageIconHtml(stage) {
  const m = {
    Idea: '💡',
    Wishlist: '⭐',
    Research: '🔍',
    Committed: '🧠',
    Scheduled: '📅',
    Delayed: '⏳',
    Bought: '✅',
  };
  const ch = m[stage] || '';
  return ch ? `<span class="stage-icon" aria-hidden="true">${ch}</span>` : '';
}

/** Highlight selected calendar day (visual only). Pass null to clear. */
function setCalendarDaySelection(container, ymd) {
  container.querySelectorAll('.cal-cell[data-date]').forEach((el) => {
    const d = el.getAttribute('data-date');
    el.classList.toggle('is-selected', Boolean(ymd) && d === ymd);
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatMoney(n) {
  const x = Number(n) || 0;
  return x.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

(function (g) {
  g.FS = g.FS || {};
  Object.assign(g.FS, {
    getCalendarMeta,
    getChartDataScope,
    getNextMonthFirstYmd,
    setCalendarFocusDate,
    setCalendarMonth,
    shiftCalendarMonth,
    renderCalendarShell,
    paintCalendarItems,
    setCalendarDaySelection,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
