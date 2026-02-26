/* ================================================================
   SchulungsHub v4 – Utilities
   DOM helpers, formatters, common functions
   ================================================================ */
const Utils = (() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];

  function nowIso() { return new Date().toISOString(); }
  function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function formatDate(v) {
    if (!v) return "-";
    const d = new Date(v);
    if (isNaN(d.getTime())) return v;
    return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(d);
  }

  function formatDateShort(v) {
    if (!v) return "-";
    const d = new Date(v);
    if (isNaN(d.getTime())) return v;
    return new Intl.DateTimeFormat("de-DE", { dateStyle: "short" }).format(d);
  }

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }

  function nextId(arr) {
    if (!arr || !arr.length) return 1;
    return arr.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
  }

  return { $, $$, nowIso, deepClone, esc, formatDate, formatDateShort, debounce, nextId };
})();

/* Global shortcuts for convenience (used everywhere) */
const $ = Utils.$;
const $$ = Utils.$$;
const nowIso = Utils.nowIso;
const deepClone = Utils.deepClone;
const esc = Utils.esc;
const formatDate = Utils.formatDate;
const formatDateShort = Utils.formatDateShort;
const debounce = Utils.debounce;
const nextId = Utils.nextId;
