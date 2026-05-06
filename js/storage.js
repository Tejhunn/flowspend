/**
 * FlowSpend — localStorage persistence (global FS)
 */
(function (g) {
  g.FS = g.FS || {};
  const STORAGE_KEY = 'flowspend_items';
  const TOTAL_KEY = 'flowspend_total';
  const CAT_MAP_KEY = 'flowspend_category_mappings';
  const APPROVED_CATS_KEY = 'flowspend_approved_categories';

  g.FS.loadItems = function loadItems() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  g.FS.saveItems = function saveItems(items) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  };

  g.FS.loadTotal = function loadTotal() {
    const v = localStorage.getItem(TOTAL_KEY);
    if (v == null || v === '') return '';
    return v;
  };

  g.FS.saveTotal = function saveTotal(value) {
    localStorage.setItem(TOTAL_KEY, String(value));
  };

  g.FS.loadCategoryMappings = function loadCategoryMappings() {
    try {
      const raw = localStorage.getItem(CAT_MAP_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  };

  g.FS.saveCategoryMappings = function saveCategoryMappings(map) {
    localStorage.setItem(CAT_MAP_KEY, JSON.stringify(map || {}));
  };

  g.FS.loadApprovedCategories = function loadApprovedCategories() {
    try {
      const raw = localStorage.getItem(APPROVED_CATS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  g.FS.saveApprovedCategories = function saveApprovedCategories(list) {
    localStorage.setItem(APPROVED_CATS_KEY, JSON.stringify(Array.isArray(list) ? list : []));
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
