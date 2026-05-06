# FlowSpend — complete technical reference

*For a short executive summary, see [simple flow of tool.md](./simple%20flow%20of%20tool.md).*

This document describes **repository layout**, **runtime architecture**, **data model**, **module APIs** (`FS` global), **key UI flows** (`app.js`), **backend**, **persistence keys**, and **tests**. It is meant for developers maintaining or extending the app.

---

## 1. Repository layout

| Path | Role |
|------|------|
| `index.html` | Single-page shell: top bar, summary strip, calendar pane, side stack (lists + chart), input dock, modals |
| `css/styles.css` | Layout grid, components, modals, calendar, chart section, responsive rules |
| `js/storage.js` | `localStorage` read/write for items, total, category maps |
| `js/items.js` | Item model, normalization, aggregations, natural-language `parseFastInput`, calendar events, chart buckets |
| `js/ai.js` | `parseSmartInput`: AI via backend + `sanitizeAiResult`; falls back to `FS.parseFastInput` |
| `js/statements.js` | MCB PDF/XLSX parsing → reviewable transactions; `parseStatementFile` |
| `js/calendar.js` | Month/year views, `renderCalendarShell`, `paintCalendarItems`, calendar meta + **chart data scope** |
| `js/chart.js` | Chart.js bar + doughnut (“pie” mode), bucket cache, centre label plugin, Other breakdown hook |
| `js/app.js` | Main controller: wiring, modals, refresh loops, keyboard shortcuts, import/undo |
| `backend/server.js` | Static file server + `POST /api/parse` proxy/logger |
| `backend/logs/ai-parse.jsonl` | Created at runtime when parse requests are logged |
| `tests/` | Playwright and parser tests |
| `package.json` | `dev`, `check`, `format`, `test:visual` |

**Script load order** (see `index.html`): `storage` → `items` → `ai` → `statements` → `calendar` → `chart` → `app`.

All feature modules extend a shared global: **`window.FS`** (or `globalThis.FS`).

---

## 2. Global `FS` API (aggregated)

### `js/storage.js` (direct assignments on `g.FS`)

- `loadItems()` / `saveItems(items)`
- `loadTotal()` / `saveTotal(value)`
- `loadCategoryMappings()` / `saveCategoryMappings(map)`
- `loadApprovedCategories()` / `saveApprovedCategories(list)`

**Keys:** `flowspend_items`, `flowspend_total`, `flowspend_category_mappings`, `flowspend_approved_categories`.

### `js/items.js` (`Object.assign`)

- `getStatuses`, `getItemTypes`, `getDefaultCategories`
- `createItem`, `normalizeItem`
- `sumReservedBought` — sums **Committed + Scheduled + Bought where not imported** (drives “planned spend” vs total)
- `itemsForCalendarDay`, `itemsSideDefault`, `itemsMatchingChartFilter` (deprecated alias)
- `itemsForChart`, `chartCategoryBuckets(items, boughtSource, scope?)`
- `itemsBoughtInMonth`
- `getCalendarEvents`
- `parseFastInput`
- `getEffectiveCategory`, `isImportedItem`

### `js/ai.js`

- `FS.parseSmartInput(line, opts)` — async; uses `FS.parseFastInput` as baseline

### `js/statements.js`

- `parseStatementFile(file)`
- `parseMcbPdfLines` (test/low-level)
- `statementTransactionId`

### `js/calendar.js`

- `getCalendarMeta`, `getChartDataScope`
- `setCalendarFocusDate`, `setCalendarMonth`, `shiftCalendarMonth`
- `renderCalendarShell`, `paintCalendarItems`, `setCalendarDaySelection`

### `js/chart.js`

- `initSpendChart(canvas, filterCallback, otherBreakdownCallback?)`
- `setChartMode('bar'|'pie')`, `setChartBoughtSource('all'|'manual'|'imported')`
- `updateSpendChart(items)`
- `getChartMode`, `getChartBoughtSource`
- `refreshChartChrome`

### `js/chart.js` (implicit dependency)

- `chart.js` calls `FS.chartCategoryBuckets`, `FS.getChartDataScope`, and `document` helpers for scope label / bar hint / insight.

---

## 3. Item model (conceptual)

Built in `createItem` / `normalizeItem` in `items.js`. Notable fields:

| Field | Meaning |
|-------|--------|
| `id` | Stable string id |
| `name`, `price` | Display + math |
| `category`, `suggestedCategory`, `approvedCategory` | Category resolution via `getEffectiveCategory` |
| `stage` / `status` | Same normalized stage: Idea, Wishlist, Research, Committed, Scheduled, Delayed, Bought |
| `type` | One-off \| Recurring |
| `plannedDate`, `deadline`, `date` | ISO `YYYY-MM-DD`; `date` tracks planned for bought/committed flows |
| `recurrence` | For recurring: interval, dayOfMonth, monthsAhead |
| `imported`, `importSource`, `importFormat`, `importTransactionId`, `importedAt` | Statement import provenance |
| `note`, `assumptions`, `link`, `parseSource`, `categoryConfidence` | UX / AI metadata |

**Stages** array: `STATUSES` in `items.js`.

---

## 4. Money and availability logic

- **Top bar “Planned spend”** uses `sumReservedBought`: committed + scheduled + **manual** bought only (`!i.imported`). See ```143:148:c:\Users\tejhu\OneDrive\Desktop\Tejhunn\AI Projects\FlowSpend\js\items.js```.
- **Available** ≈ `Total - sumReservedBought` (clamped), implemented in `app.js` → `updateTopBar`.
- **Dashboard cards** (`updateDashboard` in `app.js`) use separate aggregations: e.g. bought-in-visible-month, **total imported bought**, upcoming committed—see README “Data” section.

---

## 5. Calendar

**State** (`calendar.js`): `calendarState.view` ∈ `month | next | year`, plus `year`, `monthIndex`.

**`getCalendarMeta`**: applies “next month” offset when view is `next`.

**`getChartDataScope`**:

- **Year view:** `{ kind: 'year', year }` — chart buckets filter any item whose chart month prefix starts with that year.
- **Otherwise:** `{ kind: 'month', year, monthIndex }` from `getCalendarMeta`.

**Events**: `getCalendarEvents` builds planned + deadline entries and **recurring projections** via `getRecurringProjectionEvents`.

**Rendering**: `renderCalendarShell` replaces inner HTML; `paintCalendarItems` fills `[data-day-items]` slots; clicks on item chips stop propagation to day selection.

---

## 6. Chart (`chart.js`)

- **Data:** `getBuckets` memoizes `chartCategoryBuckets(items, boughtSourceMode, scope)` with a fingerprint key (count, source, scope string, hash of ids/prices/dates).
- **Bar:** stacked committed + bought per category; **per-category colours** via `pieSliceFill(category, status)`; **legend hidden**; hint in DOM (`#chartBarLegendHint`).
- **Pie (UI label):** implemented as **doughnut** with `cutout`, **centre total** via Chart.js plugin `flowspendCenterLabel`.
- **Ring:** merges overflow slices into **Other** with `mergedDetail`; third `initSpendChart` callback opens modal in `app.js`.
- **Chrome:** `refreshChartChrome` updates `#chartScopeLabel`, toggles bar hint vs doughnut class `.chart-section--doughnut`.

---

## 7. Statement import (`statements.js` + `app.js`)

- Browser parses **PDF** (pdf.js) or **XLSX** (SheetJS) into normalized rows.
- Heuristics: category rules, name cleanup (`mcbName`, `juiceName`), ignore rules (`shouldIgnoreTransaction`).
- UI: `modalStatementReview` lists rows; user imports selected → new **Bought** items with import metadata; `refreshAll` / calendar focus updates as implemented in `app.js`.

---

## 8. Backend (`backend/server.js`)

- **Serves** static files from repo parent of `backend/` (`ROOT = path.resolve(__dirname, '..')`).
- **`POST /api/parse`:** reads JSON body, normalizes provider list, calls external chat-completions-style APIs, validates with `validateParsed`, returns structured item fields, **logs** to `backend/logs/ai-parse.jsonl`.
- **CORS:** responses allow `*` for simple browser calls.

Environment variables noted in code include `PORT`, `OPENAI_COMPAT_ENDPOINT`, and provider URLs for Gemini/OpenAI compatibility.

---

## 9. Main controller (`app.js`) — responsibilities (non-exhaustive)

- **Lifecycle:** `init` loads storage, applies theme, builds calendar options, wires chart, `wireUi`, `refreshAll` pieces.
- **Modals:** `openModal` / `closeModal` / `closeTopModal` (ordered stack for Escape).
- **Refresh:** `refreshAll` updates top bar, dashboard, calendar paint, unscheduled lane, chart, side panel.
- **Calendar:** `rebuildCalendarShell` re-renders shell and syncs chart + dashboard; drag-drop assigns `plannedDate`.
- **Keyboard:** document `keydown` — `/` search, `L` quick add, `B`/`P` chart mode, `[` `]` / arrows month, `?` shortcuts, Escape modal/clear day.
- **Undo:** snapshot before destructive ops; `btnUndoReset` restores.
- **Category review:** maps suggested → approved categories; persists mappings.

_File length is large (~1600+ lines); search by function name when navigating._

---

## 10. Styling (`css/styles.css`)

- **App grid:** `.app` is `100dvh` CSS grid: header row, main row (calendar + side), footer input dock.
- **Calendar:** `.calendar-wrap`, `.cal-grid`, `.cal-cell`, `.cal-item`, mini cells for year view.
- **Side stack:** `.side-stack__scroll` scroll container; filters, lists, chart section.
- **Modals:** `.modal`, `.modal__card`, variants `--wide`, `--statement`.

---

## 11. Tests

| Test file | Purpose |
|-----------|---------|
| `tests/ui-smoke.spec.js` | Page loads, chart visible, quick input opens modal, AI-related smoke |
| `tests/parser-natural.spec.js` | Natural language / rule parser cases |
| `tests/statement-pdf.spec.js` | MCB PDF line parsing |

Run: `npm run test:visual` (requires Playwright browsers installed).

---

## 12. npm scripts

```json
"dev": "node backend/server.js",
"check": "node --check ...",
"format": "prettier --write \"**/*.{html,css,js,json,md}\"",
"test:visual": "playwright test"
```

---

## 13. Known design constraints (factual)

- **CDN dependency** for Chart.js, xlsx, pdf.js when opening `index.html` directly (README).
- **Chart scope** excludes committed/scheduled rows **without** `plannedDate` for month/year filters (`itemYmForChartScope`).
- **Bar chart** legend is off by design because per-category colours do not map to two global legend swatches.

---

## 14. Related doc

Shorter product-oriented summary: **`simple flow of tool.md`** in this folder.

Root **`README.md`** is the canonical “how to run and structure” entry point.
