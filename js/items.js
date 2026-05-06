/**
 * FlowSpend — item model, filters, totals, fast-parse (controlled)
 */

const STATUSES = ['Idea', 'Wishlist', 'Research', 'Committed', 'Scheduled', 'Delayed', 'Bought'];
const ITEM_TYPES = ['One-off', 'Recurring'];
const DEFAULT_CATEGORIES = [
  'Bills',
  'Bank Fees',
  'Food & Health',
  'Transport',
  'Shopping',
  'Big Purchases',
  'Luxury',
  'Other',
];

/** Month names → 0-based month index */
const MONTHS = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sep: 8,
  sept: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
};

const NAME_START_FILLERS = new Set([
  'gonna',
  'buy',
  'buying',
  'want',
  'to',
  'for',
  'of',
  'ofr',
  'need',
  'a',
  'an',
  'the',
  'pack',
  'piece',
  'item',
]);

const MONEY_WORDS = new Set(['rs', 'inr', 'rupee', 'rupees', '₹', '$', 'usd']);

function getStatuses() {
  return [...STATUSES];
}

function getItemTypes() {
  return [...ITEM_TYPES];
}

function getDefaultCategories() {
  return [...DEFAULT_CATEGORIES];
}

function normalizeStage(value) {
  const v = String(value ?? '').trim();
  if (v === 'Reserved') return 'Committed';
  if (STATUSES.includes(v)) return v;
  return 'Idea';
}

function normalizeType(value) {
  const v = String(value ?? '').trim();
  return ITEM_TYPES.includes(v) ? v : 'One-off';
}

function normalizeYmd(value) {
  const v = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

function createItem(partial) {
  const now = Date.now();
  const suggested = String(partial.suggestedCategory ?? partial.category ?? '').trim() || 'general';
  const approved = String(partial.approvedCategory ?? '').trim();
  const cat = approved || suggested;
  const stage = normalizeStage(partial.stage ?? partial.status);
  const type = normalizeType(partial.type);
  const plannedDate = normalizeYmd(partial.plannedDate ?? partial.date);
  const deadline = normalizeYmd(partial.deadline);
  return {
    id: partial.id ?? `fs_${now}_${Math.random().toString(36).slice(2, 9)}`,
    name: String(partial.name ?? '').trim() || 'Untitled',
    price: Number(partial.price) || 0,
    category: cat,
    suggestedCategory: suggested,
    approvedCategory: approved,
    categoryConfidence: Number(partial.categoryConfidence) || 0,
    parseSource: String(partial.parseSource ?? 'rule'),
    stage,
    status: stage,
    type,
    plannedDate,
    deadline,
    date: plannedDate,
    note: String(partial.note ?? '').trim(),
    assumptions: Array.isArray(partial.assumptions) ? partial.assumptions.map(String) : [],
    imported: Boolean(partial.imported),
    importSource: String(partial.importSource ?? '').trim(),
    importFormat: String(partial.importFormat ?? '').trim(),
    importTransactionId: String(partial.importTransactionId ?? '').trim(),
    importedAt: partial.importedAt ?? null,
    recurrence:
      type === 'Recurring'
        ? {
            interval: partial.recurrence?.interval || 'monthly',
            dayOfMonth: Number(partial.recurrence?.dayOfMonth) || 1,
            monthsAhead: Number(partial.recurrence?.monthsAhead) || 6,
          }
        : null,
    link: String(partial.link ?? '').trim(),
    createdAt: partial.createdAt ?? now,
  };
}

function normalizeItem(item) {
  return createItem(Object.assign({}, item, { id: item.id, createdAt: item.createdAt }));
}

/** Sum of prices that reduce available cash. */
function sumReservedBought(items) {
  return items
    .map(normalizeItem)
    .filter((i) => i.stage === 'Committed' || i.stage === 'Scheduled' || (i.stage === 'Bought' && !i.imported))
    .reduce((s, i) => s + (Number(i.price) || 0), 0);
}

/** Items shown on calendar: Reserved/Bought with matching date */
function itemsForCalendarDay(items, ymd) {
  return getCalendarEvents(items)
    .filter((e) => e.date === ymd && e.kind === 'planned')
    .map((e) => e.item);
}

/** Upcoming excludes wishlist unless it has a planned date. */
function itemsSideDefault(items) {
  return items
    .map(normalizeItem)
    .filter((i) => i.stage !== 'Bought')
    .filter((i) => i.stage !== 'Wishlist' || i.plannedDate)
    .sort((a, b) =>
      (a.plannedDate || a.deadline || '9999-99-99').localeCompare(b.plannedDate || b.deadline || '9999-99-99'),
    );
}

/** @deprecated kept for compatibility; list UI always uses itemsSideDefault */
function itemsMatchingChartFilter(items, filter) {
  return itemsSideDefault(items);
}

/** Reserved + Bought for chart grouping */
function itemsForChart(items, boughtSource = 'all') {
  return items.map(normalizeItem).filter((i) => {
    if (i.stage === 'Committed' || i.stage === 'Scheduled') return true;
    if (i.stage !== 'Bought') return false;
    if (boughtSource === 'manual') return !i.imported;
    if (boughtSource === 'imported') return i.imported;
    return true;
  });
}

function chartYmKey(year, monthIndex) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

/** YYYY-MM from item for chart scope, or '' if unknown. */
function itemYmForChartScope(item) {
  const i = normalizeItem(item);
  if (i.stage === 'Bought') {
    const d = i.plannedDate || i.date;
    return d && String(d).length >= 7 ? String(d).slice(0, 7) : '';
  }
  if (i.stage === 'Committed' || i.stage === 'Scheduled') {
    const d = i.plannedDate;
    return d && String(d).length >= 7 ? String(d).slice(0, 7) : '';
  }
  return '';
}

/** @param {{ kind:'month', year:number, monthIndex:number }|{ kind:'year', year:number }|null|undefined} scope */
function itemMatchesChartScope(item, scope) {
  if (scope == null) return true;
  const ym = itemYmForChartScope(item);
  if (!ym) return false;
  if (scope.kind === 'month') return ym === chartYmKey(scope.year, scope.monthIndex);
  if (scope.kind === 'year') return ym.startsWith(String(scope.year) + '-');
  return true;
}

function chartCategoryBuckets(items, boughtSource = 'all', scope = undefined) {
  const rows = itemsForChart(items, boughtSource).filter((i) => itemMatchesChartScope(i, scope));
  const map = new Map();
  for (const i of rows) {
    const cat = getEffectiveCategory(i);
    if (!map.has(cat)) map.set(cat, { Reserved: 0, Bought: 0 });
    const b = map.get(cat);
    if (i.stage === 'Committed' || i.stage === 'Scheduled') b.Reserved += Number(i.price) || 0;
    if (i.stage === 'Bought') b.Bought += Number(i.price) || 0;
  }
  return map;
}

function itemsBoughtInMonth(items, year, monthIndex) {
  const prefix = `${year}-${String(monthIndex + 1).padStart(2, '0')}-`;
  return items
    .map(normalizeItem)
    .filter((i) => i.stage === 'Bought' && i.plannedDate && i.plannedDate.startsWith(prefix))
    .sort((a, b) => b.plannedDate.localeCompare(a.plannedDate));
}

function addMonths(date, count) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + count);
  return d;
}

function getRecurringProjectionEvents(item) {
  const i = normalizeItem(item);
  if (i.type !== 'Recurring' || !i.recurrence) return [];
  const start = i.plannedDate ? new Date(i.plannedDate) : new Date();
  const out = [];
  const monthsAhead = i.recurrence.monthsAhead || 6;
  for (let n = 0; n < monthsAhead; n++) {
    const base = addMonths(start, n);
    const day = Math.min(i.recurrence.dayOfMonth || 1, daysInMonth(base.getFullYear(), base.getMonth()));
    const date = toYmd(new Date(base.getFullYear(), base.getMonth(), day));
    out.push({ date, kind: 'planned', item: i, projected: true });
  }
  return out;
}

function getCalendarEvents(items) {
  const events = [];
  /** Stages that paint a planned date on the calendar (keep aligned with items users treat as dated plans). */
  const plannedOnCalendar = [
    'Idea',
    'Wishlist',
    'Research',
    'Committed',
    'Scheduled',
    'Delayed',
    'Bought',
  ];
  items.map(normalizeItem).forEach((i) => {
    if (i.type === 'Recurring') {
      events.push(...getRecurringProjectionEvents(i));
      return;
    }
    if (i.plannedDate && plannedOnCalendar.includes(i.stage)) {
      events.push({ date: i.plannedDate, kind: 'planned', item: i, projected: false });
    }
    if (i.deadline) {
      events.push({ date: i.deadline, kind: 'deadline', item: i, projected: false });
    }
  });
  return events;
}

function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

function toYmd(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function parseDayToken(tok) {
  const m = String(tok || '')
    .toLowerCase()
    .match(/^(\d{1,2})(?:st|nd|rd|th)?$/);
  if (!m) return null;
  return parseInt(m[1], 10);
}

function parsePriceToken(tok) {
  const t = String(tok).trim();
  if (!t) return null;
  const k = t.match(/^(\d+(?:[.,]\d+)?)([kK])$/);
  if (k) {
    const base = parseFloat(k[1].replace(/,/g, ''));
    if (Number.isNaN(base)) return null;
    return Math.round(base * 1000);
  }
  const plain = t.replace(/,/g, '');
  if (/^\d+(?:\.\d+)?$/.test(plain)) {
    const n = parseFloat(plain);
    if (Number.isNaN(n)) return null;
    return Math.round(n);
  }
  return null;
}

function extractLinksAndRest(line) {
  let rest = line;
  let firstLink = '';
  const patterns = [/https?:\/\/[^\s]+/gi, /www\.[^\s]+/gi, /[\w-]+\.(?:com|net|org|io|co|app|dev)(?:\/[^\s]*)?/gi];
  for (let p = 0; p < patterns.length; p++) {
    rest = rest.replace(patterns[p], function (m) {
      let chunk = m.replace(/[.,;:!?)]+$/, '');
      if (!firstLink) {
        if (/^www\./i.test(chunk)) firstLink = 'https://' + chunk;
        else if (/^https?:\/\//i.test(chunk)) firstLink = chunk;
        else firstLink = 'https://' + chunk;
      }
      return ' ';
    });
  }
  rest = rest.replace(/\s+/g, ' ').trim();
  return { rest, firstLink };
}

/**
 * Pull date from start or end of token list (mutates list).
 * @returns {string} YYYY-MM-DD or ''
 */
function consumeDateFromRemaining(tokens, refYear) {
  if (!tokens.length) return '';

  const lo0 = tokens[0].toLowerCase();
  if (lo0 === 'today') {
    tokens.splice(0, 1);
    return toYmd(new Date());
  }
  if (lo0 === 'tomorrow') {
    tokens.splice(0, 1);
    const t = new Date();
    t.setDate(t.getDate() + 1);
    return toYmd(t);
  }
  if (lo0 === 'next' && tokens[1]?.toLowerCase() === 'month') {
    tokens.splice(0, 2);
    const n = new Date();
    return toYmd(new Date(n.getFullYear(), n.getMonth() + 1, 1));
  }

  const n1 = tokens.length;
  if (n1 >= 2 && tokens[n1 - 2].toLowerCase() === 'next' && tokens[n1 - 1].toLowerCase() === 'month') {
    tokens.splice(n1 - 2, 2);
    const n = new Date();
    return toYmd(new Date(n.getFullYear(), n.getMonth() + 1, 1));
  }

  const n2 = tokens.length;
  if (n2 >= 1) {
    const last = tokens[n2 - 1].toLowerCase();
    if (last === 'today') {
      tokens.pop();
      return toYmd(new Date());
    }
    if (last === 'tomorrow') {
      tokens.pop();
      const t = new Date();
      t.setDate(t.getDate() + 1);
      return toYmd(t);
    }
  }

  if (tokens.length >= 2) {
    const a = tokens[tokens.length - 2];
    const b = tokens[tokens.length - 1];
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    const d1 = parseDayToken(a);
    const d2 = parseDayToken(b);
    const m1 = MONTHS[la] !== undefined ? MONTHS[la] : null;
    const m2 = MONTHS[lb] !== undefined ? MONTHS[lb] : null;

    if (d1 !== null && m2 !== null) {
      const dim = daysInMonth(refYear, m2);
      if (d1 >= 1 && d1 <= dim) {
        tokens.splice(tokens.length - 2, 2);
        return toYmd(new Date(refYear, m2, d1));
      }
    }
    if (m1 !== null && d2 !== null) {
      const dim = daysInMonth(refYear, m1);
      if (d2 >= 1 && d2 <= dim) {
        tokens.splice(tokens.length - 2, 2);
        return toYmd(new Date(refYear, m1, d2));
      }
    }
  }

  // Handles natural phrases:
  // "on the 30th of april", "30th of april", "on april 30th"
  const lower = tokens.map((t) => String(t).toLowerCase());
  for (let i = 0; i < tokens.length; i++) {
    const mA = MONTHS[lower[i]];
    if (mA === undefined) continue;

    // month first: "... april 30th"
    let j = i + 1;
    if (lower[j] === 'the') j += 1;
    const dayAfter = parseDayToken(tokens[j]);
    if (dayAfter !== null) {
      const dim = daysInMonth(refYear, mA);
      if (dayAfter >= 1 && dayAfter <= dim) {
        let start = i;
        while (start > 0 && (lower[start - 1] === 'on' || lower[start - 1] === 'the')) start -= 1;
        tokens.splice(start, j - start + 1);
        return toYmd(new Date(refYear, mA, dayAfter));
      }
    }

    // day first: "... 30th of april"
    let k = i - 1;
    if (k >= 0 && lower[k] === 'of') k -= 1;
    const dayBefore = parseDayToken(tokens[k]);
    if (dayBefore !== null) {
      const dim = daysInMonth(refYear, mA);
      if (dayBefore >= 1 && dayBefore <= dim) {
        let start = k;
        while (start > 0 && (lower[start - 1] === 'on' || lower[start - 1] === 'the')) start -= 1;
        tokens.splice(start, i - start + 1);
        return toYmd(new Date(refYear, mA, dayBefore));
      }
    }
  }

  return '';
}

function stripNameFillers(tokens) {
  const out = [...tokens];
  let changed = true;
  while (changed && out.length) {
    changed = false;
    if (out.length >= 2) {
      const a = out[0].toLowerCase();
      const b = out[1].toLowerCase();
      if (a === 'gonna' && b === 'buy') {
        out.splice(0, 2);
        changed = true;
        continue;
      }
      if (a === 'want' && b === 'to' && out[2] && out[2].toLowerCase() === 'buy') {
        out.splice(0, 3);
        changed = true;
        continue;
      }
    }
    const w = out[0].toLowerCase();
    if (NAME_START_FILLERS.has(w)) {
      out.shift();
      changed = true;
    }
  }
  return out;
}

function stripLeadingJoiners(tokens) {
  const out = [...tokens];
  while (out.length && ['of', 'for', 'to'].includes(String(out[0]).toLowerCase())) {
    out.shift();
  }
  return out;
}

function stripMoneyWords(tokens) {
  return tokens.filter((t) => !MONEY_WORDS.has(String(t || '').toLowerCase()));
}

function titleishName(s) {
  const t = s.trim();
  if (!t) return '';
  return t
    .split(/\s+/)
    .map((w) => {
      if (!w) return w;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(' ');
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function cleanPhrase(s) {
  return String(s || '')
    .replace(/[“”]/g, '"')
    .replace(/[’]/g, "'")
    .replace(/[,.;:!?()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function removePhrase(text, phrase) {
  if (!phrase) return text;
  return text.replace(new RegExp('\\b' + escapeRe(phrase) + '\\b', 'i'), ' ');
}

function parseMoneyAmount(raw) {
  const s = String(raw || '')
    .replace(/,/g, '')
    .trim();
  const m = s.match(/^(\d+(?:\.\d+)?)(k)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * (m[2] ? 1000 : 1));
}

function extractPrice(text) {
  const patterns = [
    /\b(?:rs|rs\.|rupees?|mur|mru|₹)\s*([0-9][\d,]*(?:\.\d+)?k?)\b/i,
    /\b([0-9][\d,]*(?:\.\d+)?k?)\s*(?:rs|rs\.|rupees?|mur|mru|₹)\b/i,
    /\b(?:costs?|cost|priced?|price|about|around|roughly|approx(?:imately)?|maybe|for|is)\s+(?:rs|rs\.|rupees?|mur|mru|₹)?\s*([0-9][\d,]*(?:\.\d+)?k?)\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    const amount = m ? parseMoneyAmount(m[1]) : null;
    if (amount !== null) {
      return { amount, text: text.replace(m[0], ' ') };
    }
  }
  const nums = [...text.matchAll(/\b([0-9][\d,]*(?:\.\d+)?k?)\b/gi)]
    .map((m) => ({ raw: m[0], amount: parseMoneyAmount(m[1]), index: m.index }))
    .filter((m) => m.amount !== null && m.amount >= 20);
  if (!nums.length) return { amount: null, text };
  const picked = nums[nums.length - 1];
  return {
    amount: picked.amount,
    text: text.slice(0, picked.index) + ' ' + text.slice(picked.index + picked.raw.length),
  };
}

function nextWeekdayDate(dayName) {
  const map = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const target = map[String(dayName || '').toLowerCase()];
  if (target === undefined) return '';
  const d = new Date();
  const diff = (target - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + diff);
  return toYmd(d);
}

function parseNaturalDate(text, refYear) {
  const lower = text.toLowerCase();
  const today = new Date();
  const exacts = [
    { re: /\btoday\b/i, date: toYmd(today), kind: 'planned' },
    {
      re: /\btomorrow\b/i,
      date: (() => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        return toYmd(d);
      })(),
      kind: 'planned',
    },
    {
      re: /\byesterday\b/i,
      date: (() => {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        return toYmd(d);
      })(),
      kind: 'planned',
    },
    {
      re: /\bnext month\b/i,
      date: (() => {
        const d = new Date();
        return toYmd(new Date(d.getFullYear(), d.getMonth() + 1, 1));
      })(),
      kind: 'planned',
    },
  ];
  for (const x of exacts) {
    const m = text.match(x.re);
    if (m) return { date: x.date, kind: x.kind, text: text.replace(m[0], ' ') };
  }

  const weekday = lower.match(/\b(by|on|this|next)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  if (weekday) {
    return {
      date: nextWeekdayDate(weekday[2]),
      kind: weekday[1]?.toLowerCase() === 'by' ? 'deadline' : 'planned',
      text: text.replace(weekday[0], ' '),
    };
  }

  const tokens = cleanPhrase(text).split(/\s+/).filter(Boolean);
  const before = tokens.join(' ');
  const date = consumeDateFromRemaining(tokens, refYear);
  if (date) {
    const after = tokens.join(' ');
    const kind = /\bby\b/i.test(before.replace(after, '')) ? 'deadline' : 'planned';
    return { date, kind, text: after };
  }
  return { date: '', kind: 'planned', text };
}

function inferCategory(text) {
  const s = String(text || '').toLowerCase();
  if (/rent|internet|wifi|bill|electric|water|insurance|subscription|fee/.test(s)) return 'Bills';
  if (/petrol|fuel|gas|taxi|bus|transport/.test(s)) return 'Transport';
  if (/grocer|food|dinner|lunch|breakfast|restaurant|chicken|supermarket/.test(s)) return 'Food & Health';
  if (/mac|laptop|computer|phone|ps5|playstation|furniture|tv/.test(s)) return 'Big Purchases';
  if (/cig|smoke|gift|clothes|shoe|shopping/.test(s)) return 'Shopping';
  return 'general';
}

function inferStage(line, hasPlannedDate, hasDeadline) {
  const s = line.toLowerCase();
  if (/\b(bought|paid|purchased|already got|ordered)\b/.test(s)) return 'Bought';
  if (/\b(research|looking into|thinking about|maybe|not sure|unsure|someday)\b/.test(s)) return 'Research';
  if (/\b(reserve|reserved|set aside|put aside|commit|committed)\b/.test(s))
    return hasPlannedDate ? 'Scheduled' : 'Committed';
  if (hasPlannedDate) return 'Scheduled';
  if (hasDeadline) return 'Committed';
  return 'Idea';
}

function buildName(text) {
  let s = cleanPhrase(text)
    .replace(
      /\b(?:im|i'm|i|ill|i'll|gonna|going to|want to|need to|need|wanna|buy|buying|get|getting|pay|paid|bought|purchase|purchased|reserve|reserved|set aside|put aside|thinking|think|looking|look|into|for|on|by|about|around|roughly|approx|approximately|maybe|costs?|cost|price|priced|is|it|its|it's|my|a|an|the|pack)\b/gi,
      ' ',
    )
    .replace(/\b(?:rs|rs\.|rupees?|mur|mru|₹|every|each|month|monthly|not sure|unsure|someday|yet)\b/gi, ' ')
    .replace(/\b\d{1,2}(?:st|nd|rd|th)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = stripLeadingJoiners(s.split(/\s+/).filter(Boolean)).join(' ');
  return titleishName(s);
}

function nextDayOfMonth(day) {
  const now = new Date();
  const safeDay = Math.max(1, Math.min(31, Number(day) || 1));
  let target = new Date(
    now.getFullYear(),
    now.getMonth(),
    Math.min(safeDay, daysInMonth(now.getFullYear(), now.getMonth())),
  );
  if (target < new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
    const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    target = new Date(
      nextMonth.getFullYear(),
      nextMonth.getMonth(),
      Math.min(safeDay, daysInMonth(nextMonth.getFullYear(), nextMonth.getMonth())),
    );
  }
  return toYmd(target);
}

/**
 * Controlled parse for bottom bar input.
 * @param {string} line
 * @param {{ refYear?: number, attachDate?: string | null }} [opts]
 * @returns {{ name: string, price: number | null, category: string, date: string, link: string, status: string }}
 */
function parseFastInput(line, opts = {}) {
  const refYear = typeof opts.refYear === 'number' ? opts.refYear : new Date().getFullYear();
  const attachDate = opts.attachDate && /^\d{4}-\d{2}-\d{2}$/.test(opts.attachDate) ? opts.attachDate : '';

  const trimmed = String(line || '').trim();
  const empty = {
    name: '',
    price: null,
    category: '',
    date: '',
    plannedDate: '',
    deadline: '',
    note: '',
    assumptions: [],
    type: 'One-off',
    link: '',
    status: 'Idea',
    stage: 'Idea',
  };

  if (!trimmed) {
    return { ...empty, date: attachDate };
  }

  const { rest, firstLink } = extractLinksAndRest(trimmed);
  let working = cleanPhrase(rest);
  if (!working) {
    return { ...empty, link: firstLink, date: attachDate };
  }

  const price = extractPrice(working);
  working = price.text;
  if (price.amount === null) {
    return {
      name: '',
      price: null,
      category: '',
      date: attachDate,
      link: firstLink,
      status: 'Idea',
      stage: 'Idea',
    };
  }

  const dateInfo = parseNaturalDate(working, refYear);
  working = dateInfo.text;
  let plannedDate = dateInfo.kind === 'planned' ? dateInfo.date : '';
  let deadline = dateInfo.kind === 'deadline' ? dateInfo.date : '';
  if (!plannedDate && !deadline && attachDate) plannedDate = attachDate;

  const recurring = /\b(every month|monthly|each month|recurring)\b/i.test(trimmed);
  if (recurring && !plannedDate && deadline) {
    plannedDate = deadline;
    deadline = '';
  }

  const categoryOut = inferCategory(trimmed);
  let stage = inferStage(trimmed, Boolean(plannedDate), Boolean(deadline));
  if (recurring && stage === 'Idea') stage = 'Committed';
  if (stage === 'Bought' && !plannedDate) plannedDate = toYmd(new Date());

  const name = buildName(working) || titleishName(categoryOut === 'general' ? 'Imported item' : categoryOut);
  const recurrenceDay =
    recurring && plannedDate
      ? Number(plannedDate.slice(-2))
      : recurring
        ? (() => {
            const day = trimmed.match(/\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b/i);
            return day ? Number(day[1]) : 1;
          })()
        : 1;
  if (recurring && !plannedDate) plannedDate = nextDayOfMonth(recurrenceDay);

  const assumptions = [];
  if (plannedDate) assumptions.push('Interpreted the date as a planned purchase/payment date.');
  if (deadline) assumptions.push('Interpreted the date as a deadline/reminder.');
  if (recurring) assumptions.push('Interpreted this as a monthly recurring item.');

  return {
    name,
    price: price.amount,
    category: categoryOut,
    date: plannedDate,
    plannedDate,
    deadline,
    note: '',
    assumptions,
    type: recurring ? 'Recurring' : 'One-off',
    recurrence: recurring
      ? {
          interval: 'monthly',
          dayOfMonth: recurrenceDay,
          monthsAhead: 6,
        }
      : null,
    link: firstLink,
    status: stage,
    stage,
  };
}

function getEffectiveCategory(item) {
  const approved = String(item?.approvedCategory || '').trim();
  if (approved) return approved;
  const suggested = String(item?.suggestedCategory || '').trim();
  if (suggested) return suggested;
  const base = String(item?.category || '').trim();
  return base || 'general';
}

function isImportedItem(item) {
  return Boolean(item?.imported || item?.importTransactionId || item?.importSource);
}

(function (g) {
  g.FS = g.FS || {};
  Object.assign(g.FS, {
    getStatuses,
    getItemTypes,
    getDefaultCategories,
    createItem,
    normalizeItem,
    sumReservedBought,
    itemsForCalendarDay,
    itemsSideDefault,
    itemsMatchingChartFilter,
    itemsForChart,
    chartCategoryBuckets,
    itemsBoughtInMonth,
    getCalendarEvents,
    parseFastInput,
    getEffectiveCategory,
    isImportedItem,
  });
})(typeof globalThis !== 'undefined' ? globalThis : window);
