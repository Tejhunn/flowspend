/**
 * FlowSpend — main controller (classic script; uses global FS)
 */
(function () {
  const FS = typeof globalThis !== 'undefined' ? globalThis.FS : window.FS;
  let items = [];
  let lastResetSnapshot = null;
  let lastParsedResult = null;
  let categoryMappings = {};
  let approvedCategories = [];
  let currencySymbol = 'Rs';
  let selectedDate = null;
  let pendingStatementRows = [];
  let calendarOptions = null;
  let sideQuery = '';
  let sideStageFilter = '';
  let sideSourceFilter = '';
  let sideGroupBy = '';
  let recentBoughtYear = null;
  let recentBoughtMonthIndex = null;
  /** Ctrl/Cmd multi-select for upcoming list */
  const sideSelectionIds = new Set();
  let sideListFocusId = null;
  const LS_FILTER_STAGE = 'flowspend_filter_stage';
  const LS_FILTER_SOURCE = 'flowspend_filter_source';
  const LS_FILTER_GROUP = 'flowspend_filter_group';
  const LS_HINT_KW_CAT = 'flowspend_kw_category';
  const LS_HINT_NAME_PRICE = 'flowspend_name_price';
  const DEFAULT_ACCENT = '#2f766d';
  const THEME_PRESETS = {
    sage: '#2f766d',
    ocean: '#2f6790',
    graphite: '#3f4652',
    rose: '#9b4d64',
    amber: '#a4691f',
  };
  const AI_PROVIDER_PRESETS = {
    groq: {
      label: 'Groq',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      model: 'llama-3.1-8b-instant',
    },
    openrouter: {
      label: 'OpenRouter',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'openrouter/auto',
    },
  };

  const $ = (sel, root) => (root || document).querySelector(sel);

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function escapeAttr(s) {
    return String(s).replace(/"/g, '&quot;');
  }
  function addDaysToYmd(ymd, days) {
    const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function sideStageToneClass(stage) {
    const s = String(stage || 'Idea');
    if (s === 'Bought') return 'side-item--tone-bought';
    if (['Idea', 'Wishlist', 'Research'].includes(s)) return 'side-item--tone-early';
    return 'side-item--tone-active';
  }

  function assignItemToPlannedDate(itemId, dateYmd, toastMsg) {
    if (!String(itemId || '').trim() || !dateYmd) return false;
    const it = items.find((x) => x.id === itemId);
    if (!it) return false;
    recordUndo('drag date');
    it.plannedDate = dateYmd;
    it.date = dateYmd;
    if (!['Committed', 'Scheduled', 'Bought'].includes(it.stage || it.status)) {
      it.stage = 'Scheduled';
      it.status = 'Scheduled';
    }
    FS.saveItems(items);
    selectedDate = dateYmd;
    updateBarDateChip();
    refreshAll();
    if (toastMsg) showUndoToast(toastMsg);
    return true;
  }

  function commitItemFromRuleParse(parsed) {
    applySmartHintsToParsed(parsed);
    const suggested = parsed.category || 'general';
    const mapped = categoryMappings[String(suggested).toLowerCase()] || '';
    recordUndo('quick add');
    const it = FS.createItem({
      name: parsed.name,
      price: parsed.price,
      category: mapped || suggested,
      suggestedCategory: suggested,
      approvedCategory: mapped,
      categoryConfidence: 0,
      parseSource: 'rule',
      stage: parsed.stage,
      status: parsed.stage,
      type: parsed.type || 'One-off',
      plannedDate: parsed.plannedDate || '',
      date: parsed.plannedDate || '',
      deadline: parsed.deadline || '',
      note: parsed.note || '',
      assumptions: parsed.assumptions || [],
      link: parsed.link || '',
      recurrence: parsed.recurrence || null,
    });
    items.push(it);
    FS.saveItems(items);
    learnSmartFromItem(it);
  }

  function quickAddRuleParseOk(p) {
    return Boolean(String(p.name || '').trim()) && p.price != null && Number.isFinite(Number(p.price));
  }

  function renderMonthSummary() {
    const el = $('#monthSummary');
    if (!el) return;
    const meta = FS.getCalendarMeta();
    const ymPrefix = `${meta.year}-${String(meta.monthIndex + 1).padStart(2, '0')}-`;
    const monthLabel = new Date(meta.year, meta.monthIndex, 1).toLocaleDateString('en-GB', {
      month: 'long',
      year: 'numeric',
    });
    let planned = 0;
    items.map(FS.normalizeItem).forEach(function (i) {
      if (['Committed', 'Scheduled'].includes(i.stage) && i.plannedDate && i.plannedDate.startsWith(ymPrefix.slice(0, 7))) {
        planned += Number(i.price) || 0;
      }
    });
    const spent = FS.itemsBoughtInMonth(items, meta.year, meta.monthIndex).reduce(function (s, i) {
      return s + (Number(i.price) || 0);
    }, 0);
    const buckets = FS.chartCategoryBuckets(items, 'all', {
      kind: 'month',
      year: meta.year,
      monthIndex: meta.monthIndex,
    });
    let topCat = '—';
    let topAmt = -1;
    buckets.forEach(function (b, cat) {
      const t = (Number(b.Reserved) || 0) + (Number(b.Bought) || 0);
      if (t > topAmt) {
        topAmt = t;
        topCat = cat;
      }
    });
    el.innerHTML =
      '<div class="month-summary__inner"><strong class="month-summary__title">' +
      escapeHtml(monthLabel) +
      '</strong><span class="month-summary__line"><span class="month-summary__k">Planned</span> <span class="month-summary__val">' +
      money(planned) +
      '</span></span><span class="month-summary__line"><span class="month-summary__k">Spent</span> <span class="month-summary__val">' +
      money(spent) +
      '</span></span><span class="month-summary__line month-summary__line--top"><span class="month-summary__k">Top category</span> <span class="month-summary__val">' +
      escapeHtml(topCat) +
      '</span></span></div>';
  }

  function renderNext7Days() {
    const ul = $('#sideNext7List');
    const wrap = $('#sideNext7Wrap');
    if (!ul || !wrap) return;
    const t0 = defaultTodayYmd();
    const tEnd = addDaysToYmd(t0, 7);
    const rows = FS.itemsSideDefault(items)
      .filter(function (i) {
        const pd = i.plannedDate || '';
        return pd && pd >= t0 && pd < tEnd;
      })
      .sort(function (a, b) {
        return (a.plannedDate || '').localeCompare(b.plannedDate || '');
      });
    if (!rows.length) {
      ul.innerHTML = '<li class="side-next7-empty">Nothing in the next week.</li>';
      return;
    }
    ul.innerHTML = rows
      .map(function (i) {
        const tone = sideStageToneClass(i.stage || i.status);
        const recur =
          i.type === 'Recurring'
            ? '<span class="side-item__recur" aria-hidden="true" title="Recurring">↻ </span>'
            : '';
        return (
          '<li class="side-next7-item ' +
          tone +
          '" draggable="true" data-id="' +
          i.id +
          '"><span class="side-next7-item__date">' +
          escapeHtml(i.plannedDate || '') +
          '</span><span class="side-next7-item__body">' +
          recur +
          stageIconSpan(i.stage || i.status) +
          escapeHtml(i.name) +
          '</span><span class="side-next7-item__price">' +
          money(i.price) +
          '</span></li>'
        );
      })
      .join('');
    wireDraggableItemRows(ul);
    ul.querySelectorAll('.side-next7-item').forEach(function (row) {
      row.addEventListener('click', function (e) {
        if (e.target.closest('input')) return;
        const id = row.getAttribute('data-id');
        const it = items.find((x) => x.id === id);
        if (it) openEditModal(it);
      });
    });
  }
  function formatRs(n) {
    return (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  function money(n) {
    return currencySymbol + ' ' + formatRs(n);
  }

  function syncStatementReviewTotals() {
    const totalsEl = $('#statementReviewTotals');
    if (!totalsEl) return;
    if (!pendingStatementRows || !pendingStatementRows.length) {
      totalsEl.textContent = '';
      return;
    }
    let sumSel = 0;
    document.querySelectorAll('.statement-row').forEach(function (row) {
      const idx = Number(row.getAttribute('data-row'));
      const base = pendingStatementRows[idx];
      if (!base || !row.querySelector('.statement-select')?.checked) return;
      sumSel += Number(row.querySelector('.statement-amount')?.value || base.amount) || 0;
    });
    const sumAll = pendingStatementRows.reduce(function (s, r) {
      return s + (Number(r.amount) || 0);
    }, 0);
    totalsEl.textContent =
      'Totals — all rows: ' + money(sumAll) + ' · selected for import: ' + money(sumSel);
  }

  function normalizeHex(value) {
    const raw = String(value || '').trim();
    const full = raw.match(/^#?([0-9a-fA-F]{6})$/);
    if (full) return '#' + full[1].toLowerCase();
    const short = raw.match(/^#?([0-9a-fA-F]{3})$/);
    if (!short) return '';
    return (
      '#' +
      short[1]
        .split('')
        .map((ch) => ch + ch)
        .join('')
        .toLowerCase()
    );
  }
  function hexToRgb(hex) {
    const normalized = normalizeHex(hex);
    if (!normalized) return null;
    const n = parseInt(normalized.slice(1), 16);
    return {
      r: (n >> 16) & 255,
      g: (n >> 8) & 255,
      b: n & 255,
    };
  }
  function rgbToHex(rgb) {
    return (
      '#' +
      [rgb.r, rgb.g, rgb.b]
        .map((n) =>
          Math.max(0, Math.min(255, Math.round(n)))
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')
    );
  }
  function mixHex(a, b, amount) {
    const x = hexToRgb(a);
    const y = hexToRgb(b);
    if (!x || !y) return a;
    return rgbToHex({
      r: x.r + (y.r - x.r) * amount,
      g: x.g + (y.g - x.g) * amount,
      b: x.b + (y.b - x.b) * amount,
    });
  }
  function applyAccentColor(value) {
    const accent = normalizeHex(value) || DEFAULT_ACCENT;
    const root = document.documentElement;
    root.style.setProperty('--accent', accent);
    root.style.setProperty('--accent-strong', mixHex(accent, '#17211d', 0.42));
    root.style.setProperty('--accent-soft', mixHex(accent, '#fffdf7', 0.82));
    root.style.setProperty('--accent-wash', mixHex(accent, '#fffdf7', 0.9));
    return accent;
  }
  function syncThemeControls(value, preset) {
    const hex = normalizeHex(value) || DEFAULT_ACCENT;
    const picker = $('#themeColorPicker');
    const select = $('#themePreset');
    if (picker) picker.value = hex;
    if (select) select.value = preset || 'custom';
  }
  function saveTheme(hex, preset) {
    const accent = applyAccentColor(hex);
    localStorage.setItem('flowspend_accent_color', accent);
    localStorage.setItem('flowspend_theme_preset', preset || 'custom');
    syncThemeControls(accent, preset || 'custom');
  }
  function snapshotItems() {
    return items.map((it) => JSON.parse(JSON.stringify(it)));
  }
  function recordUndo(label) {
    lastResetSnapshot = { label: label || 'change', items: snapshotItems(), selectedDate };
  }
  function restoreUndo() {
    if (!lastResetSnapshot) return false;
    items = lastResetSnapshot.items.map((it) => FS.normalizeItem(it));
    selectedDate = lastResetSnapshot.selectedDate || null;
    lastResetSnapshot = null;
    FS.saveItems(items);
    if (selectedDate) FS.setCalendarFocusDate?.(selectedDate);
    rebuildCalendarShell();
    updateBarDateChip();
    refreshAll();
    return true;
  }
  function sourceMatches(item) {
    if (!sideSourceFilter) return true;
    const imported = Boolean(FS.isImportedItem?.(item));
    return sideSourceFilter === 'imported' ? imported : !imported;
  }
  function textMatches(item) {
    const q = sideQuery.trim().toLowerCase();
    if (!q) return true;
    return [item.name, item.stage, item.suggestedCategory, item.approvedCategory, item.category, item.note]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  }
  function applySideFilters(rows) {
    return rows.filter((item) => {
      if (sideStageFilter && item.stage !== sideStageFilter) return false;
      if (!sourceMatches(item)) return false;
      if (!textMatches(item)) return false;
      return true;
    });
  }
  function syncSideFilterControls() {
    const st = $('#sideStageFilter');
    const src = $('#sideSourceFilter');
    const grp = $('#sideGroupBy');
    if (st) st.value = sideStageFilter || '';
    if (src) src.value = sideSourceFilter || '';
    if (grp) grp.value = sideGroupBy || '';
  }

  function stageIconSpan(stage) {
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
    return ch ? '<span class="stage-icon" aria-hidden="true">' + ch + '</span>' : '';
  }

  function partitionSideRowsForGroup(rows) {
    if (!sideGroupBy) {
      return [{ label: null, items: rows }];
    }
    const buckets = new Map();
    for (const i of rows) {
      let label;
      if (sideGroupBy === 'status') label = i.stage || i.status || 'Idea';
      else if (sideGroupBy === 'category') label = FS.getEffectiveCategory(i) || 'Uncategorized';
      else if (sideGroupBy === 'source') label = FS.isImportedItem?.(i) ? 'Imported' : 'Manual';
      else label = '';
      if (!buckets.has(label)) buckets.set(label, []);
      buckets.get(label).push(i);
    }
    let order = [...buckets.keys()];
    if (sideGroupBy === 'status') {
      const ord = FS.getStatuses();
      order.sort(function (a, b) {
        const ia = ord.indexOf(a);
        const ib = ord.indexOf(b);
        const da = ia === -1 ? 999 : ia;
        const db = ib === -1 ? 999 : ib;
        return da - db || String(a).localeCompare(String(b));
      });
    } else if (sideGroupBy === 'category') {
      order.sort(function (a, b) {
        return String(a).localeCompare(String(b));
      });
    } else if (sideGroupBy === 'source') {
      order.sort(function (a, b) {
        if (a === b) return 0;
        return a === 'Manual' ? -1 : 1;
      });
    }
    return order.map(function (label) {
      return { label: label, items: buckets.get(label) };
    });
  }
  function isUnscheduledUpcoming(item) {
    const i = FS.normalizeItem(item);
    return i.stage !== 'Bought' && !i.plannedDate && !i.deadline;
  }
  function updateDashboard() {
    const meta = FS.getCalendarMeta();
    const boughtMonth = FS.itemsBoughtInMonth(items, meta.year, meta.monthIndex).reduce(
      (sum, item) => sum + (Number(item.price) || 0),
      0,
    );
    const importedTotal = items
      .map(FS.normalizeItem)
      .filter((item) => item.stage === 'Bought' && FS.isImportedItem?.(item))
      .reduce((sum, item) => sum + (Number(item.price) || 0), 0);
    const upcoming = items
      .map(FS.normalizeItem)
      .filter((item) => ['Committed', 'Scheduled'].includes(item.stage))
      .reduce((sum, item) => sum + (Number(item.price) || 0), 0);
    const boughtEl = $('#summaryBoughtMonth');
    const importedEl = $('#summaryImported');
    const upcomingEl = $('#summaryUpcoming');
    if (boughtEl) boughtEl.textContent = money(boughtMonth);
    if (importedEl) importedEl.textContent = money(importedTotal);
    if (upcomingEl) upcomingEl.textContent = money(upcoming);
  }
  function showToast(message) {
    const stack = $('#toastStack');
    if (!stack) return;
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    stack.appendChild(toast);
    window.setTimeout(function () {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(6px)';
    }, 2400);
    window.setTimeout(function () {
      toast.remove();
    }, 2800);
  }

  function showUndoToast(message) {
    const stack = $('#toastStack');
    if (!stack) return;
    const DURATION_MS = 5000;
    const toast = document.createElement('div');
    toast.className = 'toast toast--with-undo';
    const row = document.createElement('div');
    row.className = 'toast__undo-row';
    const msg = document.createElement('span');
    msg.className = 'toast__msg';
    msg.textContent = message || 'Action done';
    const meta = document.createElement('div');
    meta.className = 'toast__undo-meta';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast__undo';
    btn.textContent = 'Undo';
    const tick = document.createElement('span');
    tick.className = 'toast__countdown';
    tick.textContent = Math.ceil(DURATION_MS / 1000) + 's';
    meta.appendChild(btn);
    meta.appendChild(tick);
    row.appendChild(msg);
    row.appendChild(meta);
    toast.appendChild(row);
    let cleared = false;
    const t0 = Date.now();
    const iv = window.setInterval(function () {
      if (cleared) return;
      const s = Math.max(0, Math.ceil((DURATION_MS - (Date.now() - t0)) / 1000));
      tick.textContent = s + 's';
    }, 200);
    function dismiss() {
      if (cleared) return;
      cleared = true;
      window.clearInterval(iv);
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(6px)';
      window.setTimeout(function () {
        toast.remove();
      }, 380);
    }
    btn.addEventListener('click', function () {
      if (restoreUndo()) showToast('Undone');
      dismiss();
    });
    stack.appendChild(toast);
    window.setTimeout(function () {
      dismiss();
    }, DURATION_MS);
  }

  function loadHintsMap(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || '{}') || {};
    } catch {
      return {};
    }
  }
  function saveHintsMap(key, o) {
    try {
      localStorage.setItem(key, JSON.stringify(o));
    } catch {
      /* ignore */
    }
  }
  function keywordFromSmartName(name) {
    const parts = String(name || '')
      .trim()
      .toLowerCase()
      .split(/\s+/);
    const w = parts.find((x) => x.length >= 2) || '';
    return w.slice(0, 40);
  }
  function normNameSmart(name) {
    return String(name || '')
      .trim()
      .toLowerCase()
      .slice(0, 80);
  }
  function applySmartHintsToParsed(parsed) {
    const p = parsed;
    const kw = keywordFromSmartName(p.name);
    const km = loadHintsMap(LS_HINT_KW_CAT);
    if (kw && km[kw]) {
      if (!p.suggestedCategory) p.suggestedCategory = km[kw];
      if (!p.category) p.category = km[kw];
    }
    const nm = normNameSmart(p.name);
    const pm = loadHintsMap(LS_HINT_NAME_PRICE);
    if (
      nm &&
      pm[nm] != null &&
      (p.price == null || p.price === '' || Number(p.price) === 0 || Number.isNaN(Number(p.price)))
    ) {
      const n = Number(pm[nm]);
      if (Number.isFinite(n) && n > 0) p.price = n;
    }
    return p;
  }
  function learnSmartFromItem(it) {
    const kw = keywordFromSmartName(it.name);
    const cat = FS.getEffectiveCategory(it);
    if (kw && cat) {
      const km = loadHintsMap(LS_HINT_KW_CAT);
      km[kw] = cat;
      saveHintsMap(LS_HINT_KW_CAT, km);
    }
    const nm = normNameSmart(it.name);
    const pr = Number(it.price);
    if (nm && Number.isFinite(pr) && pr > 0) {
      const pm = loadHintsMap(LS_HINT_NAME_PRICE);
      pm[nm] = pr;
      saveHintsMap(LS_HINT_NAME_PRICE, pm);
    }
  }

  function addCalendarMonthsToYmd(ymd, nMonths) {
    const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return '';
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const day = Number(m[3]);
    const d = new Date(y, mo + nMonths, 1);
    const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const dd = Math.min(day, last);
    d.setDate(dd);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  }

  function applyDelayToItems(ids, mode) {
    const idList = [...ids].filter(Boolean);
    if (!idList.length) return;
    recordUndo('delay');
    let hintNext = '';
    idList.forEach(function (id) {
      const it = items.find((x) => x.id === id);
      if (!it) return;
      const base =
        it.plannedDate && /^\d{4}-\d{2}-\d{2}$/.test(it.plannedDate) ? it.plannedDate : defaultTodayYmd();
      const next = mode === 'plus7' ? addDaysToYmd(base, 7) : addCalendarMonthsToYmd(base, 1);
      if (!next) return;
      it.plannedDate = next;
      it.date = next;
      it.stage = 'Delayed';
      it.status = 'Delayed';
      if (!hintNext) hintNext = next;
    });
    FS.saveItems(items);
    refreshAll();
    let sub = '';
    if (hintNext) {
      const m = hintNext.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) {
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        if (mode === 'plus7') {
          sub = 'Moved to ' + d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });
        } else {
          sub = 'Moved to ' + d.toLocaleDateString('en-GB', { month: 'long' });
        }
      }
    }
    showUndoToast(sub || (mode === 'plus7' ? '+7 days' : 'Rescheduled'));
  }

  function updateBulkBar() {
    const bar = $('#sideBulkBar');
    const count = $('#sideBulkCount');
    const n = sideSelectionIds.size;
    if (count) count.textContent = n ? n + ' selected' : '';
    if (bar) {
      bar.hidden = n === 0;
      bar.setAttribute('aria-hidden', n === 0 ? 'true' : 'false');
    }
    const list = $('#sideList');
    if (list) {
      list.querySelectorAll('.side-item[data-id]').forEach(function (el) {
        el.classList.toggle('is-selected', sideSelectionIds.has(el.getAttribute('data-id')));
      });
    }
  }

  function updateFirstRunHint() {
    const el = $('#firstRunHint');
    if (!el) return;
    el.hidden = items.length > 0;
  }

  function wireSideQuickActions(list) {
    list.querySelectorAll('.side-item__act').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        const id = btn.getAttribute('data-id');
        const act = btn.getAttribute('data-act');
        const it = items.find((x) => x.id === id);
        if (!it) return;
        if (act === 'edit') openEditModal(it);
        else if (act === 'delete') {
          if (!window.confirm('Delete this item?')) return;
          recordUndo('delete');
          items = items.filter((x) => x.id !== id);
          FS.saveItems(items);
          sideSelectionIds.delete(id);
          if (sideListFocusId === id) sideListFocusId = null;
          refreshAll();
          showUndoToast('Item deleted');
        } else if (act === 'delay') {
          applyDelayToItems([id], 'next-month');
        } else if (act === 'delay7') {
          applyDelayToItems([id], 'plus7');
        }
      });
    });
  }
  function isDuplicateStatementRow(tx) {
    const id = tx.importTransactionId || tx.transactionId || FS.statementTransactionId?.(tx);
    return items.some(function (it) {
      if (id && it.importTransactionId === id) return true;
      return (
        (it.plannedDate || it.date || '') === tx.date &&
        Math.abs((Number(it.price) || 0) - (Number(tx.amount) || 0)) < 0.01 &&
        String(it.name || '')
          .trim()
          .toLowerCase() ===
          String(tx.description || '')
            .trim()
            .toLowerCase()
      );
    });
  }
  function openModal(id) {
    const el = $(id);
    if (el) el.hidden = false;
  }
  function closeModal(id) {
    const el = $(id);
    if (el) el.hidden = true;
  }
  function closeTopModal() {
    const order = [
      '#modalShortcuts',
      '#modalChartOther',
      '#modalFast',
      '#modalEdit',
      '#modalAssign',
      '#modalCategoryReview',
      '#modalAdmin',
      '#modalStatementReview',
    ];
    for (let i = 0; i < order.length; i++) {
      const el = $(order[i]);
      if (el && !el.hidden) {
        closeModal(order[i]);
        return true;
      }
    }
    return false;
  }
  function anyModalOpen() {
    return !!document.querySelector('.modal:not([hidden])');
  }
  function isTypingInField(el) {
    if (!el || el === document.body) return false;
    const tag = el.tagName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'SELECT') return true;
    if (tag === 'INPUT') {
      const type = String(el.type || '').toLowerCase();
      if (['button', 'submit', 'checkbox', 'radio', 'reset', 'file', 'hidden'].includes(type)) return false;
      return true;
    }
    return Boolean(el.isContentEditable);
  }
  function navigateCalendarByKeys(delta) {
    if (!calendarOptions || !FS.shiftCalendarMonth) return;
    FS.shiftCalendarMonth(delta);
    rebuildCalendarShell();
  }
  function openChartOtherModal(rows) {
    const list = $('#chartOtherList');
    if (!list) return;
    list.innerHTML = (rows || [])
      .map(function (r) {
        const lab = r.label || [r.category, r.status].filter(Boolean).join(' · ') || '—';
        return (
          '<li class="chart-other-row"><span class="chart-other-row__label">' +
          escapeHtml(lab) +
          '</span><span class="chart-other-row__amt">' +
          money(r.amount) +
          '</span></li>'
        );
      })
      .join('');
    openModal('#modalChartOther');
  }
  function upsertApprovedCategory(cat) {
    const c = String(cat || '').trim();
    if (!c || approvedCategories.includes(c)) return;
    approvedCategories.push(c);
    approvedCategories.sort();
    FS.saveApprovedCategories(approvedCategories);
  }

  function updateTopBar() {
    const spentEl = $('#spentDisplay');
    const availableEl = $('#availableDisplay');
    const label = $('#currencyLabel');
    const y = FS.sumReservedBought(items);
    const total = Number(String($('#totalInput')?.value || '').replace(/,/g, '')) || 0;
    if (label) label.textContent = currencySymbol;
    if (spentEl) spentEl.textContent = '-' + money(y);
    if (availableEl) availableEl.textContent = money(Math.max(0, total - y));
  }

  function refreshAll() {
    updateTopBar();
    updateDashboard();
    const calRoot = $('#calendarRoot');
    if (calRoot) {
      FS.paintCalendarItems(calRoot, items, openEditModal);
      FS.setCalendarDaySelection(calRoot, selectedDate);
      wireCalendarDropTargets(calRoot);
    }
    renderUnscheduledLane();
    FS.updateSpendChart(items);
    renderMonthSummary();
    renderNext7Days();
    renderSidePanel();
    updateFirstRunHint();
  }

  function rebuildCalendarShell() {
    const calRoot = $('#calendarRoot');
    if (!calRoot || !calendarOptions) return;
    FS.renderCalendarShell(calRoot, calendarOptions);
    FS.paintCalendarItems(calRoot, items, openEditModal);
    FS.setCalendarDaySelection(calRoot, selectedDate);
    wireCalendarDropTargets(calRoot);
    renderUnscheduledLane();
    FS.updateSpendChart(items);
    updateDashboard();
    renderMonthSummary();
    renderNext7Days();
    renderSidePanel();
  }

  function wireCalendarDropTargets(calRoot) {
    if (calRoot.dataset.fsCalDrop === '1') return;
    calRoot.dataset.fsCalDrop = '1';

    function clearCalDropHighlight() {
      calRoot.querySelectorAll('.cal-cell.is-drop-target').forEach(function (c) {
        c.classList.remove('is-drop-target');
      });
      calRoot.querySelectorAll('.cal-drop-next-month.is-drop-target-nav').forEach(function (b) {
        b.classList.remove('is-drop-target-nav');
      });
    }

    calRoot.addEventListener('dragover', function (e) {
      const btn = e.target.closest('[data-cal-drop-next-month]');
      const cell = e.target.closest('.cal-cell[data-date]');
      if (btn) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearCalDropHighlight();
        btn.classList.add('is-drop-target-nav');
        return;
      }
      if (cell && !cell.classList.contains('cal-cell--pad')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        clearCalDropHighlight();
        cell.classList.add('is-drop-target');
      }
    });

    calRoot.addEventListener('dragleave', function (e) {
      const cell = e.target.closest('.cal-cell[data-date]');
      if (cell && cell.classList.contains('is-drop-target') && !cell.contains(e.relatedTarget)) {
        cell.classList.remove('is-drop-target');
      }
      const btn = e.target.closest('[data-cal-drop-next-month]');
      if (btn && btn.classList.contains('is-drop-target-nav') && !btn.contains(e.relatedTarget)) {
        btn.classList.remove('is-drop-target-nav');
      }
    });

    calRoot.addEventListener('drop', function (e) {
      e.preventDefault();
      const btn = e.target.closest('[data-cal-drop-next-month]');
      if (btn) {
        clearCalDropHighlight();
        const id = e.dataTransfer?.getData('text/flowspend-item');
        const ymd = FS.getNextMonthFirstYmd?.() || '';
        assignItemToPlannedDate(id, ymd, 'Moved to next month');
        return;
      }
      const cell = e.target.closest('.cal-cell[data-date]');
      clearCalDropHighlight();
      if (!cell) return;
      const id = e.dataTransfer?.getData('text/flowspend-item');
      const date = cell.getAttribute('data-date');
      assignItemToPlannedDate(id, date, 'Date updated');
    });
  }

  function openAssignDateModal(item) {
    if (!item) return;
    $('#assignId').value = item.id;
    $('#assignDate').value = item.plannedDate || item.date || defaultTodayYmd();
    openModal('#modalAssign');
  }

  function wireDraggableItemRows(root) {
    root.querySelectorAll('[draggable="true"][data-id]').forEach(function (row) {
      row.addEventListener('dragstart', function (e) {
        row.classList.add('is-dragging');
        e.dataTransfer?.setData('text/flowspend-item', row.getAttribute('data-id') || '');
      });
      row.addEventListener('dragend', function () {
        row.classList.remove('is-dragging');
      });
    });
  }

  function renderUnscheduledLane() {
    const lane = $('#unscheduledLane');
    if (!lane) return;
    const rows = applySideFilters(FS.itemsSideDefault(items).filter(isUnscheduledUpcoming));
    if (!rows.length) {
      lane.hidden = true;
      lane.innerHTML = '';
      return;
    }
    lane.hidden = false;
    lane.innerHTML =
      '<div class="unscheduled-lane__head"><div><span class="unscheduled-lane__eyebrow">Unscheduled upcoming</span><strong>' +
      rows.length +
      (rows.length === 1 ? ' item' : ' items') +
      '</strong></div><span class="unscheduled-lane__hint">Drag onto a calendar day, or open to add a date.</span></div><div class="unscheduled-lane__items">' +
      rows
        .map(function (i) {
          return (
            '<button type="button" class="unscheduled-chip" draggable="true" data-id="' +
            i.id +
            '"><span class="unscheduled-chip__main"><span class="unscheduled-chip__name">' +
            stageIconSpan(i.stage || i.status || 'Idea') +
            escapeHtml(i.name) +
            '</span><span class="unscheduled-chip__meta">' +
            escapeHtml(i.stage || i.status || 'Idea') +
            ' &middot; ' +
            escapeHtml(FS.getEffectiveCategory(i)) +
            '</span></span><span class="unscheduled-chip__price">' +
            money(i.price) +
            '</span></button>'
          );
        })
        .join('') +
      '</div>';
    lane.querySelectorAll('.unscheduled-chip').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const id = btn.getAttribute('data-id');
        const it = items.find((x) => x.id === id);
        if (it) openEditModal(it);
      });
    });
    wireDraggableItemRows(lane);
  }

  function wireSideInlineEditors(list) {
    function itemFromEl(el) {
      const row = el.closest('.side-item[data-id]');
      if (!row) return null;
      return items.find((x) => x.id === row.getAttribute('data-id'));
    }
    list.querySelectorAll('.side-editable--name').forEach(function (span) {
      span.addEventListener('click', function (e) {
        e.stopPropagation();
        if (span.querySelector('input')) return;
        const it = itemFromEl(span);
        if (!it) return;
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.className = 'side-inline-input';
        inp.value = it.name;
        span.replaceChildren(inp);
        inp.focus();
        inp.select();
        function finish(save) {
          if (save) {
            recordUndo('inline name');
            it.name = inp.value.trim() || it.name;
            FS.saveItems(items);
            showUndoToast('Name updated');
          }
          refreshAll();
        }
        inp.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            finish(true);
          }
          if (ev.key === 'Escape') {
            ev.preventDefault();
            finish(false);
          }
        });
        inp.addEventListener(
          'blur',
          function () {
            finish(true);
          },
          { once: true },
        );
      });
    });
    list.querySelectorAll('.side-editable--price').forEach(function (span) {
      span.addEventListener('click', function (e) {
        e.stopPropagation();
        if (span.querySelector('input')) return;
        const it = itemFromEl(span);
        if (!it) return;
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.min = '0';
        inp.step = '1';
        inp.className = 'side-inline-input';
        inp.value = String(Number(it.price) || 0);
        span.replaceChildren(inp);
        inp.focus();
        inp.select();
        function finish(save) {
          if (save) {
            recordUndo('inline price');
            it.price = Math.max(0, Number(inp.value) || 0);
            FS.saveItems(items);
            showUndoToast('Price updated');
          }
          refreshAll();
        }
        inp.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            finish(true);
          }
          if (ev.key === 'Escape') {
            ev.preventDefault();
            finish(false);
          }
        });
        inp.addEventListener(
          'blur',
          function () {
            finish(true);
          },
          { once: true },
        );
      });
    });
    list.querySelectorAll('.side-editable--date').forEach(function (span) {
      span.addEventListener('click', function (e) {
        e.stopPropagation();
        if (span.querySelector('input')) return;
        const it = itemFromEl(span);
        if (!it) return;
        const inp = document.createElement('input');
        inp.type = 'date';
        inp.className = 'side-inline-input';
        const cur = it.plannedDate || it.deadline || '';
        inp.value = /^\d{4}-\d{2}-\d{2}$/.test(cur) ? cur : '';
        span.replaceChildren(inp);
        inp.focus();
        try {
          inp.showPicker();
        } catch {
          /* ignore */
        }
        function finish(save) {
          if (save && inp.value) {
            recordUndo('inline date');
            it.plannedDate = inp.value;
            it.date = inp.value;
            if (!['Committed', 'Scheduled', 'Bought', 'Delayed'].includes(it.stage || it.status)) {
              it.stage = 'Scheduled';
              it.status = 'Scheduled';
            }
            FS.saveItems(items);
            showUndoToast('Date updated');
          }
          refreshAll();
        }
        inp.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            finish(true);
          }
          if (ev.key === 'Escape') {
            ev.preventDefault();
            finish(false);
          }
        });
        inp.addEventListener(
          'blur',
          function () {
            finish(Boolean(inp.value));
          },
          { once: true },
        );
      });
    });
  }

  function renderSidePanel() {
    const list = $('#sideList');
    if (!list) return;
    const rows = applySideFilters(FS.itemsSideDefault(items));
    if (!rows.length) {
      list.innerHTML =
        '<li class="side-empty"><span class="side-empty__title">No upcoming items match.</span><span class="side-empty__hint">Add something from the bar below, or pick a date on the calendar and plan a spend.</span></li>';
      renderBoughtList();
      return;
    }
    const statuses = FS.getStatuses();
    const parts = partitionSideRowsForGroup(rows);
    const blocks = [];
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi];
      if (part.label) {
        blocks.push('<li class="side-list__grouphead" role="presentation">' + escapeHtml(part.label) + '</li>');
      }
      for (let ri = 0; ri < part.items.length; ri++) {
        const i = part.items[ri];
        const shownCat = FS.getEffectiveCategory(i);
        const tone = sideStageToneClass(i.stage || i.status);
        const recur =
          i.type === 'Recurring'
            ? '<span class="side-item__recur" aria-hidden="true" title="Recurring">↻ </span>'
            : '';
        blocks.push(
          '<li class="side-item ' +
            tone +
            (sideSelectionIds.has(i.id) ? ' is-selected' : '') +
            '" draggable="true" data-id="' +
            i.id +
            '">' +
            '<div class="side-item__row"><span class="side-item__name-wrap">' +
            stageIconSpan(i.stage || i.status) +
            recur +
            '<span class="side-editable side-editable--name" data-field="name" tabindex="0" role="button">' +
            escapeHtml(i.name) +
            '</span></span><span class="side-editable side-editable--price" data-field="price" tabindex="0" role="button">' +
            money(i.price) +
            '</span><span class="side-item__cat">' +
            escapeHtml(shownCat) +
            '</span><select class="side-status" data-id="' +
            i.id +
            '" aria-label="Status">' +
            statuses
              .map(function (s) {
                return (
                  '<option value="' + s + '"' + ((i.stage || i.status) === s ? ' selected' : '') + '>' + s + '</option>'
                );
              })
              .join('') +
            '</select></div><div class="side-item__meta"><span class="side-editable side-editable--date" data-field="date" tabindex="0" role="button">' +
            escapeHtml(i.plannedDate || i.deadline || 'No date') +
            '</span>' +
            (i.link
              ? '<a class="side-link" href="' + escapeAttr(i.link) + '" target="_blank" rel="noopener">Link</a>'
              : '<span class="side-link side-link--muted">—</span>') +
            '</div>' +
            '<div class="side-item__quick">' +
            '<button type="button" class="side-item__act" data-act="edit" data-id="' +
            i.id +
            '" title="Edit" aria-label="Edit">✏️</button>' +
            '<button type="button" class="side-item__act" data-act="delay" data-id="' +
            i.id +
            '" title="Next month" aria-label="Delay to next month">⏳</button>' +
            '<button type="button" class="side-item__act side-item__act--sub" data-act="delay7" data-id="' +
            i.id +
            '" title="+7 days" aria-label="+7 days">+7</button>' +
            '<button type="button" class="side-item__act" data-act="delete" data-id="' +
            i.id +
            '" title="Delete" aria-label="Delete">🗑️</button>' +
            '</div></li>',
        );
      }
    }
    list.innerHTML = blocks.join('');
    list.querySelectorAll('.side-status').forEach(function (sel) {
      sel.addEventListener('change', function () {
        const id = sel.getAttribute('data-id');
        const it = items.find((x) => x.id === id);
        if (!it) return;
        recordUndo('stage change');
        it.stage = sel.value;
        it.status = sel.value;
        if (!['Committed', 'Scheduled', 'Bought', 'Delayed'].includes(it.stage)) {
          it.plannedDate = '';
          it.date = '';
        }
        FS.saveItems(items);
        refreshAll();
        showUndoToast('Status updated');
      });
    });
    wireDraggableItemRows(list);
    wireSideInlineEditors(list);
    wireSideQuickActions(list);
    updateBulkBar();
    if (sideListFocusId) {
      const row = list.querySelector('.side-item[data-id="' + sideListFocusId + '"]');
      list.querySelectorAll('.side-item--kbd').forEach(function (el) {
        el.classList.remove('side-item--kbd');
      });
      if (row) row.classList.add('side-item--kbd');
    }
    renderBoughtList();
  }

  function renderBoughtList() {
    const list = $('#boughtList');
    if (!list) return;
    const meta = getRecentBoughtMeta();
    const label = $('#recentBoughtLabel');
    if (label) {
      label.textContent = new Date(meta.year, meta.monthIndex, 1).toLocaleDateString('en-GB', {
        month: 'short',
        year: 'numeric',
      });
    }
    const rows = applySideFilters(FS.itemsBoughtInMonth(items, meta.year, meta.monthIndex));
    if (!rows.length) {
      list.innerHTML =
        '<li class="side-empty"><span class="side-empty__title">Nothing bought in this month.</span><span class="side-empty__hint">Use the arrows to browse other months, or mark an item as bought from its card.</span></li>';
      return;
    }
    list.innerHTML = rows
      .map(function (i) {
        const importedClass = FS.isImportedItem?.(i) ? ' side-item--imported' : '';
        const importedLabel = FS.isImportedItem?.(i) ? '<span class="side-item__source">Imported</span>' : '';
        return (
          '<li class="side-item side-item--bought' +
          importedClass +
          '" role="button" tabindex="0" data-id="' +
          i.id +
          '"><div class="side-item__row"><span class="side-item__name">' +
          stageIconSpan(i.stage || i.status || 'Bought') +
          escapeHtml(i.name) +
          '</span><span class="side-item__price">' +
          money(i.price) +
          '</span><span class="side-item__cat">' +
          escapeHtml(FS.getEffectiveCategory(i)) +
          '</span></div><div class="side-item__meta"><span class="side-date">' +
          escapeHtml(i.plannedDate || i.date || '') +
          '</span></div>' +
          importedLabel +
          '</li>'
        );
      })
      .join('');
    list.querySelectorAll('.side-item--bought').forEach(function (row) {
      const open = function () {
        const id = row.getAttribute('data-id');
        const it = items.find((x) => x.id === id);
        if (it) openEditModal(it);
      };
      row.addEventListener('click', open);
      row.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    });
  }

  function defaultTodayYmd() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function updateBarDateChip() {
    var text = $('#barDateChipText');
    if (!text) return;
    if (!selectedDate) {
      text.hidden = true;
      text.textContent = '';
      return;
    }
    text.hidden = false;
    text.textContent = selectedDate;
  }

  function getRecentBoughtMeta() {
    if (recentBoughtYear == null || recentBoughtMonthIndex == null) {
      const meta = FS.getCalendarMeta();
      recentBoughtYear = meta.year;
      recentBoughtMonthIndex = meta.monthIndex;
    }
    const normalized = new Date(recentBoughtYear, recentBoughtMonthIndex, 1);
    recentBoughtYear = normalized.getFullYear();
    recentBoughtMonthIndex = normalized.getMonth();
    return { year: recentBoughtYear, monthIndex: recentBoughtMonthIndex };
  }

  function shiftRecentBoughtMonth(delta) {
    const meta = getRecentBoughtMeta();
    const d = new Date(meta.year, meta.monthIndex + delta, 1);
    recentBoughtYear = d.getFullYear();
    recentBoughtMonthIndex = d.getMonth();
    renderBoughtList();
  }

  async function openReviewFromBar(line) {
    const meta = FS.getCalendarMeta();
    const p = await FS.parseSmartInput(line, {
      refYear: meta.year,
      attachDate: selectedDate,
      categoryMappings: categoryMappings,
      approvedCategories: approvedCategories,
    });
    lastParsedResult = p;
    applySmartHintsToParsed(p);
    fillFastReviewFields(p);
    setupFastCandidates(p);
    const src = $('#fastParseSource');
    if (src) src.textContent = parseSourceLabel(p);
    openModal('#modalFast');
  }

  function parseSourceLabel(parsed) {
    if (parsed.parseSource !== 'ai')
      return 'Using fallback rules. AI comparison appears only when an AI provider responds.';
    const count = parsed.aiCandidates?.length || 0;
    if (count > 1) return `Using best AI result. You can compare ${count} AI answers below.`;
    if (count === 1) return `Using ${parsed.aiCandidates[0].label}.`;
    return 'Using AI result.';
  }

  function fillFastReviewFields(parsed) {
    $('#fastName').value = parsed.name || '';
    $('#fastPrice').value = parsed.price != null ? String(parsed.price) : '';
    $('#fastCategory').value = parsed.suggestedCategory || parsed.category || '';
    $('#fastDate').value = parsed.plannedDate || parsed.date || '';
    $('#fastDeadline').value = parsed.deadline || '';
    $('#fastType').value = parsed.type || 'One-off';
    $('#fastNote').value = parsed.note || '';
    $('#fastAssumptions').value = (parsed.assumptions || []).join('\n');
    $('#fastLink').value = parsed.link || '';
    $('#fastStatus').value = parsed.stage || parsed.status || 'Idea';
  }

  function setupFastCandidates(parsed) {
    const row = $('#fastCandidateRow');
    const select = $('#fastCandidateSelect');
    if (!row || !select) return;
    const candidates = parsed.aiCandidates || [];
    if (candidates.length < 2) {
      row.hidden = true;
      select.innerHTML = '';
      return;
    }
    row.hidden = false;
    select.innerHTML = candidates
      .map(function (candidate, index) {
        const candidateParsed = candidate.parsed || {};
        const selected =
          candidateParsed.name === parsed.name &&
          Number(candidateParsed.price || 0) === Number(parsed.price || 0) &&
          (candidateParsed.stage || candidateParsed.status) === (parsed.stage || parsed.status)
            ? ' selected'
            : '';
        const preview = [
          candidate.label,
          candidateParsed.name,
          candidateParsed.price ? money(candidateParsed.price) : '',
          candidateParsed.stage || candidateParsed.status || '',
        ]
          .filter(Boolean)
          .join(' - ');
        return '<option value="' + index + '"' + selected + '>' + escapeHtml(preview) + '</option>';
      })
      .join('');
    select.onchange = function () {
      const candidate = candidates[Number(select.value)];
      if (!candidate) return;
      lastParsedResult = Object.assign({}, candidate.parsed, { aiCandidates: candidates, parseSource: 'ai' });
      fillFastReviewFields(lastParsedResult);
      const src = $('#fastParseSource');
      if (src) src.textContent = `AI parse from ${candidate.label}`;
    };
  }

  function openEditModal(item) {
    $('#editId').value = item.id;
    $('#editName').value = item.name;
    $('#editPrice').value = item.price;
    $('#editCategory').value = FS.getEffectiveCategory(item);
    $('#editStatus').value = item.stage || item.status;
    $('#editDate').value = item.plannedDate || item.date || '';
    $('#editDeadline').value = item.deadline || '';
    $('#editType').value = item.type || 'One-off';
    $('#editNote').value = item.note || '';
    $('#editRecurrenceInterval').value = item.recurrence?.interval || 'monthly';
    $('#editRecurrenceDay').value = item.recurrence?.dayOfMonth || 1;
    $('#editLink').value = item.link || '';
    syncDateFieldState();
    syncDetailsVisibility();
    openModal('#modalEdit');
  }
  function syncDateFieldState() {
    const st = $('#editStatus')?.value;
    const d = $('#editDate');
    if (!d) return;
    const allow = ['Committed', 'Scheduled', 'Bought', 'Delayed'].includes(st);
    d.disabled = !allow;
    d.title = allow ? '' : 'Set stage to Committed, Scheduled, Delayed or Bought to use a date';
  }

  function syncDetailsVisibility() {
    const st = $('#editStatus')?.value;
    const type = $('#editType')?.value;
    const dateRow = $('#editDateRow');
    const deadlineRow = $('#editDeadlineRow');
    const noteRow = $('#editNoteRow');
    const recur = $('#editRecurrenceFields');
    if (dateRow)
      dateRow.hidden = !($('#editDate').value || ['Committed', 'Scheduled', 'Bought', 'Delayed'].includes(st));
    if (deadlineRow) deadlineRow.hidden = !$('#editDeadline').value;
    if (noteRow) noteRow.hidden = !$('#editNote').value;
    if (recur) recur.hidden = type !== 'Recurring';
  }

  function openCategoryReview() {
    const box = $('#categoryReviewList');
    if (!box) return;
    const grouped = {};
    items.forEach(function (it) {
      const suggested = String(it.suggestedCategory || it.category || 'general').trim() || 'general';
      const key = suggested.toLowerCase();
      if (!grouped[key]) grouped[key] = { suggested, count: 0 };
      grouped[key].count += 1;
    });
    const rows = Object.values(grouped).sort((a, b) => b.count - a.count);
    if (!rows.length) {
      box.innerHTML = '<p class="cat-empty">No categories found yet.</p>';
      openModal('#modalCategoryReview');
      return;
    }
    box.innerHTML = rows
      .map(function (r) {
        const mapped = categoryMappings[r.suggested.toLowerCase()] || '';
        const options = ['']
          .concat(approvedCategories)
          .map(function (c) {
            const label = c || 'Select approved category';
            const sel = c === mapped ? ' selected' : '';
            return '<option value="' + escapeAttr(c) + '"' + sel + '>' + escapeHtml(label) + '</option>';
          })
          .join('');
        return (
          '<div class="cat-row" data-suggested="' +
          escapeAttr(r.suggested) +
          '"><div class="cat-row__left"><strong>' +
          escapeHtml(r.suggested) +
          '</strong><span>' +
          r.count +
          ' items</span></div><select class="cat-approved">' +
          options +
          '</select><input type="text" class="cat-new" placeholder="or type new" /></div>'
        );
      })
      .join('');
    openModal('#modalCategoryReview');
  }

  function renderStatementReview(rows, fileName) {
    pendingStatementRows = rows.map(function (row) {
      const tx = Object.assign({}, row);
      tx.importTransactionId = tx.transactionId || FS.statementTransactionId?.(tx) || '';
      tx.duplicate = isDuplicateStatementRow(tx);
      tx.selected = !tx.duplicate;
      return tx;
    });

    const summary = $('#statementReviewSummary');
    const list = $('#statementReviewList');
    const totalsEl = $('#statementReviewTotals');
    if (!summary || !list) return;

    const selectedCount = pendingStatementRows.filter((r) => r.selected).length;
    const duplicateCount = pendingStatementRows.filter((r) => r.duplicate).length;
    summary.textContent =
      `${fileName}: ${pendingStatementRows.length} outgoing transactions parsed. ` +
      `${selectedCount} selected` +
      (duplicateCount ? `, ${duplicateCount} possible duplicate${duplicateCount === 1 ? '' : 's'} unticked.` : '.');

    if (!pendingStatementRows.length) {
      list.innerHTML = '<p class="statement-empty">No outgoing transactions were found in this statement.</p>';
      if (totalsEl) totalsEl.textContent = '';
      openModal('#modalStatementReview');
      return;
    }

    let lastDay = '';
    const sorted = pendingStatementRows
      .map(function (r, idx) {
        return { r: r, idx: idx };
      })
      .sort(function (a, b) {
        return (
          (a.r.date || '').localeCompare(b.r.date || '') ||
          String(a.r.description || '').localeCompare(String(b.r.description || ''))
        );
      });
    list.innerHTML = sorted
      .map(function (o) {
        const r = o.r;
        const idx = o.idx;
        const day = r.date || '—';
        const heading =
          day !== lastDay
            ? '<div class="statement-group statement-group--bydate"><span>' + escapeHtml(day) + '</span></div>'
            : '';
        lastDay = day;
        return (
          heading +
          '<div class="statement-row' +
          (r.duplicate ? ' statement-row--duplicate' : '') +
          '" data-row="' +
          idx +
          '">' +
          '<label class="statement-row__check"><input type="checkbox" class="statement-select"' +
          (r.selected ? ' checked' : '') +
          ' />' +
          (r.duplicate
            ? '<span class="statement-dup-label">Duplicate <em>review</em></span>'
            : '<span>Import</span>') +
          '</label>' +
          '<input type="date" class="statement-date" value="' +
          escapeAttr(r.date || '') +
          '" />' +
          '<input type="text" class="statement-name" value="' +
          escapeAttr(r.description || '') +
          '" />' +
          '<input type="number" class="statement-amount" min="0" step="0.01" value="' +
          escapeAttr(r.amount || '') +
          '" />' +
          '<input type="text" class="statement-category" value="' +
          escapeAttr(r.suggestedCategory || 'Other') +
          '" />' +
          '</div>'
        );
      })
      .join('');
    syncStatementReviewTotals();
    openModal('#modalStatementReview');
  }

  async function importStatementFile(file) {
    const summary = $('#statementReviewSummary');
    if (summary) summary.textContent = 'Reading statement...';
    try {
      const parsed = await FS.parseStatementFile(file);
      renderStatementReview(parsed, file.name);
    } catch (error) {
      window.alert(error?.message || 'Could not read statement.');
    }
  }

  function saveSelectedStatementRows() {
    const rows = [];
    document.querySelectorAll('.statement-row').forEach(function (row) {
      const idx = Number(row.getAttribute('data-row'));
      const base = pendingStatementRows[idx];
      if (!base || !row.querySelector('.statement-select')?.checked) return;
      rows.push(
        Object.assign({}, base, {
          date: row.querySelector('.statement-date')?.value || base.date,
          description: row.querySelector('.statement-name')?.value || base.description,
          amount: Number(row.querySelector('.statement-amount')?.value || base.amount) || 0,
          suggestedCategory: row.querySelector('.statement-category')?.value || base.suggestedCategory || 'Other',
        }),
      );
    });

    if (!rows.length) {
      closeModal('#modalStatementReview');
      return;
    }

    const now = Date.now();
    const imported = rows.map(function (tx) {
      const mapped = categoryMappings[String(tx.suggestedCategory || '').toLowerCase()] || '';
      return FS.createItem({
        name: tx.description || 'Imported transaction',
        price: tx.amount || 0,
        category: mapped || tx.suggestedCategory || 'Other',
        suggestedCategory: tx.suggestedCategory || 'Other',
        approvedCategory: mapped,
        stage: 'Bought',
        status: 'Bought',
        type: 'One-off',
        plannedDate: tx.date || '',
        date: tx.date || '',
        note: 'Imported',
        imported: true,
        importSource: tx.source || 'MCB statement',
        importFormat: tx.sourceFormat || '',
        importTransactionId: tx.importTransactionId || tx.transactionId || FS.statementTransactionId?.(tx) || '',
        importedAt: now,
        parseSource: 'statement',
      });
    });

    recordUndo('statement import');
    items = items.concat(imported);
    FS.saveItems(items);
    if (imported[0]?.plannedDate) {
      selectedDate = imported[0].plannedDate;
      const recent = new Date(imported[0].plannedDate + 'T00:00:00');
      recentBoughtYear = recent.getFullYear();
      recentBoughtMonthIndex = recent.getMonth();
      FS.setCalendarFocusDate?.(imported[0].plannedDate);
      rebuildCalendarShell();
      updateBarDateChip();
    }
    pendingStatementRows = [];
    closeModal('#modalStatementReview');
    refreshAll();
    showUndoToast(`Imported ${imported.length} transaction${imported.length === 1 ? '' : 's'}`);
  }

  function wireUi() {
    [
      '#modalEdit',
      '#modalFast',
      '#modalAssign',
      '#modalCategoryReview',
      '#modalAdmin',
      '#modalStatementReview',
      '#modalChartOther',
      '#modalShortcuts',
    ].forEach(function (id) {
      const el = $(id);
      if (!el) return;
      el.addEventListener('click', function (e) {
        if (e.target.id === id.slice(1)) closeModal(id);
      });
    });
    $('#btnChartOtherClose')?.addEventListener('click', function () {
      closeModal('#modalChartOther');
    });
    $('#btnShortcutsClose')?.addEventListener('click', function () {
      closeModal('#modalShortcuts');
    });
    const qa = $('#quickAddMode');
    if (qa) {
      try {
        qa.checked = localStorage.getItem('flowspend_quick_add') === '1';
      } catch {
        /* ignore */
      }
      qa.addEventListener('change', function () {
        try {
          localStorage.setItem('flowspend_quick_add', this.checked ? '1' : '0');
        } catch {
          /* ignore */
        }
      });
    }
    const stmtList = $('#statementReviewList');
    if (stmtList && stmtList.dataset.fsTotalsWire !== '1') {
      stmtList.dataset.fsTotalsWire = '1';
      stmtList.addEventListener('change', function (e) {
        const t = e.target;
        if (t && t.classList && t.classList.contains('statement-select')) syncStatementReviewTotals();
      });
      stmtList.addEventListener('input', function (e) {
        const t = e.target;
        if (t && t.classList && t.classList.contains('statement-amount')) syncStatementReviewTotals();
      });
    }
    $('#editStatus')?.addEventListener('change', syncDateFieldState);
    $('#editStatus')?.addEventListener('change', syncDetailsVisibility);
    $('#editType')?.addEventListener('change', syncDetailsVisibility);

    $('#formEdit')?.addEventListener('submit', function (e) {
      e.preventDefault();
      const id = $('#editId').value;
      const it = items.find((x) => x.id === id);
      if (!it) return;
      recordUndo('edit item');
      const editedCat = $('#editCategory').value || 'general';
      it.name = $('#editName').value;
      it.price = Number($('#editPrice').value) || 0;
      it.suggestedCategory = editedCat;
      it.approvedCategory = '';
      it.category = editedCat;
      it.stage = $('#editStatus').value;
      it.status = it.stage;
      it.type = $('#editType').value || 'One-off';
      it.plannedDate = $('#editDate').value || '';
      it.date = it.plannedDate;
      it.deadline = $('#editDeadline').value || '';
      it.note = $('#editNote').value || '';
      it.recurrence =
        it.type === 'Recurring'
          ? {
              interval: $('#editRecurrenceInterval').value || 'monthly',
              dayOfMonth: Number($('#editRecurrenceDay').value) || 1,
              monthsAhead: 6,
            }
          : null;
      it.link = $('#editLink').value;
      if (!['Committed', 'Scheduled', 'Bought', 'Delayed'].includes(it.stage)) {
        it.plannedDate = '';
        it.date = '';
      }
      FS.saveItems(items);
      closeModal('#modalEdit');
      refreshAll();
      learnSmartFromItem(it);
      showUndoToast('Item updated');
    });

    $('#btnDelete')?.addEventListener('click', function () {
      const id = $('#editId').value;
      recordUndo('delete item');
      items = items.filter((x) => x.id !== id);
      FS.saveItems(items);
      closeModal('#modalEdit');
      refreshAll();
      showUndoToast('Item deleted');
    });
    $('#btnEditCancel')?.addEventListener('click', () => closeModal('#modalEdit'));

    $('#formAssign')?.addEventListener('submit', function (e) {
      e.preventDefault();
      const id = $('#assignId').value;
      const it = items.find((x) => x.id === id);
      if (!it) return;
      recordUndo('assign date');
      it.plannedDate = $('#assignDate').value;
      it.date = it.plannedDate;
      if (!['Committed', 'Scheduled', 'Bought'].includes(it.stage || it.status)) {
        it.stage = 'Scheduled';
        it.status = 'Scheduled';
      }
      FS.saveItems(items);
      closeModal('#modalAssign');
      refreshAll();
      showUndoToast('Date assigned');
    });
    $('#btnAssignCancel')?.addEventListener('click', () => closeModal('#modalAssign'));
    $('#btnFastCancel')?.addEventListener('click', () => closeModal('#modalFast'));

    $('#btnFastSave')?.addEventListener('click', function () {
      const suggested = $('#fastCategory').value || 'general';
      const mapped = categoryMappings[String(suggested).toLowerCase()] || '';
      recordUndo('add item');
      const it = FS.createItem({
        name: $('#fastName').value,
        price: $('#fastPrice').value,
        category: mapped || suggested,
        suggestedCategory: suggested,
        approvedCategory: mapped,
        categoryConfidence: lastParsedResult?.categoryConfidence || 0,
        parseSource: lastParsedResult?.parseSource || 'rule',
        stage: $('#fastStatus').value,
        status: $('#fastStatus').value,
        type: $('#fastType').value || 'One-off',
        plannedDate: $('#fastDate').value || '',
        date: $('#fastDate').value || '',
        deadline: $('#fastDeadline').value || '',
        note: $('#fastNote').value || '',
        assumptions: ($('#fastAssumptions').value || '').split('\n').filter(Boolean),
        link: $('#fastLink').value,
      });
      items.push(it);
      FS.saveItems(items);
      learnSmartFromItem(it);
      closeModal('#modalFast');
      const bar = $('#barInput');
      if (bar) bar.value = '';
      refreshAll();
      showUndoToast('Item added');
      bar?.focus();
    });

    $('#barInput')?.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const line = $('#barInput').value.trim();
      if (!line) return;
      if ($('#quickAddMode')?.checked) {
        const meta = FS.getCalendarMeta();
        const p = FS.parseFastInput(line, { refYear: meta.year, attachDate: selectedDate });
        applySmartHintsToParsed(p);
        if (quickAddRuleParseOk(p)) {
          commitItemFromRuleParse(p);
          $('#barInput').value = '';
          refreshAll();
          showUndoToast('Item added');
          $('#barInput').focus();
          return;
        }
      }
      openReviewFromBar(line);
    });

    $('#barDateClear')?.addEventListener('click', function () {
      selectedDate = null;
      const calRoot = $('#calendarRoot');
      if (calRoot) FS.setCalendarDaySelection(calRoot, null);
      updateBarDateChip();
    });

    $('#btnCategoryReview')?.addEventListener('click', openCategoryReview);
    $('#btnCategoryReviewCancel')?.addEventListener('click', () => closeModal('#modalCategoryReview'));
    $('#btnCategoryReviewApply')?.addEventListener('click', function () {
      recordUndo('category mappings');
      document.querySelectorAll('.cat-row').forEach(function (row) {
        const suggested = row.getAttribute('data-suggested') || '';
        const pick = row.querySelector('.cat-approved')?.value || '';
        const typed = row.querySelector('.cat-new')?.value || '';
        const approved = String(typed || pick).trim();
        if (!suggested || !approved) return;
        categoryMappings[suggested.toLowerCase()] = approved;
        upsertApprovedCategory(approved);
      });
      FS.saveCategoryMappings(categoryMappings);
      items.forEach(function (it) {
        const suggested = String(it.suggestedCategory || it.category || '')
          .trim()
          .toLowerCase();
        const mapped = categoryMappings[suggested];
        if (mapped) {
          it.approvedCategory = mapped;
          it.category = mapped;
        }
      });
      FS.saveItems(items);
      closeModal('#modalCategoryReview');
      refreshAll();
      showToast('Category mappings applied');
    });

    $('#btnAdmin')?.addEventListener('click', function () {
      loadAdminForm();
      openModal('#modalAdmin');
    });
    $('#btnAdminCancel')?.addEventListener('click', function () {
      applyAccentColor(localStorage.getItem('flowspend_accent_color') || DEFAULT_ACCENT);
      closeModal('#modalAdmin');
    });
    $('#btnAdminSave')?.addEventListener('click', saveAdminForm);
    $('#btnAddAiProvider')?.addEventListener('click', function () {
      addCustomProviderRow();
    });
    ['#adminGeminiApiKey', '#adminGeminiModel', '#adminOpenAiApiKey', '#adminOpenAiModel'].forEach(function (id) {
      $(id)?.addEventListener('input', updateAdminProviderStatus);
    });
    $('#themeColorPicker')?.addEventListener('input', function () {
      saveTheme(this.value, 'custom');
    });
    $('#themePreset')?.addEventListener('change', function () {
      const preset = this.value;
      if (preset === 'custom') return;
      saveTheme(THEME_PRESETS[preset] || DEFAULT_ACCENT, preset);
      showToast(`${preset.charAt(0).toUpperCase() + preset.slice(1)} theme applied`);
    });
    $('#sideSearch')?.addEventListener('input', function () {
      sideQuery = this.value || '';
      renderUnscheduledLane();
      renderSidePanel();
    });
    $('#sideStageFilter')?.addEventListener('change', function () {
      sideStageFilter = this.value || '';
      try {
        localStorage.setItem(LS_FILTER_STAGE, sideStageFilter);
      } catch {
        /* ignore */
      }
      renderUnscheduledLane();
      renderSidePanel();
    });
    $('#sideSourceFilter')?.addEventListener('change', function () {
      sideSourceFilter = this.value || '';
      try {
        localStorage.setItem(LS_FILTER_SOURCE, sideSourceFilter);
      } catch {
        /* ignore */
      }
      renderUnscheduledLane();
      renderSidePanel();
    });
    $('#sideGroupBy')?.addEventListener('change', function () {
      sideGroupBy = this.value || '';
      try {
        localStorage.setItem(LS_FILTER_GROUP, sideGroupBy);
      } catch {
        /* ignore */
      }
      renderSidePanel();
    });
    const sideListEl = $('#sideList');
    if (sideListEl && sideListEl.dataset.fsMultiselect !== '1') {
      sideListEl.dataset.fsMultiselect = '1';
      sideListEl.addEventListener(
        'click',
        function (e) {
          const row = e.target.closest('.side-item[data-id]');
          if (!row) return;
          if (e.target.closest('.side-item__act, .side-status, .side-editable, a.side-link')) return;
          if (!(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          e.stopPropagation();
          const id = row.getAttribute('data-id');
          if (sideSelectionIds.has(id)) sideSelectionIds.delete(id);
          else sideSelectionIds.add(id);
          sideListFocusId = id;
          updateBulkBar();
        },
        true,
      );
    }
    $('#sideBulkClear')?.addEventListener('click', function () {
      sideSelectionIds.clear();
      updateBulkBar();
    });
    $('#sideBulkDelete')?.addEventListener('click', function () {
      const n = sideSelectionIds.size;
      if (!n || !window.confirm('Delete ' + n + ' items?')) return;
      recordUndo('bulk delete');
      const drop = new Set(sideSelectionIds);
      items = items.filter(function (x) {
        return !drop.has(x.id);
      });
      FS.saveItems(items);
      sideSelectionIds.clear();
      sideListFocusId = null;
      refreshAll();
      showUndoToast('Items deleted');
    });
    $('#sideBulkMove')?.addEventListener('click', function () {
      if (!sideSelectionIds.size) return;
      const v = window.prompt('Move to date (YYYY-MM-DD)', defaultTodayYmd());
      if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return;
      recordUndo('bulk move');
      sideSelectionIds.forEach(function (id) {
        const it = items.find(function (x) {
          return x.id === id;
        });
        if (!it) return;
        it.plannedDate = v;
        it.date = v;
        if (!['Committed', 'Scheduled', 'Bought', 'Delayed'].includes(it.stage || it.status)) {
          it.stage = 'Scheduled';
          it.status = 'Scheduled';
        }
      });
      FS.saveItems(items);
      sideSelectionIds.clear();
      updateBulkBar();
      refreshAll();
      showUndoToast('Dates updated');
    });
    $('#sideBulkStatus')?.addEventListener('change', function () {
      const st = this.value;
      if (!st || !sideSelectionIds.size) return;
      recordUndo('bulk status');
      sideSelectionIds.forEach(function (id) {
        const it = items.find(function (x) {
          return x.id === id;
        });
        if (!it) return;
        it.stage = st;
        it.status = st;
        if (!['Committed', 'Scheduled', 'Bought', 'Delayed'].includes(st)) {
          it.plannedDate = '';
          it.date = '';
        }
      });
      FS.saveItems(items);
      this.value = '';
      sideSelectionIds.clear();
      updateBulkBar();
      refreshAll();
      showUndoToast('Status updated');
    });
    $('#recentBoughtPrev')?.addEventListener('click', function () {
      shiftRecentBoughtMonth(-1);
    });
    $('#recentBoughtNext')?.addEventListener('click', function () {
      shiftRecentBoughtMonth(1);
    });
    $('#btnExportCsv')?.addEventListener('click', exportCsv);
    $('#csvImportInput')?.addEventListener('change', function () {
      const file = this.files && this.files[0];
      if (file) importCsv(file);
      this.value = '';
    });
    $('#statementImportInput')?.addEventListener('change', function () {
      const file = this.files && this.files[0];
      if (file) importStatementFile(file);
      this.value = '';
    });
    $('#btnStatementCancel')?.addEventListener('click', function () {
      pendingStatementRows = [];
      closeModal('#modalStatementReview');
    });
    $('#btnStatementImport')?.addEventListener('click', saveSelectedStatementRows);

    $('#btnResetEntries')?.addEventListener('click', function () {
      if (!window.confirm('Reset all entries? This will remove all saved items.')) return;
      recordUndo('reset');
      items = [];
      FS.saveItems(items);
      selectedDate = null;
      const calRoot = $('#calendarRoot');
      if (calRoot) FS.setCalendarDaySelection(calRoot, null);
      updateBarDateChip();
      refreshAll();
      showToast('Entries reset');
    });
    $('#btnUndoReset')?.addEventListener('click', function () {
      if (restoreUndo()) showToast('Undo restored');
    });
  }

  function syncToggleUi() {
    var bar = $('#chartToggleBar');
    var pie = $('#chartTogglePie');
    var source = $('#chartBoughtSource');
    var m = FS.getChartMode();
    if (bar) bar.classList.toggle('is-active', m === 'bar');
    if (pie) pie.classList.toggle('is-active', m === 'pie');
    if (source) source.value = FS.getChartBoughtSource?.() || 'all';
  }

  function normalizeCustomProvider(provider, index) {
    return {
      id: String(provider?.id || `custom_${Date.now()}_${index || 0}`).trim(),
      label: String(provider?.label || '').trim(),
      endpoint: String(provider?.endpoint || '').trim(),
      model: String(provider?.model || '').trim(),
      apiKey: String(provider?.apiKey || '').trim(),
      enabled: provider?.enabled !== false,
    };
  }

  function loadCustomProviders() {
    try {
      const rows = JSON.parse(localStorage.getItem('flowspend_custom_ai_providers') || '[]');
      return Array.isArray(rows) ? rows.map(normalizeCustomProvider) : [];
    } catch {
      return [];
    }
  }

  function providerPreset(provider) {
    const endpoint = String(provider.endpoint || '').toLowerCase();
    if (endpoint.includes('groq.com')) return 'Groq';
    if (endpoint.includes('openrouter.ai')) return 'OpenRouter';
    return provider.label || 'Custom provider';
  }

  function providerKind(provider) {
    const endpoint = String(provider.endpoint || '').toLowerCase();
    const label = String(provider.label || '').toLowerCase();
    if (label === 'groq') return 'groq';
    if (label === 'openrouter') return 'openrouter';
    if (endpoint.includes('groq.com')) return 'groq';
    if (endpoint.includes('openrouter.ai')) return 'openrouter';
    return 'custom';
  }

  function repairKnownProvider(provider) {
    const kind = providerKind(provider);
    const preset = AI_PROVIDER_PRESETS[kind];
    if (!preset) return provider;
    const endpoint = String(provider.endpoint || '').toLowerCase();
    const endpointLooksMixed =
      (kind === 'groq' && endpoint.includes('openrouter.ai')) ||
      (kind === 'openrouter' && endpoint.includes('groq.com'));
    return Object.assign({}, provider, {
      label: provider.label || preset.label,
      endpoint: !provider.endpoint || endpointLooksMixed ? preset.endpoint : provider.endpoint,
      model: !provider.model || endpointLooksMixed ? preset.model : provider.model,
    });
  }

  function readyProviderLabelsFromForm() {
    const labels = [];
    if (($('#adminGeminiApiKey')?.value || '').trim() && ($('#adminGeminiModel')?.value || '').trim()) {
      labels.push('Gemini');
    }
    if (($('#adminOpenAiApiKey')?.value || '').trim() && ($('#adminOpenAiModel')?.value || '').trim()) {
      labels.push('OpenAI');
    }
    readCustomProviders().forEach(function (provider) {
      if (provider.enabled && provider.label && provider.endpoint && provider.model && provider.apiKey) {
        labels.push(provider.label);
      }
    });
    return labels;
  }

  function updateAdminProviderStatus() {
    const status = $('#adminProviderStatus');
    if (!status) return;
    const labels = readyProviderLabelsFromForm();
    status.textContent = labels.length
      ? `Ready to compare ${labels.length} provider${labels.length === 1 ? '' : 's'}: ${labels.join(', ')}.`
      : 'No AI providers are ready yet. Add at least one API key and model.';
  }

  function renderCustomProviders(providers) {
    const box = $('#customAiProviders');
    if (!box) return;
    const rows = providers && providers.length ? providers : [];
    if (!rows.length) {
      box.innerHTML =
        '<p class="admin-provider-empty">No extra providers yet. Gemini will work on its own; add Groq/OpenRouter here when you have keys.</p>';
      return;
    }
    box.innerHTML = rows
      .map(function (provider, index) {
        const p = repairKnownProvider(normalizeCustomProvider(provider, index));
        const kind = providerKind(p);
        return (
          '<div class="admin-provider-row" data-provider-id="' +
          escapeAttr(p.id) +
          '">' +
          '<div class="admin-provider-row__top"><label class="admin-provider-toggle"><input type="checkbox" class="admin-provider-enabled" ' +
          (p.enabled ? 'checked' : '') +
          ' /> Enabled</label><button type="button" class="btn btn--danger btn--sm admin-provider-remove">Remove</button></div>' +
          '<label class="field"><span>Provider</span><select class="admin-provider-kind"><option value="groq"' +
          (kind === 'groq' ? ' selected' : '') +
          '>Groq</option><option value="openrouter"' +
          (kind === 'openrouter' ? ' selected' : '') +
          '>OpenRouter</option><option value="custom"' +
          (kind === 'custom' ? ' selected' : '') +
          '>Custom</option></select></label>' +
          '<label class="field admin-provider-name-field"><span>Name</span><input type="text" class="admin-provider-label" value="' +
          escapeAttr(p.label || providerPreset(p)) +
          '" placeholder="My AI provider" /></label>' +
          '<label class="field"><span>Model</span><input type="text" class="admin-provider-model" value="' +
          escapeAttr(p.model) +
          '" placeholder="llama-3.1-8b-instant" /></label>' +
          '<label class="field"><span>API key</span><input type="password" class="admin-provider-key" value="' +
          escapeAttr(p.apiKey) +
          '" /></label>' +
          '<details class="admin-provider-advanced"><summary>Advanced endpoint</summary><label class="field"><span>Chat completions endpoint</span><input type="text" class="admin-provider-endpoint" value="' +
          escapeAttr(p.endpoint) +
          '" placeholder="https://api.groq.com/openai/v1/chat/completions" /></label>' +
          '</details>' +
          '</div>'
        );
      })
      .join('');
    box.querySelectorAll('.admin-provider-remove').forEach(function (btn) {
      btn.addEventListener('click', function () {
        btn.closest('.admin-provider-row')?.remove();
        if (!box.querySelector('.admin-provider-row')) renderCustomProviders([]);
        updateAdminProviderStatus();
      });
    });
    box.querySelectorAll('.admin-provider-kind').forEach(function (select) {
      select.addEventListener('change', function () {
        const row = select.closest('.admin-provider-row');
        const preset = AI_PROVIDER_PRESETS[select.value];
        if (row && preset) {
          row.querySelector('.admin-provider-label').value = preset.label;
          row.querySelector('.admin-provider-endpoint').value = preset.endpoint;
          row.querySelector('.admin-provider-model').value = preset.model;
        }
        updateAdminProviderStatus();
      });
    });
    box.querySelectorAll('input, select').forEach(function (input) {
      input.addEventListener('input', updateAdminProviderStatus);
      input.addEventListener('change', updateAdminProviderStatus);
    });
    updateAdminProviderStatus();
  }

  function readCustomProviders() {
    return Array.from(document.querySelectorAll('#customAiProviders .admin-provider-row'))
      .map(function (row, index) {
        const label = row.querySelector('.admin-provider-label')?.value || '';
        const endpoint = row.querySelector('.admin-provider-endpoint')?.value || '';
        const model = row.querySelector('.admin-provider-model')?.value || '';
        const apiKey = row.querySelector('.admin-provider-key')?.value || '';
        return repairKnownProvider(
          normalizeCustomProvider(
            {
              id: row.getAttribute('data-provider-id') || `custom_${Date.now()}_${index}`,
              label,
              endpoint,
              model,
              apiKey,
              enabled: row.querySelector('.admin-provider-enabled')?.checked !== false,
            },
            index,
          ),
        );
      })
      .filter((provider) => provider.label || provider.endpoint || provider.model || provider.apiKey);
  }

  function addCustomProviderRow(provider) {
    const existing = readCustomProviders();
    existing.push(
      normalizeCustomProvider(
        provider || {
          label: AI_PROVIDER_PRESETS.groq.label,
          endpoint: AI_PROVIDER_PRESETS.groq.endpoint,
          model: AI_PROVIDER_PRESETS.groq.model,
          apiKey: '',
          enabled: true,
        },
        existing.length,
      ),
    );
    renderCustomProviders(existing);
    updateAdminProviderStatus();
  }

  function csvEscape(value) {
    const s = String(value ?? '');
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function exportCsv() {
    const rows = items
      .map(FS.normalizeItem)
      .filter((i) => i.stage === 'Bought')
      .map((i) => [i.plannedDate || i.date || '', i.name, i.price, FS.getEffectiveCategory(i), i.stage, i.note || '']);
    const csv = [['date', 'name', 'amount', 'category', 'stage', 'note'], ...rows]
      .map((row) => row.map(csvEscape).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'flowspend-bought.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function parseCsvLine(line) {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && quoted && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = !quoted;
      } else if (ch === ',' && !quoted) {
        out.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out;
  }

  function importCsv(file) {
    const reader = new FileReader();
    reader.onload = function () {
      const lines = String(reader.result || '')
        .split(/\r?\n/)
        .filter(Boolean);
      if (lines.length < 2) return;
      const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
      const imported = lines.slice(1).map((line) => {
        const vals = parseCsvLine(line);
        const obj = {};
        headers.forEach((h, i) => (obj[h] = vals[i] || ''));
        return FS.createItem({
          name: obj.name || obj.description || 'Imported item',
          price: obj.amount || obj.price || 0,
          category: obj.category || 'Other',
          suggestedCategory: obj.category || 'Other',
          stage: 'Bought',
          status: 'Bought',
          plannedDate: obj.date || '',
          date: obj.date || '',
          note: obj.note || '',
        });
      });
      recordUndo('csv import');
      items = items.concat(imported);
      FS.saveItems(items);
      refreshAll();
      showUndoToast(`Imported ${imported.length} CSV row${imported.length === 1 ? '' : 's'}`);
    };
    reader.readAsText(file);
  }

  function loadAdminForm() {
    $('#adminBackendEndpoint').value =
      localStorage.getItem('flowspend_backend_endpoint') || 'http://127.0.0.1:8787/api/parse';
    $('#adminGeminiApiKey').value =
      localStorage.getItem('flowspend_gemini_api_key') || localStorage.getItem('flowspend_ai_api_key') || '';
    $('#adminGeminiModel').value =
      localStorage.getItem('flowspend_gemini_model') ||
      localStorage.getItem('flowspend_ai_model') ||
      'gemini-2.5-flash';
    $('#adminOpenAiApiKey').value = localStorage.getItem('flowspend_openai_api_key') || '';
    $('#adminOpenAiModel').value = localStorage.getItem('flowspend_openai_model') || 'gpt-4o-mini';
    renderCustomProviders(loadCustomProviders());
    $('#adminCurrency').value = localStorage.getItem('flowspend_currency') || 'Rs';
    updateAdminProviderStatus();
  }

  function saveAdminForm() {
    localStorage.setItem(
      'flowspend_backend_endpoint',
      $('#adminBackendEndpoint').value || 'http://127.0.0.1:8787/api/parse',
    );
    localStorage.setItem('flowspend_gemini_api_key', $('#adminGeminiApiKey').value || '');
    localStorage.setItem('flowspend_gemini_model', $('#adminGeminiModel').value || 'gemini-2.5-flash');
    localStorage.setItem('flowspend_openai_api_key', $('#adminOpenAiApiKey').value || '');
    localStorage.setItem('flowspend_openai_model', $('#adminOpenAiModel').value || 'gpt-4o-mini');
    localStorage.setItem('flowspend_custom_ai_providers', JSON.stringify(readCustomProviders()));
    localStorage.setItem('flowspend_ai_api_key', $('#adminGeminiApiKey').value || '');
    localStorage.setItem('flowspend_ai_model', $('#adminGeminiModel').value || 'gemini-2.5-flash');
    localStorage.setItem('flowspend_currency', $('#adminCurrency').value || 'Rs');
    currencySymbol = localStorage.getItem('flowspend_currency') || 'Rs';
    const providerCount = readyProviderLabelsFromForm().length;
    closeModal('#modalAdmin');
    refreshAll();
    showToast(`Admin saved: ${providerCount} AI provider${providerCount === 1 ? '' : 's'} ready`);
  }

  function init() {
    if (!FS || !FS.loadItems) return;
    items = FS.loadItems();
    categoryMappings = FS.loadCategoryMappings();
    approvedCategories = FS.loadApprovedCategories();
    try {
      sideStageFilter = localStorage.getItem(LS_FILTER_STAGE) || '';
      sideSourceFilter = localStorage.getItem(LS_FILTER_SOURCE) || '';
      sideGroupBy = localStorage.getItem(LS_FILTER_GROUP) || '';
    } catch {
      sideStageFilter = '';
      sideSourceFilter = '';
      sideGroupBy = '';
    }
    currencySymbol = localStorage.getItem('flowspend_currency') || 'Rs';
    const savedPreset = localStorage.getItem('flowspend_theme_preset') || 'sage';
    const savedAccent = localStorage.getItem('flowspend_accent_color') || THEME_PRESETS[savedPreset] || DEFAULT_ACCENT;
    applyAccentColor(savedAccent);
    syncThemeControls(savedAccent, savedPreset);
    const totalInput = $('#totalInput');
    if (totalInput) {
      totalInput.value = FS.loadTotal();
      totalInput.addEventListener('input', () => {
        FS.saveTotal(totalInput.value);
        updateTopBar();
      });
    }
    const calRoot = $('#calendarRoot');
    if (calRoot) {
      calendarOptions = {
        onSelectDay: function (ymd) {
          selectedDate = ymd;
          FS.setCalendarDaySelection(calRoot, selectedDate);
          updateBarDateChip();
          $('#barInput')?.focus();
        },
        onStructureChange: function () {
          FS.paintCalendarItems(calRoot, items, openEditModal);
          FS.setCalendarDaySelection(calRoot, selectedDate);
          wireCalendarDropTargets(calRoot);
          renderUnscheduledLane();
          FS.updateSpendChart(items);
          updateDashboard();
          renderMonthSummary();
          renderNext7Days();
          renderSidePanel();
        },
      };
      FS.renderCalendarShell(calRoot, calendarOptions);
      FS.paintCalendarItems(calRoot, items, openEditModal);
      FS.setCalendarDaySelection(calRoot, null);
      wireCalendarDropTargets(calRoot);
      renderUnscheduledLane();
    }
    updateBarDateChip();
    FS.initSpendChart(
      $('#spendChart'),
      function () {},
      function (rows) {
        openChartOtherModal(rows);
      },
    );
    $('#chartToggleBar')?.addEventListener('click', function () {
      FS.setChartMode('bar');
      FS.updateSpendChart(items);
      syncToggleUi();
    });
    $('#chartTogglePie')?.addEventListener('click', function () {
      FS.setChartMode('pie');
      FS.updateSpendChart(items);
      syncToggleUi();
    });
    $('#chartBoughtSource')?.addEventListener('change', function () {
      FS.setChartBoughtSource(this.value);
      FS.updateSpendChart(items);
      syncToggleUi();
    });
    wireUi();
    FS.updateSpendChart(items);
    updateTopBar();
    updateDashboard();
    renderMonthSummary();
    renderNext7Days();
    renderSidePanel();
    syncToggleUi();
    syncSideFilterControls();
    updateFirstRunHint();
    document.addEventListener('keydown', function (e) {
      const calRoot = $('#calendarRoot');
      if (e.key === 'Escape') {
        if (e.target && e.target.classList && e.target.classList.contains('side-inline-input')) {
          return;
        }
        if (closeTopModal()) {
          e.preventDefault();
          return;
        }
        if (selectedDate && calRoot) {
          selectedDate = null;
          FS.setCalendarDaySelection(calRoot, null);
          updateBarDateChip();
          e.preventDefault();
        }
        return;
      }
      if (isTypingInField(e.target)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '?') {
        e.preventDefault();
        openModal('#modalShortcuts');
        return;
      }
      if (e.key === '/') {
        e.preventDefault();
        $('#sideSearch')?.focus();
        return;
      }
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault();
        $('#barInput')?.focus();
        return;
      }
      if (e.key === 'b' || e.key === 'B') {
        e.preventDefault();
        FS.setChartMode('bar');
        FS.updateSpendChart(items);
        syncToggleUi();
        return;
      }
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        FS.setChartMode('pie');
        FS.updateSpendChart(items);
        syncToggleUi();
        return;
      }
      if (anyModalOpen()) return;
      if ((e.key === 'd' || e.key === 'D') && !e.shiftKey) {
        const ids =
          sideSelectionIds.size > 0
            ? [...sideSelectionIds]
            : sideListFocusId
              ? [sideListFocusId]
              : [];
        if (ids.length) {
          e.preventDefault();
          applyDelayToItems(ids, 'next-month');
          return;
        }
      }
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const list = $('#sideList');
        if (!list) return;
        const ids = [...list.querySelectorAll('.side-item[data-id]')].map(function (el) {
          return el.getAttribute('data-id');
        });
        if (!ids.length) return;
        let idx = sideListFocusId ? ids.indexOf(sideListFocusId) : -1;
        if (idx < 0) idx = e.key === 'ArrowDown' ? -1 : 0;
        if (e.key === 'ArrowDown') idx = Math.min(ids.length - 1, idx + 1);
        else idx = Math.max(0, idx - 1);
        sideListFocusId = ids[idx];
        list.querySelectorAll('.side-item--kbd').forEach(function (el) {
          el.classList.remove('side-item--kbd');
        });
        const row = list.querySelector('.side-item[data-id="' + sideListFocusId + '"]');
        if (row) {
          row.classList.add('side-item--kbd');
          row.scrollIntoView({ block: 'nearest' });
        }
        e.preventDefault();
        return;
      }
      if (e.key === '[') {
        e.preventDefault();
        navigateCalendarByKeys(-1);
        return;
      }
      if (e.key === ']') {
        e.preventDefault();
        navigateCalendarByKeys(1);
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigateCalendarByKeys(-1);
        return;
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigateCalendarByKeys(1);
        return;
      }
    });
    $('#barInput')?.focus();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
