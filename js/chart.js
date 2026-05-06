/**
 * FlowSpend — Chart.js bar / doughnut, category × status buckets (uses global FS)
 */

/** Cap visible ring slices; remainder rolls into Other. */
const PIE_MAX_SLICES = 6;
const DOMINANT_SHARE = 0.85;

let chartInstance = null;
let currentMode = 'bar';
let boughtSourceMode = 'all';
let canvasEl = null;
let onFilter = null;
let onOtherBreakdown = null;
let centerPluginRegistered = false;

let _bucketCacheKey = '';
let _bucketCache = null;

function hashHue(str) {
  let h = 0;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

/**
 * Stable colour per category name. Committed = lighter, Bought = deeper.
 * Aggregated “Other” uses a fixed hue so it does not steal a category colour.
 */
function pieSliceFill(category, status) {
  const isCommitted = status === 'Committed';
  const key = category || 'Other';
  const hue = !category || key === 'Other' ? 258 : hashHue(key);
  const sat = isCommitted ? 22 : 34;
  const light = isCommitted ? 82 : 62;
  const alpha = isCommitted ? 0.72 : 0.82;
  return `hsla(${hue}, ${sat}%, ${light}%, ${alpha})`;
}

function bucketsCacheKey(items, source, scope) {
  const sc = scope
    ? scope.kind === 'year'
      ? `y:${scope.year}`
      : `m:${scope.year}-${scope.monthIndex}`
    : 'all';
  let h = 0;
  for (const i of items) {
    h = (Math.imul(31, h) + String(i.id || '').length) | 0;
    h = (Math.imul(31, h) + (Number(i.price) || 0)) | 0;
    h = (Math.imul(31, h) + String(i.plannedDate || i.date || '').length) | 0;
  }
  return `${items.length}:${source}:${sc}:${h}`;
}

function getBuckets(FS, items, source) {
  const scope = FS.getChartDataScope ? FS.getChartDataScope() : null;
  const key = bucketsCacheKey(items, source, scope);
  if (key === _bucketCacheKey && _bucketCache) return _bucketCache;
  _bucketCacheKey = key;
  _bucketCache = FS.chartCategoryBuckets(items, source, scope);
  return _bucketCache;
}

function registerCenterLabelPlugin(Chart) {
  if (centerPluginRegistered) return;
  centerPluginRegistered = true;
  Chart.register({
    id: 'flowspendCenterLabel',
    afterDraw(chart) {
      const opts = chart.options.plugins && chart.options.plugins.flowspendCenter;
      if (!opts || !opts.lines || !opts.lines.length) return;
      const { ctx, chartArea } = chart;
      const cx = (chartArea.left + chartArea.right) / 2;
      const cy = (chartArea.top + chartArea.bottom) / 2;
      const lines = opts.lines;
      ctx.save();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const textColor =
        getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#17211d';
      ctx.fillStyle = textColor;
      if (lines.length >= 2) {
        ctx.font = '600 10px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.fillText(lines[0], cx, cy - 8);
        ctx.font = '720 12px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.fillText(lines[1], cx, cy + 8);
      } else {
        ctx.font = '620 11px system-ui, -apple-system, "Segoe UI", sans-serif';
        ctx.fillText(lines[0], cx, cy);
      }
      ctx.restore();
    },
  });
}

function currencyLabelText() {
  const el = typeof document !== 'undefined' ? document.getElementById('currencyLabel') : null;
  const t = el && el.textContent ? el.textContent.trim() : '';
  return t || 'Rs';
}

function formatChartInt(n) {
  return (Number(n) || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function scopeDescription(FS) {
  if (!FS.getChartDataScope) return '';
  const scope = FS.getChartDataScope();
  if (scope.kind === 'year') return `${scope.year} (full year)`;
  const d = new Date(scope.year, scope.monthIndex, 1);
  return d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

function updateChartScopeLabel(FS) {
  const el = typeof document !== 'undefined' ? document.getElementById('chartScopeLabel') : null;
  if (!el || !FS.getChartDataScope) return;
  const scope = FS.getChartDataScope();
  if (scope.kind === 'year') {
    el.textContent = `Scope: ${scope.year} · dates in this year`;
  } else {
    el.textContent = `Scope: ${scopeDescription(FS)} · dates in this month`;
  }
}

function updateChartBarHintVisible(isBar) {
  const el = typeof document !== 'undefined' ? document.getElementById('chartBarLegendHint') : null;
  if (el) el.hidden = !isBar;
}

function refreshChartChrome(FS) {
  if (typeof FS === 'undefined' || !FS) {
    const g = typeof globalThis !== 'undefined' ? globalThis : window;
    FS = g.FS;
  }
  if (!FS) return;
  updateChartScopeLabel(FS);
  updateChartBarHintVisible(currentMode === 'bar');
}

function flattenForPie(buckets) {
  const labels = [];
  const data = [];
  const meta = [];
  for (const [cat, b] of buckets.entries()) {
    if (b.Reserved > 0) {
      labels.push(`${cat} · Committed`);
      data.push(b.Reserved);
      meta.push({ category: cat, status: 'Committed' });
    }
    if (b.Bought > 0) {
      labels.push(`${cat} · Bought`);
      data.push(b.Bought);
      meta.push({ category: cat, status: 'Bought' });
    }
  }
  return { labels, data, meta };
}

function rawRowsFromPie(pie) {
  return pie.labels.map((label, i) => ({
    label,
    data: pie.data[i],
    meta: pie.meta[i],
  }));
}

function mergePieRows(rows) {
  if (!rows.length) return { rows: [], total: 0, didMerge: false };
  const sorted = [...rows].sort((a, b) => b.data - a.data);
  const total = sorted.reduce((s, r) => s + r.data, 0);
  if (total <= 0) return { rows: sorted, total: 0, didMerge: false };
  if (sorted.length <= PIE_MAX_SLICES) return { rows: sorted, total, didMerge: false };
  const head = sorted.slice(0, PIE_MAX_SLICES - 1);
  const tail = sorted.slice(PIE_MAX_SLICES - 1);
  const otherSum = tail.reduce((s, r) => s + r.data, 0);
  const mergedDetail = tail.map((r) => ({
    label: r.label,
    category: r.meta.category,
    status: r.meta.status,
    amount: r.data,
  }));
  const out = [...head];
  if (otherSum > 0) {
    out.push({
      label: 'Other',
      data: otherSum,
      meta: { category: '', status: 'Bought', isOther: true, mergedDetail },
    });
  }
  out.sort((a, b) => b.data - a.data);
  return { rows: out, total, didMerge: true };
}

function updateChartInsight(text) {
  const el = typeof document !== 'undefined' ? document.getElementById('chartInsight') : null;
  if (!el) return;
  const t = String(text || '').trim();
  el.textContent = t;
  el.hidden = !t;
}

function setChartSectionMode(isDoughnut) {
  const section = canvasEl && canvasEl.closest ? canvasEl.closest('.chart-section') : null;
  if (section) section.classList.toggle('chart-section--doughnut', Boolean(isDoughnut));
}

function buildConfig(items, mode, Chart) {
  const FS = typeof globalThis !== 'undefined' ? globalThis.FS : window.FS;
  const buckets = getBuckets(FS, items, boughtSourceMode);
  const categories = [...buckets.keys()].sort();

  if (mode === 'bar') {
    const scope = FS.getChartDataScope?.();
    let insight = '';
    if (scope && scope.kind === 'month') {
      let topCat = '';
      let topAmt = -1;
      buckets.forEach((b, cat) => {
        const bought = Number(b.Bought) || 0;
        if (bought > topAmt) {
          topAmt = bought;
          topCat = cat;
        }
      });
      if (topAmt > 0) {
        const cur = currencyLabelText();
        insight = `You spent most on ${topCat} this month (${cur} ${formatChartInt(topAmt)} bought).`;
      }
    } else if (scope && scope.kind === 'year') {
      let topCat = '';
      let topAmt = -1;
      buckets.forEach((b, cat) => {
        const bought = Number(b.Bought) || 0;
        if (bought > topAmt) {
          topAmt = bought;
          topCat = cat;
        }
      });
      if (topAmt > 0) {
        const cur = currencyLabelText();
        insight = `You spent most on ${topCat} this year (${cur} ${formatChartInt(topAmt)} bought).`;
      }
    }
    updateChartInsight(insight);
    const committedBg = categories.length ? categories.map((c) => pieSliceFill(c, 'Committed')) : ['rgba(0,0,0,0.08)'];
    const boughtBg = categories.length ? categories.map((c) => pieSliceFill(c, 'Bought')) : ['rgba(0,0,0,0.08)'];
    return {
      type: 'bar',
      data: {
        labels: categories.length ? categories : ['No data'],
        datasets: [
          {
            label: 'Committed',
            data: categories.length ? categories.map((c) => buckets.get(c).Reserved) : [0],
            backgroundColor: committedBg,
            metaStatus: 'Committed',
          },
          {
            label: 'Bought',
            data: categories.length ? categories.map((c) => buckets.get(c).Bought) : [0],
            backgroundColor: boughtBg,
            metaStatus: 'Bought',
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
        },
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, beginAtZero: true, grid: { color: 'rgba(0,0,0,0.06)' } },
        },
        onClick: (evt, elements) => {
          if (!elements.length || !onFilter || !categories.length) return;
          const el = elements[0];
          const idx = el.index;
          const ds = el.datasetIndex;
          const cat = categories[idx];
          const status = ds === 0 ? 'Committed' : 'Bought';
          onFilter({ category: cat, status });
        },
      },
    };
  }

  registerCenterLabelPlugin(Chart);

  const raw = flattenForPie(buckets);
  const rawRows = rawRowsFromPie(raw);
  const { rows: pieRows, total: pieTotal, didMerge } = mergePieRows(rawRows);

  if (!pieRows.length || pieTotal <= 0) {
    const scopeHint = scopeDescription(FS);
    updateChartInsight(
      scopeHint ? `No bought or committed totals in this chart for ${scopeHint}.` : 'No bought or committed amounts in this chart view.',
    );
    const cur = currencyLabelText();
    return {
      type: 'doughnut',
      data: {
        labels: ['No data'],
        datasets: [
          {
            data: [1],
            backgroundColor: ['rgba(0,0,0,0.06)'],
            borderColor: 'rgba(255, 253, 247, 0.9)',
            borderWidth: 1.5,
            flowMeta: [],
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '58%',
        plugins: {
          legend: { position: 'bottom', labels: { boxWidth: 10, padding: 10 } },
          flowspendCenter: { lines: ['Total', `${cur} ${formatChartInt(0)}`] },
        },
        onClick: () => {},
      },
    };
  }

  const labels = pieRows.map((r) => r.label);
  const data = pieRows.map((r) => r.data);
  const flowMeta = pieRows.map((r) => r.meta);
  const bg = pieRows.map((r) => pieSliceFill(r.meta.isOther ? 'Other' : r.meta.category, r.meta.status));

  const top = pieRows[0];
  const topShare = top.data / pieTotal;
  if (topShare >= DOMINANT_SHARE && !top.meta.isOther) {
    const cat = top.meta.category || 'One category';
    const pct = Math.round(topShare * 100);
    updateChartInsight(`Mostly ${cat} — about ${pct}% of this chart.`);
  } else if (didMerge) {
    updateChartInsight('Top categories shown; smaller amounts are grouped under Other. Click Other for the list.');
  } else {
    updateChartInsight('');
  }

  const cur = currencyLabelText();
  const centerLines = ['Total', `${cur} ${formatChartInt(pieTotal)}`];

  return {
    type: 'doughnut',
    data: {
      labels,
      datasets: [
        {
          data,
          backgroundColor: bg,
          borderColor: 'rgba(255, 253, 247, 0.9)',
          borderWidth: 1.5,
          flowMeta,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '58%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 10, padding: 10 } },
        flowspendCenter: { lines: centerLines },
      },
      onClick: (evt, elements, chart) => {
        if (!elements.length) return;
        const i = elements[0].index;
        const meta = chart.data.datasets[0].flowMeta || [];
        const m = meta[i];
        if (!m) return;
        if (m.isOther && m.mergedDetail && m.mergedDetail.length) {
          if (onOtherBreakdown) onOtherBreakdown(m.mergedDetail);
          return;
        }
        if (onFilter) onFilter({ category: m.category, status: m.status });
      },
    },
  };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Function} filterCallback — ( { category, status } ) => void
 * @param {Function} [otherBreakdownCallback] — ( mergedDetail[] ) => void
 */
function initSpendChart(canvas, filterCallback, otherBreakdownCallback) {
  canvasEl = canvas;
  onFilter = filterCallback;
  onOtherBreakdown = otherBreakdownCallback || null;
  if (!window.Chart) {
    console.warn('Chart.js not loaded');
  }
}

function setChartMode(mode) {
  currentMode = mode === 'pie' ? 'pie' : 'bar';
  const Chart = window.Chart;
  if (!canvasEl || !Chart) return;
  const items = chartInstance?._flowItems ?? [];
  render(items, Chart);
}

function setChartBoughtSource(source) {
  boughtSourceMode = ['all', 'manual', 'imported'].includes(source) ? source : 'all';
  _bucketCacheKey = '';
  _bucketCache = null;
  const Chart = window.Chart;
  if (!canvasEl || !Chart) return;
  const items = chartInstance?._flowItems ?? [];
  render(items, Chart);
}

function updateSpendChart(items) {
  const Chart = window.Chart;
  if (!canvasEl || !Chart) return;
  _bucketCacheKey = '';
  _bucketCache = null;
  render(items, Chart);
}

function render(items, Chart) {
  if (chartInstance) {
    chartInstance.destroy();
    chartInstance = null;
  }
  const FS = typeof globalThis !== 'undefined' ? globalThis.FS : window.FS;
  const cfg = buildConfig(items, currentMode, Chart);
  setChartSectionMode(cfg.type === 'doughnut');
  chartInstance = new Chart(canvasEl, cfg);
  chartInstance._flowItems = items;
  refreshChartChrome(FS);
}

function getChartMode() {
  return currentMode;
}

function getChartBoughtSource() {
  return boughtSourceMode;
}

(function (g) {
  g.FS = g.FS || {};
  Object.assign(g.FS, {
    initSpendChart,
    setChartMode,
    setChartBoughtSource,
    updateSpendChart,
    getChartMode,
    getChartBoughtSource,
    refreshChartChrome,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
