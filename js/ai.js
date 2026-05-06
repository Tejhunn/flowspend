/**
 * FlowSpend — AI parsing adapter with deterministic fallback.
 * Uses optional FlowSpend backend endpoint if configured in localStorage:
 * - flowspend_backend_endpoint (default: http://127.0.0.1:8787/api/parse)
 * - flowspend_gemini_api_key / flowspend_gemini_model
 * - flowspend_openai_api_key / flowspend_openai_model
 * - flowspend_custom_ai_providers
 */
(function (g) {
  g.FS = g.FS || {};

  function normKey(s) {
    return String(s || '')
      .trim()
      .toLowerCase();
  }

  function title(s) {
    const t = String(s || '').trim();
    if (!t) return '';
    return t
      .split(/\s+/)
      .map(function (w) {
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      })
      .join(' ');
  }

  function safeStatus(v, fallback) {
    const allowed = ['Idea', 'Wishlist', 'Research', 'Committed', 'Scheduled', 'Delayed', 'Bought'];
    if (v === 'Reserved') return 'Committed';
    return allowed.includes(v) ? v : fallback;
  }

  function sanitizeAiResult(raw, fallback) {
    if (!raw || typeof raw !== 'object') return fallback;
    const out = Object.assign({}, fallback);
    if (typeof raw.name === 'string') out.name = raw.name.trim() || fallback.name;
    if (raw.price != null && !Number.isNaN(Number(raw.price))) out.price = Number(raw.price);
    if (typeof raw.link === 'string') out.link = raw.link.trim();
    const plannedDate = raw.plannedDate || raw.date;
    if (typeof plannedDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(plannedDate.trim())) {
      out.plannedDate = plannedDate.trim();
      out.date = plannedDate.trim();
    }
    if (typeof raw.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.deadline.trim()))
      out.deadline = raw.deadline.trim();
    if (typeof raw.stage === 'string') out.stage = safeStatus(raw.stage.trim(), fallback.stage);
    else if (typeof raw.status === 'string') out.stage = safeStatus(raw.status.trim(), fallback.stage);
    out.status = out.stage;
    if (typeof raw.type === 'string' && ['One-off', 'Recurring'].includes(raw.type.trim())) out.type = raw.type.trim();
    if (typeof raw.note === 'string') out.note = raw.note.trim();
    if (Array.isArray(raw.assumptions)) out.assumptions = raw.assumptions.map(String).filter(Boolean);
    if (raw.recurrence && typeof raw.recurrence === 'object') {
      out.recurrence = {
        interval: raw.recurrence.interval || 'monthly',
        dayOfMonth: Number(raw.recurrence.dayOfMonth) || 1,
        monthsAhead: Number(raw.recurrence.monthsAhead) || 6,
      };
    }
    if (typeof raw.suggestedCategory === 'string') {
      const c = raw.suggestedCategory.trim();
      out.suggestedCategory = c ? title(c) : fallback.suggestedCategory;
    }
    if (typeof raw.approvedCategory === 'string') out.approvedCategory = raw.approvedCategory.trim();
    if (raw.categoryConfidence != null && !Number.isNaN(Number(raw.categoryConfidence))) {
      out.categoryConfidence = Math.max(0, Math.min(1, Number(raw.categoryConfidence)));
    }
    return out;
  }

  function aiProvidersFromStorage() {
    const legacyKey = localStorage.getItem('flowspend_ai_api_key') || '';
    const legacyModel = localStorage.getItem('flowspend_ai_model') || '';
    const geminiKey = localStorage.getItem('flowspend_gemini_api_key') || legacyKey;
    const geminiModel = localStorage.getItem('flowspend_gemini_model') || legacyModel || 'gemini-2.5-flash';
    const openaiKey = localStorage.getItem('flowspend_openai_api_key') || '';
    const openaiModel = localStorage.getItem('flowspend_openai_model') || 'gpt-4o-mini';
    const customProviders = loadCustomProviders();
    return [
      {
        id: 'gemini',
        label: 'Gemini',
        apiKey: geminiKey,
        model: geminiModel,
      },
      {
        id: 'openai',
        label: 'OpenAI',
        apiKey: openaiKey,
        model: openaiModel,
      },
    ]
      .concat(customProviders)
      .filter((provider) => provider.apiKey && (provider.id !== 'custom' || provider.endpoint));
  }

  function loadCustomProviders() {
    try {
      const rows = JSON.parse(localStorage.getItem('flowspend_custom_ai_providers') || '[]');
      if (!Array.isArray(rows)) return [];
      return rows
        .filter((provider) => provider && provider.enabled !== false)
        .map((provider, index) => ({
          id: String(provider.id || `custom_${index + 1}`).trim() || `custom_${index + 1}`,
          label: String(provider.label || `Custom ${index + 1}`).trim() || `Custom ${index + 1}`,
          endpoint: String(provider.endpoint || '').trim(),
          apiKey: String(provider.apiKey || '').trim(),
          model: String(provider.model || '').trim(),
        }))
        .filter((provider) => provider.endpoint && provider.apiKey && provider.model);
    } catch {
      return [];
    }
  }

  async function parseViaApi(line, fallback, opts) {
    const endpoint = localStorage.getItem('flowspend_backend_endpoint') || 'http://127.0.0.1:8787/api/parse';
    const providers = aiProvidersFromStorage();
    if (!endpoint || !providers.length) return null;

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          input: line,
          refYear: opts.refYear,
          selectedDate: opts.attachDate || '',
          approvedCategories: opts.approvedCategories || [],
          knownMappings: opts.categoryMappings || {},
          providers,
        }),
      });
      if (!res.ok) return null;
      const parsed = await res.json();
      const out = sanitizeAiResult(parsed.finalValidatedOutput || parsed, fallback);
      out.aiCandidates = (parsed.candidates || [])
        .filter((candidate) => candidate.success && candidate.finalValidatedOutput)
        .map((candidate) => ({
          id: candidate.id,
          label: candidate.label,
          model: candidate.model,
          parsed: sanitizeAiResult(candidate.finalValidatedOutput, fallback),
        }));
      return out;
    } catch {
      return null;
    }
  }

  function applyMappingToParsed(parsed, mappings) {
    const out = Object.assign({}, parsed);
    const key = normKey(out.suggestedCategory);
    const mapped = key ? mappings[key] : '';
    if (mapped) out.approvedCategory = mapped;
    return out;
  }

  async function parseSmartInput(line, opts) {
    const fallbackBase = g.FS.parseFastInput(line, opts || {});
    const fallback = {
      name: fallbackBase.name,
      price: fallbackBase.price,
      suggestedCategory: fallbackBase.category || 'general',
      approvedCategory: '',
      stage: fallbackBase.stage || fallbackBase.status || 'Idea',
      status: fallbackBase.stage || fallbackBase.status || 'Idea',
      type: fallbackBase.type || 'One-off',
      plannedDate: fallbackBase.plannedDate || fallbackBase.date || '',
      deadline: fallbackBase.deadline || '',
      date: fallbackBase.plannedDate || fallbackBase.date || '',
      note: fallbackBase.note || '',
      assumptions: fallbackBase.assumptions || [],
      recurrence: null,
      link: fallbackBase.link || '',
      categoryConfidence: 0.45,
      parseSource: 'rule',
    };

    const ai = await parseViaApi(line, fallback, opts || {});
    let out = ai ? Object.assign({}, ai, { parseSource: 'ai' }) : fallback;

    const mappings = (opts && opts.categoryMappings) || {};
    out = applyMappingToParsed(out, mappings);
    out.category = out.approvedCategory || out.suggestedCategory || 'general';
    if (out.aiCandidates) {
      out.aiCandidates = out.aiCandidates.map((candidate) => {
        const parsed = applyMappingToParsed(candidate.parsed, mappings);
        parsed.category = parsed.approvedCategory || parsed.suggestedCategory || 'general';
        parsed.parseSource = 'ai';
        return Object.assign({}, candidate, { parsed });
      });
    }
    return out;
  }

  g.FS.parseSmartInput = parseSmartInput;
})(typeof globalThis !== 'undefined' ? globalThis : window);
