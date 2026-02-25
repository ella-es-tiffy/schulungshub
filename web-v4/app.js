/* ================================================================
   SchulungsHub v4 – Application Logic
   NAS = Single Source of Truth, Direct SQL, Debounced Persist
   ================================================================ */

/* ── 1. Config ── */
const APP_VERSION = "0.1.2";
const SESSION_KEY = "schulungsHub.session";
const PREFS_KEY   = "schulungsHub.prefs";
const DATA_KEY    = "SchulungsHub-Siebdruck-2026";

const DEFAULT_PHASES = [
  { id: "P1", label: "P1 · Grundlagen" },
  { id: "P2", label: "P2 · Fortgeschritten" },
  { id: "P3", label: "P3 · Experte" },
  { id: "P4", label: "P4 · Spezialist" },
  { id: "Mes", label: "MES" },
];

function getPhases() {
  try {
    const raw = S.db?.meta?.phase_order;
    if (raw) {
      const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (Array.isArray(arr) && arr.length) return arr;
    }
  } catch { /* fallback */ }
  return DEFAULT_PHASES;
}


const ALERT_TYPES = {
  TIP:       { cls: "alert-tip",       icon: "◈" },
  NOTE:      { cls: "alert-note",      icon: "⊡" },
  WARNING:   { cls: "alert-warning",   icon: "!" },
  IMPORTANT: { cls: "alert-important", icon: "★" },
};

/* ── 2. State ── */
const S = {
  db: null,
  user: null,
  trainees: [],
  selectedTraineeId: null,
  evalMap: {},
  prefs: { theme: "light", font: "M" },
  loginMode: "password",
  editingSection: null,
  sortMode: false,
  fieldTimers: {},  // debounce timers per goal (to cancel on rating click)
};

/* ── 3. Utilities ── */
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

/* ── 4. Crypto (PBKDF2-SHA256) ── */
function bytesToHex(b) { return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join(""); }
function hexToBytes(h) { const b = new Uint8Array(h.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.slice(i*2, i*2+2), 16); return b; }

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function pbkdf2(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}

async function verifyPassword(password, storedHash) {
  const p = String(storedHash || "").split("$");
  if (p.length !== 4 || p[0] !== "pbkdf2_sha256") return false;
  const iter = parseInt(p[1], 10);
  if (!iter || iter <= 0) return false;
  return timingSafeEqual(await pbkdf2(password, p[2], iter), p[3]);
}

async function createPasswordHash(password) {
  const iter = 120000;
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  return `pbkdf2_sha256$${iter}$${salt}$${await pbkdf2(password, salt, iter)}`;
}

async function sha256Hex(text) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

async function hmacSign(message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(DATA_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(sig));
}

async function hmacVerify(message, signature) {
  const expected = await hmacSign(message);
  return timingSafeEqual(expected, signature);
}

/* ── 5. Data Access (sql.js direkt, NAS = Single Source of Truth) ── */

function reloadState() {
  const meta = {};
  DbEngine.queryAll("SELECT * FROM meta").forEach(r => { meta[r.key] = r.value; });
  meta.schema_version = parseInt(meta.schema_version) || 3;

  const users = DbEngine.queryAll("SELECT * FROM users").map(u => ({
    ...u, active: u.active !== 0, must_change_password: !!u.must_change_password,
  }));

  const machines = DbEngine.queryAll("SELECT * FROM machines ORDER BY position");
  const learning_goals = DbEngine.queryAll("SELECT * FROM learning_goals ORDER BY position");
  const evaluations = DbEngine.queryAll("SELECT * FROM evaluations");

  const allSections = DbEngine.queryAll("SELECT * FROM content_sections ORDER BY position");
  function buildTree(parentId) {
    return allSections
      .filter(s => (s.parent_id || null) === parentId)
      .map(s => {
        const { parent_id, ...rest } = s;
        const kids = buildTree(String(s.id));
        if (kids.length) rest.children = kids;
        return rest;
      });
  }
  const content_sections = buildTree(null);

  const trainee_meta = {};
  DbEngine.queryAll("SELECT * FROM trainee_meta").forEach(r => {
    trainee_meta[r.trainee_id] = { feedback: r.feedback, conclusion: r.conclusion, next_steps: r.next_steps };
  });

  S.db = { meta, users, machines, content_sections, learning_goals, evaluations, trainee_meta };
}

function allUsers() { return (S.db?.users || []).filter(u => u.active !== false); }
function allTrainees() { return allUsers().filter(u => u.role === "trainee").sort((a, b) => a.display_name.localeCompare(b.display_name, "de")); }
function findUser(id) { return allUsers().find(u => u.id === id) || null; }
function userName(id) { const u = findUser(id); return u ? u.display_name : "?"; }
function canVerify() { return S.user && (S.user.role === "admin" || S.user.role === "trainer"); }
function canAdmin() { return S.user && S.user.role === "admin"; }
function canEdit() { return canAdmin(); }
function machineLabel(id) { const m = (S.db?.machines || []).find(m => m.id === id); return m ? m.label : id; }

/* ── 6. Evaluation Queries ── */
function buildEvalMap(traineeId) {
  const map = {};
  (S.db.evaluations || [])
    .filter(e => e.trainee_id === traineeId)
    .sort((a, b) => new Date(a.evaluated_at) - new Date(b.evaluated_at))
    .forEach(e => { map[e.goal_id] = e; });
  return map;
}

function goalScore(gid) { return S.evalMap[gid] ? (S.evalMap[gid].score || 0) : 0; }

function phaseProgress(pid) {
  const g = S.db.learning_goals.filter(g => g.phase === pid);
  return g.length ? g.reduce((s, g) => s + goalScore(g.id), 0) / g.length : 0;
}

function machineProgress(pid, mid) {
  const g = S.db.learning_goals.filter(g => g.phase === pid && g.machine_id === mid);
  return g.length ? g.reduce((s, g) => s + goalScore(g.id), 0) / g.length : 0;
}

function overallProgress() {
  const g = S.db.learning_goals;
  return g.length ? g.reduce((s, g) => s + goalScore(g.id), 0) / g.length : 0;
}

function computeEta() {
  if (!S.selectedTraineeId) return null;
  const evals = (S.db.evaluations || [])
    .filter(e => e.trainee_id === S.selectedTraineeId && e.score > 0)
    .sort((a, b) => new Date(a.evaluated_at) - new Date(b.evaluated_at));
  if (evals.length < 2) return null;
  const overall = overallProgress();
  if (overall <= 0 || overall >= 100) return null;
  const elapsed = Math.max((Date.now() - new Date(evals[0].evaluated_at).getTime()) / 86400000, 1);
  const days = Math.ceil((100 - overall) / (overall / elapsed));
  return new Date(Date.now() + days * 86400000);
}

function recentHistory(limit = 20) {
  if (!S.selectedTraineeId) return [];
  return (S.db.evaluations || [])
    .filter(e => e.trainee_id === S.selectedTraineeId)
    .sort((a, b) => new Date(b.evaluated_at) - new Date(a.evaluated_at))
    .slice(0, limit);
}

function getMachinesForPhase(pid) {
  const ids = new Set();
  S.db.learning_goals.filter(g => g.phase === pid).forEach(g => ids.add(g.machine_id));
  const order = {};
  (S.db.machines || []).forEach(m => { order[m.id] = m.position || 99; });
  return [...ids].sort((a, b) => (order[a] || 99) - (order[b] || 99));
}

/* ── 7. Markdown Rendering ── */
function renderMarkdown(md) {
  if (!md) return "";
  let html = marked.parse(md, { breaks: true });

  Object.entries(ALERT_TYPES).forEach(([type, val]) => {
    const re = new RegExp(`<blockquote>\\s*<p>\\s*\\[!${type}\\]([\\s\\S]*?)</p>\\s*</blockquote>`, "gi");
    html = html.replace(re, (_, content) =>
      `<div class="custom-alert ${val.cls}">
        <div class="alert-header">
          <span class="alert-icon">${val.icon}</span>
          <span class="alert-title">${type}</span>
        </div>
        <div class="alert-content"><p>${content.trim()}</p></div>
      </div>`
    );
  });

  return html;
}

/* ── 8. Auth ── */
async function loginPassword(username, password) {
  const u = allUsers().find(u => u.username.toLowerCase() === username.toLowerCase());
  return u && (await verifyPassword(password, u.password_hash)) ? u : null;
}

function loginRfid(tagHash) {
  const h = tagHash.trim().toLowerCase();
  return allUsers().find(u => (u.rfid_hash || "").toLowerCase() === h) || null;
}

async function setSession(user) {
  S.user = user;
  if (user) {
    const payload = String(user.id);
    const sig = await hmacSign(payload);
    sessionStorage.setItem(SESSION_KEY, payload + "." + sig);
    sessionStorage.setItem(SESSION_KEY + ".time", String(Date.now()));
  } else {
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(SESSION_KEY + ".time");
  }
}

async function restoreSession() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw || !raw.includes(".")) { S.user = null; return; }
  const [payload, sig] = raw.split(".");
  if (!payload || !sig || !(await hmacVerify(payload, sig))) {
    sessionStorage.removeItem(SESSION_KEY);
    S.user = null;
    return;
  }
  const id = parseInt(payload, 10);
  const u = id ? findUser(id) : null;
  if (u) { S.user = u; } else { S.user = null; }
}

function getSessionAge() {
  const t = parseInt(sessionStorage.getItem(SESSION_KEY + ".time"), 10);
  if (!t) return Infinity;
  return Date.now() - t;
}

/* ── Shift-change auto-logout ── */
const SHIFT_TIMES = [6, 14, 22]; // Schichtwechsel um 6:00, 14:00, 22:00
const SHIFT_GRACE = 30; // Minuten vor Schichtwechsel = gehört zur nächsten Schicht

function getSessionStart() {
  return parseInt(sessionStorage.getItem(SESSION_KEY + ".time"), 10) || 0;
}

// Returns the shift boundary this session should be logged out at.
// If login was within 30 min before a shift, that shift is skipped.
function getLogoutShift() {
  const loginTime = getSessionStart();
  if (!loginTime) return null;
  const login = new Date(loginTime);
  const now = new Date();

  // Build list of upcoming shift boundaries from login time
  for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
    for (const sh of SHIFT_TIMES) {
      const boundary = new Date(login);
      boundary.setDate(boundary.getDate() + dayOffset);
      boundary.setHours(sh, 0, 0, 0);
      if (boundary <= login) continue; // in the past relative to login
      if (boundary < now && !(boundary.getHours() === now.getHours() && now.getMinutes() <= 1)) continue; // already passed

      // How long before this boundary did the user log in?
      const minsBeforeBoundary = (boundary - login) / 60000;

      // If login was within grace period, skip this boundary
      if (minsBeforeBoundary <= SHIFT_GRACE) continue;

      return { hour: sh, date: boundary };
    }
  }
  return null;
}

function getShiftCountdown() {
  const target = getLogoutShift();
  if (!target) return { hours: 0, mins: 0, nextShift: SHIFT_TIMES[0] };
  const diff = Math.max(0, target.date - Date.now());
  const hours = Math.floor(diff / 3600000);
  const mins = Math.floor((diff % 3600000) / 60000);
  return { hours, mins, nextShift: target.hour };
}

function updateSessionTimer() {
  const el = $("#session-timer");
  if (!el || !S.user) return;
  const { hours, mins, nextShift } = getShiftCountdown();
  const pad = n => String(n).padStart(2, "0");
  el.textContent = `⏱ ${pad(hours)}:${pad(mins)}`;
  el.title = `Auto-Logout um ${pad(nextShift)}:00`;
  el.classList.toggle("timer-warn", hours === 0 && mins <= 10);
}

function setupShiftLogout() {
  updateSessionTimer();
  setInterval(() => {
    if (!S.user) return;
    updateSessionTimer();

    const target = getLogoutShift();
    if (!target) return;
    const now = new Date();
    // Trigger if we're at the target boundary (within first 2 minutes)
    if (now.getHours() === target.hour && now.getMinutes() <= 1 && target.date <= now) {
      notify("Schichtwechsel – automatisch abgemeldet.", "warning");
      handleLogout();
    }
  }, 30000);
}

/* ── 9. Save Status ── */

function updateSaveStatus(status) {
  const dot = $("#save-dot");
  if (dot) dot.dataset.state = status;

  // Error: show blocking overlay
  if (status === "error") showSaveError();
}

function showSaveError() {
  let overlay = $("#save-error-overlay");
  if (overlay) { overlay.classList.remove("hidden"); return; }
  overlay = document.createElement("div");
  overlay.id = "save-error-overlay";
  overlay.className = "nas-overlay";
  overlay.innerHTML = `
    <div class="nas-overlay-card">
      <div class="nas-overlay-icon" style="color:#ef4444">&#9888;</div>
      <h2>Speichern fehlgeschlagen</h2>
      <p>Die Verbindung zur NAS-Datei wurde unterbrochen.<br>Deine Daten sind noch im Speicher – NICHT den Tab schliessen!</p>
      <button class="btn-primary" id="btn-reconnect">Erneut verbinden</button>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById("btn-reconnect").addEventListener("click", async () => {
    try {
      await DbEngine.connect();
      reloadState();
      overlay.classList.add("hidden");
      refreshAll();
      notify("Verbindung wiederhergestellt!", "success");
    } catch (e) {
      if (e.name !== "AbortError") notify("Verbindung fehlgeschlagen: " + e.message, "danger");
    }
  });
}

/* ── 10. Notifications ── */
function notify(msg, type = "primary") {
  if (window.UIkit) UIkit.notification(msg, { status: type, pos: "bottom-right", timeout: 3000 });
}

/* ── 11. Preferences ── */
function loadPrefs() {
  try { Object.assign(S.prefs, JSON.parse(localStorage.getItem(PREFS_KEY))); } catch { /* */ }
}

function savePrefs() { localStorage.setItem(PREFS_KEY, JSON.stringify(S.prefs)); }

function applyTheme(theme) {
  S.prefs.theme = theme;
  document.documentElement.dataset.theme = theme;
  updateThemeIcon();
  savePrefs();

  // Persist theme preference in user object
  if (S.user) {
    DbEngine.run("UPDATE users SET theme=? WHERE id=?", [theme, S.user.id]);
  }
}

function applyFont(size) {
  S.prefs.font = size;
  document.documentElement.className = `font-${size.toLowerCase()}`;
  $$(".font-switcher button").forEach(b => b.classList.toggle("active", b.dataset.font === size));
  savePrefs();
}

function updateThemeIcon() {
  const icon = $("#theme-icon");
  if (icon) icon.textContent = S.prefs.theme === "light" ? "☀" : "☽";
}

function toggleThemeReveal() {
  const newTheme = S.prefs.theme === "light" ? "dark" : "light";
  const overlay = $("#theme-reveal");

  if (!overlay) { applyTheme(newTheme); return; }

  overlay.style.backgroundColor = newTheme === "dark" ? "#121212" : "#ffffff";
  overlay.classList.add("revealing");

  setTimeout(() => {
    applyTheme(newTheme);
    setTimeout(() => overlay.classList.remove("revealing"), 600);
  }, 400);
}

/* ── 11b. Search ── */

function performSearch(query) {
  const q = `%${query}%`;
  return DbEngine.queryAll(`
    SELECT 'section' AS type, id, title, NULL AS extra FROM content_sections
      WHERE title LIKE ?1 COLLATE NOCASE OR content_md LIKE ?1 COLLATE NOCASE
    UNION ALL
    SELECT 'goal' AS type, id, title, phase || ':' || machine_id AS extra FROM learning_goals
      WHERE title LIKE ?1 COLLATE NOCASE
    UNION ALL
    SELECT 'machine' AS type, id, label AS title, NULL AS extra FROM machines
      WHERE label LIKE ?1 COLLATE NOCASE
    LIMIT 20
  `, [q]);
}

function closeSearchOverlay(clearInput = true) {
  const ov = $("#search-overlay");
  if (ov) ov.remove();
  if (clearInput) {
    const inp = $("#header-search");
    if (inp) inp.value = "";
  }
}

function renderSearchResults(results, query) {
  // Remove previous overlay
  let ov = $("#search-overlay");
  if (ov) ov.remove();

  // Create overlay
  ov = document.createElement("div");
  ov.id = "search-overlay";
  ov.className = "search-overlay";

  if (!results.length) {
    ov.innerHTML = `<div class="search-overlay-card"><h2>Suche: „${esc(query)}"</h2><p style="opacity:0.5;margin-top:12px">Keine Treffer.</p></div>`;
    document.body.appendChild(ov);
    ov.addEventListener("click", (e) => { if (e.target === ov) closeSearchOverlay(); });
    return;
  }

  const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
  const hl = (s) => esc(s).replace(re, `<mark>$1</mark>`);

  const badges = { section: "Inhalt", goal: "Ziel", machine: "Maschine" };
  const cls = { section: "badge-section", goal: "badge-goal", machine: "badge-machine" };

  let html = `<div class="search-overlay-card">`;
  html += `<h2>Suche: „${esc(query)}" <span style="font-weight:400;font-size:0.7em;opacity:0.5">${results.length} Treffer</span></h2>`;
  html += `<div class="search-results-list">`;
  results.forEach(r => {
    const badge = `<span class="search-badge ${cls[r.type]}">${badges[r.type]}</span>`;
    let target = "";
    if (r.type === "section") {
      target = `sec-${r.id}`;
    } else if (r.type === "goal") {
      const [phase] = (r.extra || "").split(":");
      target = `sec-phase-${phase}`;
    } else if (r.type === "machine") {
      const g = S.db.learning_goals.find(g => g.machine_id === r.id);
      target = g ? `sec-phase-${g.phase}` : "";
    }
    const dataExtra = r.type === "goal" ? ` data-machine="${(r.extra || "").split(":")[1]}"` : "";
    html += `<a class="search-result-item" data-target="${target}"${dataExtra}>
      ${badge}<span class="search-result-title">${hl(r.title)}</span>
      <span class="search-result-arrow">&#8250;</span>
    </a>`;
  });
  html += `</div></div>`;

  ov.innerHTML = html;
  document.body.appendChild(ov);

  // Close on backdrop click
  ov.addEventListener("click", (e) => { if (e.target === ov) closeSearchOverlay(); });

  // Click result → navigate + close
  ov.querySelectorAll(".search-result-item").forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      const t = item.dataset.target;
      const mid = item.dataset.machine || null;
      closeSearchOverlay();
      if (t) navigateToResult(t, mid);
    });
  });
}

function navigateToResult(target, machineId) {
  const el = document.getElementById(target);
  if (!el) return;
  el.classList.add("visible");

  // If navigating to a goal, open the machine group first
  if (machineId) {
    const mg = el.querySelector(`.machine-group[data-machine="${machineId}"]`);
    if (mg) mg.open = true;
  }

  // Instant jump + bounce
  window.scrollTo({ top: el.offsetTop - 70, behavior: "instant" });
  el.classList.remove("snap-bounce");
  void el.offsetWidth; // force reflow
  el.classList.add("snap-bounce");
  el.addEventListener("animationend", () => el.classList.remove("snap-bounce"), { once: true });
}

/* ── 12. Sidebar ── */
function renderSidebar() {
  const sb = $("#sidebar");
  if (!sb) return;
  let h = "";

  // Dashboard
  h += `<div class="nav-header">Übersicht</div>`;
  h += `<a class="nav-link" data-target="sec-dashboard">Dashboard</a>`;

  // Content TOC (supports 3 levels)
  h += `<div class="nav-header">Lerninhalte</div>`;
  (S.db.content_sections || []).forEach(sec => {
    h += `<a class="nav-link" data-target="sec-${sec.id}">${esc(sec.title)}</a>`;
    (sec.children || []).forEach(ch => {
      h += `<div class="nav-children">
        <a class="nav-link" data-target="sec-${ch.id}">${esc(ch.title)}</a>`;
      (ch.children || []).forEach(sub => {
        h += `<div class="nav-children nav-level-3">
          <a class="nav-link" data-target="sec-${sub.id}">${esc(sub.title)}</a>
        </div>`;
      });
      h += `</div>`;
    });
  });

  if (canEdit()) {
    h += `<button class="sidebar-btn" id="btn-add-section" type="button">
      <span uk-icon="icon: plus; ratio:0.7"></span> Neue Sektion
    </button>`;
  }

  // Phases
  h += `<div class="nav-header">Bewertung</div>`;
  getPhases().forEach(p => {
    const pct = Math.round(phaseProgress(p.id));
    h += `<a class="nav-link" data-target="sec-phase-${p.id}" data-phase="${p.id}">
      ${esc(p.label)} <span class="mono-label" style="margin-left:auto">${pct}%</span>
    </a>`;
  });
  h += `<a class="nav-link" data-target="sec-history">Letzte Bewertungen</a>`;
  // Benutzerverwaltung is now in the user menu dropdown dialog

  // Data management (admin only, links to section)
  if (canAdmin()) {
    h += `<div class="nav-header">Daten</div>`;
    h += `<a class="nav-link" data-target="sec-daten">Datenverwaltung</a>`;
  }

  sb.innerHTML = h;
  bindSidebarEvents();
}

function bindSidebarEvents() {
  // Scroll-to-section nav links
  $$(".nav-link[data-target]").forEach(el => {
    el.addEventListener("click", e => {
      e.preventDefault();
      const target = document.getElementById(el.dataset.target);
      if (target) {
        target.classList.add("visible"); // ensure visible
        window.scrollTo({ top: target.offsetTop - 70, behavior: "smooth" });
      }
      closeMobileMenu();
    });
  });

  // Admin
  // Add section
  const addSec = $("#btn-add-section");
  if (addSec) addSec.addEventListener("click", handleAddSection);

}

/* ── 13. ScrollSpy (FlyRing pattern) ── */
function setupScrollSpy() {
  window.addEventListener("scroll", () => {
    const sections = $$(".doc-section[id]");
    let current = "";

    sections.forEach(sec => {
      const rect = sec.getBoundingClientRect();
      if (rect.top <= 120) current = sec.id;
    });

    // Sidebar links
    $$(".nav-link[data-target]").forEach(link => {
      const wasActive = link.classList.contains("active");
      const isActive = current && link.dataset.target === current;
      link.classList.toggle("active", isActive);
      // Auto-scroll sidebar to keep active link visible
      if (isActive && !wasActive) {
        const sb = $("#sidebar");
        if (sb) {
          const linkRect = link.getBoundingClientRect();
          const sbRect = sb.getBoundingClientRect();
          if (linkRect.bottom > sbRect.bottom || linkRect.top < sbRect.top) {
            link.scrollIntoView({ block: "center", behavior: "smooth" });
          }
        }
      }
    });

    // Header nav links
    let headerZone = "";
    if (current) {
      if (current === "sec-dashboard" || current === "sec-history") headerZone = "sec-dashboard";
      else if (current.startsWith("sec-phase-")) headerZone = "sec-phase-P1";
      else if (current === "sec-daten") headerZone = "sec-daten";
    }
    $$(".header-nav-link[data-target]").forEach(link => {
      link.classList.toggle("active", headerZone && link.dataset.target === headerZone);
    });
  }, { passive: true });
}

/* ── 14. Fade-in Observer ── */
function setupFadeObserver() {
  const observer = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add("visible");
      }
    });
  }, { threshold: 0, rootMargin: "100px 0px" });

  $$(".doc-section").forEach(el => observer.observe(el));
}

/* ── 14b. Reorder helpers (Admin) ── */

function toggleSortMode() {
  S.sortMode = !S.sortMode;
  refreshAll();
}

function savePhaseOrder(phases) {
  S.db.meta.phase_order = JSON.stringify(phases);
  DbEngine.run("INSERT OR REPLACE INTO meta VALUES ('phase_order', ?)", [S.db.meta.phase_order]);
}

function movePhase(phaseId, dir) {
  const phases = getPhases();
  const idx = phases.findIndex(p => p.id === phaseId);
  if (idx < 0) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= phases.length) return;
  [phases[idx], phases[newIdx]] = [phases[newIdx], phases[idx]];
  savePhaseOrder(phases);
  refreshAll();
}

function moveMachine(machineId, dir) {
  const machines = S.db.machines;
  // Normalize positions if not set
  machines.sort((a, b) => (a.position || 0) - (b.position || 0));
  machines.forEach((m, i) => { m.position = i; });

  const idx = machines.findIndex(m => m.id === machineId);
  if (idx < 0) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= machines.length) return;
  [machines[idx].position, machines[newIdx].position] = [machines[newIdx].position, machines[idx].position];
  machines.sort((a, b) => a.position - b.position);
  DbEngine.runBatch("UPDATE machines SET position=? WHERE id=?", [machines[idx].position, machines[idx].id]);
  DbEngine.run("UPDATE machines SET position=? WHERE id=?", [machines[newIdx].position, machines[newIdx].id]);
  refreshAll();
}

function moveGoal(goalId, dir) {
  const goals = S.db.learning_goals;
  const goal = goals.find(g => g.id === goalId);
  if (!goal) return;
  // Find siblings: same phase + same machine
  const siblings = goals.filter(g => g.phase === goal.phase && g.machine_id === goal.machine_id);
  siblings.sort((a, b) => (a.position || 0) - (b.position || 0));
  // Normalize positions if not set
  siblings.forEach((g, i) => { g.position = i; });

  const idx = siblings.findIndex(g => g.id === goalId);
  if (idx < 0) return;
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= siblings.length) return;
  [siblings[idx].position, siblings[newIdx].position] = [siblings[newIdx].position, siblings[idx].position];
  DbEngine.runBatch("UPDATE learning_goals SET position=? WHERE id=?", [siblings[idx].position, siblings[idx].id]);
  DbEngine.run("UPDATE learning_goals SET position=? WHERE id=?", [siblings[newIdx].position, siblings[newIdx].id]);
  refreshAll();
}

function reassignGoal(goalId, field, value) {
  const goal = S.db.learning_goals.find(g => g.id === goalId);
  if (!goal) return;
  goal[field] = value;
  const siblings = S.db.learning_goals.filter(g =>
    g.phase === goal.phase && g.machine_id === goal.machine_id && g.id !== goalId);
  goal.position = siblings.length ? Math.max(...siblings.map(g => g.position || 0)) + 1 : 0;
  DbEngine.run("UPDATE learning_goals SET phase=?, machine_id=?, position=? WHERE id=?",
    [goal.phase, goal.machine_id, goal.position, goalId]);
  refreshAll();
}

/* ── 15. Render Full Page ── */
function renderPage() {
  const pane = $("#content-pane");
  pane.innerHTML = "";

  // Dashboard section
  pane.innerHTML += buildDashboardHtml();

  // Content sections (3 levels)
  (S.db.content_sections || []).forEach(sec => {
    pane.innerHTML += buildContentSectionHtml(sec);
    (sec.children || []).forEach(ch => {
      pane.innerHTML += buildContentSectionHtml(ch);
      (ch.children || []).forEach(sub => {
        pane.innerHTML += buildContentSectionHtml(sub);
      });
    });
  });

  // Sort mode toggle (admin only)
  if (canAdmin()) {
    pane.innerHTML += `<div class="doc-section visible" style="margin-bottom:20px">
      <button class="btn-secondary btn-sm" id="btn-sort-mode" type="button">
        ${S.sortMode ? "✓ Sortierung beenden" : "⇅ Bewertungen sortieren"}
      </button>
    </div>`;
  }

  // Goal phases
  getPhases().forEach(p => {
    const goals = S.db.learning_goals.filter(g => g.phase === p.id);
    if (goals.length) pane.innerHTML += buildPhaseHtml(p, goals);
  });

  // History
  pane.innerHTML += buildHistoryHtml();

  // Data management section (admin only)
  if (canAdmin()) {
    pane.innerHTML += buildDatenHtml();
  }

  // Bind events
  bindPageEvents();
  setupFadeObserver();

  // Reveal first section immediately
  const first = pane.querySelector(".doc-section");
  if (first) first.classList.add("visible");
}

function canDeleteExams(traineeId) {
  if (!S.user) return false;
  if (canAdmin()) return true;
  if (S.user.role === "trainer") {
    const trainee = S.db.users.find(u => u.id === traineeId);
    return trainee && trainee.created_by === S.user.id;
  }
  return false;
}


function buildDashboardHtml() {
  const overall = overallProgress();
  const eta = computeEta();
  const total = S.db.learning_goals.length;
  const done = S.db.learning_goals.filter(g => goalScore(g.id) >= 100).length;
  const inProg = S.db.learning_goals.filter(g => { const s = goalScore(g.id); return s > 0 && s < 100; }).length;
  const trainee = S.selectedTraineeId ? userName(S.selectedTraineeId) : "-";

  let phaseHtml = "";
  getPhases().forEach(p => {
    const pct = Math.round(phaseProgress(p.id));
    phaseHtml += `<div class="phase-bar-wrap" data-phase="${p.id}">
      <span class="phase-bar-label">${esc(p.label)}</span>
      <div class="phase-bar-track"><div class="phase-bar-fill" style="width:${pct}%"></div></div>
      <span class="phase-bar-pct">${pct}%</span>
    </div>`;
  });

  return `
    <div class="doc-section" id="sec-dashboard">
      <div class="dashboard">
        <div class="dashboard-greeting">
          <h1>Lernfortschritt: ${esc(trainee)}</h1>
          <p class="sub">${canVerify() ? "TRAINERANSICHT" : "EIGENER FORTSCHRITT"}</p>
        </div>
        <div class="stats-row">
          <div class="stat-card">
            <div class="label">Gesamt</div>
            <div class="value" id="kpi-overall">${overall.toFixed(1)}%</div>
          </div>
          <div class="stat-card">
            <div class="label">Abgeschlossen</div>
            <div class="value">${done}</div>
            <div class="detail">von ${total}</div>
          </div>
          <div class="stat-card">
            <div class="label">In Bearbeitung</div>
            <div class="value">${inProg}</div>
          </div>
          <div class="stat-card">
            <div class="label">Gesch. Ende</div>
            <div class="value">${eta ? formatDateShort(eta.toISOString()) : "-"}</div>
          </div>
        </div>
        <div class="phase-progress-section">
          <h3>Fortschritt nach Phase</h3>
          ${phaseHtml}
        </div>
      </div>
    </div>`;
}

function buildContentSectionHtml(sec) {
  const md = sec.content_md || "";
  const html = renderMarkdown(md);
  const editBtn = canEdit()
    ? `<button class="section-edit-btn" data-section-id="${sec.id}" title="Bearbeiten"><span uk-icon="icon: pencil; ratio:0.8"></span></button>`
    : "";
  const printBtn = canVerify()
    ? `<button class="section-print-btn" data-section-id="${sec.id}" title="Drucken"><span uk-icon="icon: print; ratio:0.8"></span></button>`
    : "";

  const titleAttr = canAdmin() ? ` data-section-id="${sec.id}" title="Doppelklick zum Umbenennen"` : "";
  return `<div class="doc-section" id="sec-${sec.id}">
    <h2><span class="section-title"${titleAttr}>${esc(sec.title)}</span> ${editBtn} ${printBtn}</h2>
    <div class="md-content">${html || '<p style="opacity:0.4">Noch kein Inhalt.</p>'}</div>
  </div>`;
}

function buildPhaseHtml(phase, goals) {
  const pct = Math.round(phaseProgress(phase.id));
  const sm = S.sortMode && canAdmin();

  // Phase sort arrows
  const phaseArrows = sm
    ? `<div class="sort-arrows">
        <button class="sort-btn" data-sort="phase-up" data-phase="${phase.id}" title="Nach oben">&#9650;</button>
        <button class="sort-btn" data-sort="phase-down" data-phase="${phase.id}" title="Nach unten">&#9660;</button>
      </div>`
    : "";

  // Group by machine
  const machineMap = {};
  goals.forEach(g => {
    if (!machineMap[g.machine_id]) machineMap[g.machine_id] = [];
    machineMap[g.machine_id].push(g);
  });

  const order = {};
  (S.db.machines || []).forEach(m => { order[m.id] = m.position || 99; });
  const sorted = Object.keys(machineMap).sort((a, b) => (order[a] || 99) - (order[b] || 99));

  let machinesHtml = "";
  sorted.forEach(mid => {
    const mGoals = machineMap[mid].sort((a, b) => (a.position || 0) - (b.position || 0));
    const mpct = Math.round(machineProgress(phase.id, mid));
    let goalsHtml = "";
    mGoals.forEach(g => { goalsHtml += buildGoalCard(g); });

    const machineArrows = sm
      ? `<div class="sort-arrows">
          <button class="sort-btn" data-sort="machine-up" data-machine="${mid}" title="Nach oben">&#9650;</button>
          <button class="sort-btn" data-sort="machine-down" data-machine="${mid}" title="Nach unten">&#9660;</button>
        </div>`
      : "";

    machinesHtml += `
      <details class="machine-group" data-machine="${mid}" data-phase="${phase.id}" ${sm || mGoals.length <= 8 ? "open" : ""}>
        <summary class="machine-summary">
          <span class="machine-chevron">&#9654;</span>
          <span class="machine-name">${esc(machineLabel(mid))}</span>
          <div class="machine-stats">
            ${machineArrows}
            <span class="machine-goal-count">${mGoals.length} ZIELE</span>
            <div class="machine-mini-bar">
              <div class="machine-mini-bar-fill" style="width:${mpct}%"></div>
            </div>
            <span class="machine-mini-pct">${mpct}%</span>
          </div>
        </summary>
        <div class="machine-body">${goalsHtml}</div>
      </details>`;
  });

  return `
    <div class="doc-section" id="sec-phase-${phase.id}">
      <div class="phase-header">
        <h2>${esc(phase.label)}</h2>
        ${phaseArrows}
        <div class="phase-header-bar">
          <div class="phase-header-bar-fill" style="width:${pct}%"></div>
        </div>
        <span class="phase-header-pct">${pct}%</span>
      </div>
      ${machinesHtml}
    </div>`;
}

function buildGoalCard(goal) {
  const ev = S.evalMap[goal.id];
  const score = ev ? (ev.score || 0) : 0;
  const disabled = !canVerify();
  const isNio = ev && ev.score === 0 && ev.evaluated_at;
  const sm = S.sortMode && canAdmin();

  // NIO button + rating segments
  let segs = `<button type="button" class="rating-pill-seg nio ${isNio ? 'filled' : ''}"
    data-val="0" data-goal="${goal.id}" ${disabled ? "disabled" : ""}>NIO</button>`;
  [25, 50, 75, 100].forEach(val => {
    segs += `<button type="button" class="rating-pill-seg ${score >= val ? 'filled' : ''}"
      data-val="${val}" data-goal="${goal.id}" ${disabled ? "disabled" : ""}>${val}</button>`;
  });

  const meta = ev
    ? `${esc(userName(ev.evaluated_by))} · ${formatDate(ev.evaluated_at)}`
    : "";

  // Sort controls (admin sort mode)
  let sortHtml = "";
  if (sm) {
    let phaseOpts = "";
    getPhases().forEach(p => {
      phaseOpts += `<option value="${p.id}" ${goal.phase === p.id ? "selected" : ""}>${esc(p.label)}</option>`;
    });
    let machineOpts = "";
    (S.db.machines || []).forEach(m => {
      machineOpts += `<option value="${m.id}" ${goal.machine_id === m.id ? "selected" : ""}>${esc(m.label)}</option>`;
    });
    sortHtml = `
      <div class="goal-sort-controls">
        <div class="sort-arrows">
          <button class="sort-btn" data-sort="goal-up" data-goal="${goal.id}">&#9650;</button>
          <button class="sort-btn" data-sort="goal-down" data-goal="${goal.id}">&#9660;</button>
        </div>
        <select class="sort-select" data-sort="goal-phase" data-goal="${goal.id}">${phaseOpts}</select>
        <select class="sort-select" data-sort="goal-machine" data-goal="${goal.id}">${machineOpts}</select>
      </div>`;
  }

  // Inline fields for trainers (hidden by default, expand on click)
  let fieldsHtml = "";
  const hasData = ev && (ev.comment || ev.action || ev.error_rate);
  if (canVerify() && !sm) {
    fieldsHtml = `
      <div class="goal-fields" data-goal-detail="${goal.id}">
        <input type="text" class="goal-field-input goal-comment" data-goal="${goal.id}"
          value="${esc(ev?.comment || '')}" placeholder="Kommentar...">
        <input type="text" class="goal-field-input goal-action" data-goal="${goal.id}"
          value="${esc(ev?.action || '')}" placeholder="Massnahme...">
        <input type="number" min="0" max="100" step="0.5"
          class="goal-field-input goal-error-rate" data-goal="${goal.id}"
          value="${ev?.error_rate != null ? ev.error_rate : ''}" placeholder="Fehler %">
      </div>`;
  } else if (!sm && ev && (ev.comment || ev.action)) {
    const parts = [];
    if (ev.comment) parts.push(esc(ev.comment));
    if (ev.action) parts.push(`<span style="opacity:0.6">→ ${esc(ev.action)}</span>`);
    fieldsHtml = `<div class="goal-fields-readonly">${parts.join(" ")}</div>`;
  }

  const expandBtn = !sm && fieldsHtml ? `<button type="button" class="goal-expand-btn" title="Details">&#9654;</button>` : "";

  return `<div class="goal-row${hasData ? ' has-data' : ''}${sm ? ' sort-active' : ''}" data-goal-id="${goal.id}" data-score="${score}">
    <div class="goal-row-main">
      ${sm ? '' : `<div class="rating-pill">${segs}</div>`}
      <span class="goal-row-title">${esc(goal.title)}</span>
      <span class="goal-row-meta">${meta}</span>
      ${expandBtn}
    </div>
    ${sortHtml}
    ${fieldsHtml}
  </div>`;
}

function buildHistoryHtml() {
  const history = recentHistory(30);
  let content = "";

  if (!history.length) {
    content = '<p style="opacity:0.4">Noch keine Bewertungen.</p>';
  } else {
    // Group by date
    const groups = {};
    history.forEach(ev => {
      const day = ev.evaluated_at ? ev.evaluated_at.slice(0, 10) : "unknown";
      if (!groups[day]) groups[day] = [];
      groups[day].push(ev);
    });

    Object.keys(groups).sort().reverse().forEach(day => {
      const dayLabel = formatDateShort(day + "T00:00:00");
      content += `<div class="eval-day-group"><div class="eval-day-label">${dayLabel}</div>`;

      groups[day].forEach(ev => {
        const goal = S.db.learning_goals.find(g => g.id === ev.goal_id);
        const title = goal ? goal.title : ev.goal_id;
        const machine = goal ? machineLabel(goal.machine_id) : "";
        const time = ev.evaluated_at
          ? new Date(ev.evaluated_at).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })
          : "";

        content += `<div class="eval-entry">
          <span class="eval-time">${time}</span>
          <span class="eval-score-badge" data-score="${ev.score}">${ev.score}%</span>
          <div class="eval-entry-info">
            <span class="eval-entry-title">${esc(title)}</span>
            <span class="eval-entry-machine">${esc(machine)}</span>
          </div>
          <span class="eval-who">${esc(userName(ev.evaluated_by))}</span>
        </div>`;
      });

      content += `</div>`;
    });
  }

  return `
    <div class="doc-section" id="sec-history">
      <h2>Letzte Bewertungen</h2>
      <div class="eval-timeline">${content}</div>
    </div>`;
}

function buildDatenHtml() {
  return `
    <div class="doc-section" id="sec-daten">
      <h2>Datenverwaltung</h2>
      <div class="daten-actions">
        <button class="btn-secondary btn-sm" id="btn-export-db">↓ SQLite DB exportieren</button>
        <button class="btn-secondary btn-sm" id="btn-backup-page">↓ JSON Backup</button>
        <button class="btn-secondary btn-sm" id="btn-import-page">↑ Import</button>
        <button class="btn-secondary btn-sm" id="btn-change-db" style="margin-left:auto">⟳ DB-Datei wechseln</button>
      </div>
      <p style="font-size:12px;opacity:0.5;margin-top:8px">NAS-Verbindung: ${DbEngine.connected ? "Aktiv" : "Getrennt"}</p>
    </div>`;
}

/* ── 16. Page Event Binding ── */
function bindPageEvents() {
  const pane = $("#content-pane");

  // Exam result delete (single)
  $$(".exam-hist-del").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!confirm("Prüfungsergebnis löschen?")) return;
      DbEngine.run("DELETE FROM exam_results WHERE id = ?", [parseInt(btn.dataset.examId)]);
      renderPage();
    });
  });

  // Exam result delete all
  const delAllBtn = $("#exam-del-all");
  if (delAllBtn) {
    delAllBtn.addEventListener("click", () => {
      const tid = S.selectedTraineeId || S.user?.id;
      if (!tid || !confirm("Alle Prüfungsergebnisse für diesen Schüler löschen?")) return;
      DbEngine.run("DELETE FROM exam_results WHERE trainee_id = ?", [tid]);
      renderPage();
    });
  }

  // Edit buttons
  $$(".section-edit-btn").forEach(btn => {
    btn.addEventListener("click", () => openEditor(btn.dataset.sectionId));
  });

  // Inline title rename (admin only, dblclick)
  if (canAdmin()) {
    $$(".section-title[data-section-id]").forEach(el => {
      el.style.cursor = "pointer";
      el.addEventListener("dblclick", () => startInlineRename(el));
    });
  }


  // Print buttons
  $$(".section-print-btn").forEach(btn => {
    btn.addEventListener("click", () => printSection(btn.dataset.sectionId));
  });

  // Data management buttons (admin)
  const exportDb = $("#btn-export-db");
  if (exportDb) exportDb.addEventListener("click", exportSqliteDb);
  const backupPage = $("#btn-backup-page");
  if (backupPage) backupPage.addEventListener("click", downloadBackup);
  const impPage = $("#btn-import-page");
  if (impPage) impPage.addEventListener("click", handleImport);
  const changeDb = $("#btn-change-db");
  if (changeDb) changeDb.addEventListener("click", async () => {
    if (!confirm("Andere DB-Datei auswählen? Ungespeicherte Daten gehen verloren.")) return;
    try {
      await DbEngine.connectFile();
      reloadState();
      refreshAll();
      notify("Neue DB-Datei verbunden!", "success");
    } catch (e) {
      if (e.name !== "AbortError") notify("Fehler: " + e.message, "danger");
    }
  });

  // Expand/collapse goal detail fields
  pane.querySelectorAll(".goal-expand-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      btn.closest(".goal-row").classList.toggle("expanded");
    });
  });

  // Rating pill segments
  pane.querySelectorAll(".rating-pill-seg").forEach(seg => {
    seg.addEventListener("click", () => {
      if (!canVerify() || !S.selectedTraineeId) return;
      const gid = seg.dataset.goal;
      const val = parseInt(seg.dataset.val, 10);
      const current = goalScore(gid);
      // Cancel pending field-save debounce to avoid duplicate
      clearTimeout(S.fieldTimers[gid]);
      delete S.fieldTimers[gid];
      saveEvaluation(gid, current === val ? 0 : val);
    });
  });

  // Debounced field saves (per goal, cancelable via S.fieldTimers)
  function dSave(gid) {
    clearTimeout(S.fieldTimers[gid]);
    S.fieldTimers[gid] = setTimeout(() => {
      delete S.fieldTimers[gid];
      const fields = pane.querySelector(`.goal-fields[data-goal-detail="${gid}"]`);
      if (!fields) return;
      saveEvaluation(gid, goalScore(gid),
        parseFloat(fields.querySelector(".goal-error-rate")?.value) || 0,
        fields.querySelector(".goal-comment")?.value || "",
        fields.querySelector(".goal-action")?.value || "");
    }, 800);
  }

  pane.querySelectorAll(".goal-error-rate, .goal-comment, .goal-action").forEach(inp => {
    inp.addEventListener("input", () => { if (canVerify()) dSave(inp.dataset.goal); });
  });

  // Sort mode toggle
  const sortBtn = $("#btn-sort-mode");
  if (sortBtn) sortBtn.addEventListener("click", toggleSortMode);

  // Sort buttons (admin sort mode)
  pane.querySelectorAll(".sort-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation(); // prevent details toggle
      const action = btn.dataset.sort;
      if (action === "phase-up") movePhase(btn.dataset.phase, -1);
      else if (action === "phase-down") movePhase(btn.dataset.phase, 1);
      else if (action === "machine-up") moveMachine(btn.dataset.machine, -1);
      else if (action === "machine-down") moveMachine(btn.dataset.machine, 1);
      else if (action === "goal-up") moveGoal(btn.dataset.goal, -1);
      else if (action === "goal-down") moveGoal(btn.dataset.goal, 1);
    });
  });

  // Sort selects (goal reassignment)
  pane.querySelectorAll(".sort-select").forEach(sel => {
    sel.addEventListener("change", (e) => {
      e.stopPropagation();
      const action = sel.dataset.sort;
      if (action === "goal-phase") reassignGoal(sel.dataset.goal, "phase", sel.value);
      else if (action === "goal-machine") reassignGoal(sel.dataset.goal, "machine_id", sel.value);
    });
  });
}

/* ── 17. Evaluations ── */
function saveEvaluation(goalId, score, errorRate, comment, action) {
  if (!canVerify() || !S.selectedTraineeId) return;

  const fields = document.querySelector(`.goal-fields[data-goal-detail="${goalId}"]`);
  if (errorRate === undefined && fields) errorRate = parseFloat(fields.querySelector(".goal-error-rate")?.value) || 0;
  if (comment === undefined && fields) comment = fields.querySelector(".goal-comment")?.value || "";
  if (action === undefined && fields) action = fields.querySelector(".goal-action")?.value || "";

  const now = nowIso();
  DbEngine.run(
    "INSERT INTO evaluations (trainee_id,goal_id,score,error_rate,comment,action,evaluated_by,evaluated_at) VALUES (?,?,?,?,?,?,?,?)",
    [S.selectedTraineeId, goalId, score, errorRate || 0, (comment || "").trim(), (action || "").trim(), S.user.id, now]
  );

  // Update local cache for immediate UI
  S.evalMap[goalId] = { trainee_id: S.selectedTraineeId, goal_id: goalId, score, error_rate: errorRate || 0,
    comment: (comment || "").trim(), action: (action || "").trim(), evaluated_by: S.user.id, evaluated_at: now };
  updateGoalCardUi(goalId);
}

function updateGoalCardUi(goalId) {
  const row = document.querySelector(`.goal-row[data-goal-id="${goalId}"]`);
  if (!row) return;
  const ev = S.evalMap[goalId];
  const score = ev ? (ev.score || 0) : 0;
  const isNio = ev && ev.score === 0 && ev.evaluated_at;
  row.dataset.score = score;
  row.querySelectorAll(".rating-pill-seg").forEach(seg => {
    const val = parseInt(seg.dataset.val, 10);
    if (val === 0) {
      seg.classList.toggle("filled", !!isNio);
    } else {
      seg.classList.toggle("filled", score >= val);
    }
  });
  const meta = row.querySelector(".goal-row-meta");
  if (meta && ev) meta.innerHTML = `${esc(userName(ev.evaluated_by))} · ${formatDate(ev.evaluated_at)}`;

  // Update has-data indicator on expand button
  row.classList.toggle("has-data", !!(ev && (ev.comment || ev.action || ev.error_rate)));

  // Update parent progress bars (machine → phase → sidebar → dashboard)
  updateProgressUi(goalId);
}

function updateProgressUi(goalId) {
  const goal = S.db.learning_goals.find(g => g.id === goalId);
  if (!goal) return;
  const pid = goal.phase;
  const mid = goal.machine_id;

  // 1. Machine header bar
  const machineEl = document.querySelector(`.machine-group[data-machine="${mid}"][data-phase="${pid}"]`);
  if (machineEl) {
    const mpct = Math.round(machineProgress(pid, mid));
    const bar = machineEl.querySelector(".machine-mini-bar-fill");
    const label = machineEl.querySelector(".machine-mini-pct");
    if (bar) bar.style.width = mpct + "%";
    if (label) label.textContent = mpct + "%";
  }

  // 2. Phase header bar
  const phaseSec = document.getElementById("sec-phase-" + pid);
  if (phaseSec) {
    const ppct = Math.round(phaseProgress(pid));
    const bar = phaseSec.querySelector(".phase-header-bar-fill");
    const label = phaseSec.querySelector(".phase-header-pct");
    if (bar) bar.style.width = ppct + "%";
    if (label) label.textContent = ppct + "%";
  }

  // 3. Sidebar nav
  const navLink = document.querySelector(`.nav-link[data-phase="${pid}"] .mono-label`);
  if (navLink) navLink.textContent = Math.round(phaseProgress(pid)) + "%";

  // 4. Dashboard (if visible)
  const dashPhase = document.querySelector(`.phase-bar-wrap[data-phase="${pid}"]`);
  if (dashPhase) {
    const ppct = Math.round(phaseProgress(pid));
    const bar = dashPhase.querySelector(".phase-bar-fill");
    const label = dashPhase.querySelector(".phase-bar-pct");
    if (bar) bar.style.width = ppct + "%";
    if (label) label.textContent = ppct + "%";
  }
  const kpi = document.getElementById("kpi-overall");
  if (kpi) kpi.textContent = overallProgress().toFixed(1) + "%";
}

/* ── 18. Print Section ── */
function printSection(sectionId) {
  const sec = findSection(sectionId);
  if (!sec) return;

  const html = renderMarkdown(sec.content_md || "");
  const win = window.open("", "_blank");
  if (!win) { notify("Pop-up blockiert – bitte Pop-ups erlauben.", "error"); return; }

  win.document.write(`<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="UTF-8">
<title>${esc(sec.title)} – SchulungsHub</title>
<style>@font-face{font-family:'Inter';font-weight:400;src:local('Inter'),local('Inter Regular')}@font-face{font-family:'Inter';font-weight:600;src:local('Inter SemiBold'),local('Inter-SemiBold')}@font-face{font-family:'Inter';font-weight:700;src:local('Inter Bold'),local('Inter-Bold')}</style>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Inter', sans-serif; color: #222; line-height: 1.7; padding: 40px 50px; max-width: 800px; margin: 0 auto; }
  h1 { font-size: 22px; font-weight: 700; margin-bottom: 24px; padding-bottom: 10px; border-bottom: 2px solid #1e87f0; }
  h2 { font-size: 18px; font-weight: 600; margin: 28px 0 12px; }
  h3 { font-size: 15px; font-weight: 600; margin: 20px 0 8px; }
  p { margin: 0 0 10px; }
  ul, ol { margin: 0 0 12px 20px; }
  li { margin-bottom: 4px; }
  code { font-family: 'JetBrains Mono', monospace; font-size: 12px; background: #f3f4f6; padding: 1px 5px; border-radius: 3px; }
  pre { background: #f3f4f6; padding: 14px; border-radius: 6px; overflow-x: auto; margin: 12px 0; }
  pre code { background: none; padding: 0; }
  img { max-width: 100%; height: auto; border-radius: 4px; margin: 8px 0; }
  table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 13px; }
  th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: left; }
  th { background: #f8f9fa; font-weight: 600; }
  .custom-alert { border-left: 3px solid #888; padding: 10px 14px; margin: 12px 0; border-radius: 4px; background: #f9f9f9; }
  .alert-tip { border-color: #10b981; }
  .alert-note { border-color: #1e87f0; }
  .alert-warning { border-color: #f59e0b; }
  .alert-important { border-color: #ef4444; }
  .alert-header { font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 4px; }
  .footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 11px; color: #999; }
  @media print {
    body { padding: 20px; }
    .no-print { display: none; }
  }
</style>
</head>
<body>
  <h1>${esc(sec.title)}</h1>
  ${html}
  <div class="footer">SchulungsHub · Siebdruck · Gedruckt am ${new Date().toLocaleDateString("de-DE")}</div>
  <script>window.onload = function() { window.print(); }<\/script>
</body>
</html>`);
  win.document.close();
}

/* ── 19. Content Editor ── */
function openEditor(sectionId) {
  S.editingSection = sectionId;
  let sec = findSection(sectionId);
  if (!sec) return;

  const container = document.getElementById(`sec-${sectionId}`);
  if (!container) return;

  const currentMd = sec.content_md || "";

  container.innerHTML = `
    <h2>${esc(sec.title)}
      <button class="btn-icon editor-close-btn" title="Schliessen"><span uk-icon="icon: close; ratio:0.8"></span></button>
    </h2>
    <div class="editor-wrap">
      <div class="editor-toolbar">
        <button type="button" data-prefix="# " title="H1">H1</button>
        <button type="button" data-prefix="## " title="H2">H2</button>
        <button type="button" data-prefix="### " title="H3">H3</button>
        <button type="button" data-wrap="**" title="Fett">B</button>
        <button type="button" data-wrap="*" title="Kursiv">I</button>
        <button type="button" data-prefix="- " title="Liste">List</button>
        <button type="button" data-prefix="1. " title="Num. Liste">1.</button>
        <button type="button" data-action="code" title="Code (inline / Block)">Code</button>
        <button type="button" data-block="note" title="Note">Note</button>
        <button type="button" data-block="tip" title="Tip">Tip</button>
        <button type="button" data-block="warning" title="Warnung">Warn</button>
        <button type="button" data-block="important" title="Wichtig">Imp</button>
      </div>
      <div class="editor-split">
        <div class="editor-input">
          <textarea id="editor-textarea" spellcheck="true">${esc(currentMd)}</textarea>
        </div>
        <div class="editor-preview md-content" id="editor-preview"></div>
      </div>
      <div class="editor-actions">
        <button class="btn-secondary btn-sm editor-cancel-btn">Abbrechen</button>
        <button class="btn-primary btn-sm editor-save-btn">Speichern</button>
      </div>
    </div>
  `;

  const textarea = $("#editor-textarea");
  const preview = $("#editor-preview");

  const updatePreview = () => { preview.innerHTML = renderMarkdown(textarea.value); };
  updatePreview();
  textarea.addEventListener("input", debounce(updatePreview, 200));

  // Toolbar
  container.querySelectorAll(".editor-toolbar button").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.dataset.prefix) prefixSelection(textarea, btn.dataset.prefix);
      else if (btn.dataset.wrap) wrapSelection(textarea, btn.dataset.wrap);
      else if (btn.dataset.block) blockSelection(textarea, btn.dataset.block);
      else if (btn.dataset.action === "code") codeSelection(textarea);
      updatePreview();
    });
  });

  // Save
  container.querySelector(".editor-save-btn").addEventListener("click", async () => {
    const now = nowIso();
    DbEngine.runBatch("UPDATE content_sections SET content_md=?, updated_at=? WHERE id=?",
      [textarea.value, now, sectionId]);
    const ok = await DbEngine.persistNow();
    if (!ok) { notify("Speichern fehlgeschlagen!", "danger"); return; }
    sec.content_md = textarea.value;
    sec.updated_at = now;
    notify("Gespeichert!", "success");
    // Re-render just this section in place
    const newHtml = buildContentSectionHtml(sec);
    container.outerHTML = newHtml;
    // Re-bind edit button for this section
    const newEl = document.getElementById(`sec-${sectionId}`);
    if (newEl) {
      newEl.classList.add("visible");
      const eb = newEl.querySelector(".section-edit-btn");
      if (eb) eb.addEventListener("click", () => openEditor(sectionId));
    }
    S.editingSection = null;
  });

  // Cancel / Close
  const closeEditor = () => {
    const newHtml = buildContentSectionHtml(sec);
    container.outerHTML = newHtml;
    const newEl = document.getElementById(`sec-${sectionId}`);
    if (newEl) {
      newEl.classList.add("visible");
      const eb = newEl.querySelector(".section-edit-btn");
      if (eb) eb.addEventListener("click", () => openEditor(sectionId));
    }
    S.editingSection = null;
  };

  container.querySelector(".editor-cancel-btn").addEventListener("click", closeEditor);
  container.querySelector(".editor-close-btn").addEventListener("click", closeEditor);
}

function prefixSelection(textarea, prefix) {
  const s = textarea.selectionStart, e = textarea.selectionEnd;
  const sel = textarea.value.slice(s, e);
  if (sel) {
    const prefixed = sel.split("\n").map(l => prefix + l).join("\n");
    textarea.value = textarea.value.slice(0, s) + prefixed + textarea.value.slice(e);
    textarea.selectionStart = s;
    textarea.selectionEnd = s + prefixed.length;
  } else {
    textarea.value = textarea.value.slice(0, s) + prefix + textarea.value.slice(e);
    textarea.selectionStart = textarea.selectionEnd = s + prefix.length;
  }
  textarea.focus();
}

function wrapSelection(textarea, w) {
  const s = textarea.selectionStart, e = textarea.selectionEnd;
  const sel = textarea.value.slice(s, e);
  if (sel) {
    textarea.value = textarea.value.slice(0, s) + w + sel + w + textarea.value.slice(e);
    textarea.selectionStart = s + w.length;
    textarea.selectionEnd = s + w.length + sel.length;
  } else {
    textarea.value = textarea.value.slice(0, s) + w + w + textarea.value.slice(e);
    textarea.selectionStart = textarea.selectionEnd = s + w.length;
  }
  textarea.focus();
}

function codeSelection(textarea) {
  const s = textarea.selectionStart, e = textarea.selectionEnd;
  const sel = textarea.value.slice(s, e);
  const multiline = sel.includes("\n");
  if (multiline || !sel) {
    // Fenced code block
    const inner = sel || "Code hier...";
    const block = "\n```\n" + inner + "\n```\n";
    textarea.value = textarea.value.slice(0, s) + block + textarea.value.slice(e);
    textarea.selectionStart = s + 5; // after opening ``` + newline
    textarea.selectionEnd = s + 5 + inner.length;
  } else {
    // Inline code
    textarea.value = textarea.value.slice(0, s) + "`" + sel + "`" + textarea.value.slice(e);
    textarea.selectionStart = s + 1;
    textarea.selectionEnd = s + 1 + sel.length;
  }
  textarea.focus();
}

function blockSelection(textarea, type) {
  const s = textarea.selectionStart, e = textarea.selectionEnd;
  const sel = textarea.value.slice(s, e) || "Text hier...";
  const quoted = sel.split("\n").map(l => "> " + l).join("\n");
  const block = "\n> [!" + type.toUpperCase() + "]\n" + quoted + "\n";
  textarea.value = textarea.value.slice(0, s) + block + textarea.value.slice(e);
  textarea.selectionStart = s;
  textarea.selectionEnd = s + block.length;
  textarea.focus();
}

/* ── Inline Title Rename (admin dblclick) ── */
function startInlineRename(el) {
  const secId = el.dataset.sectionId;
  const sec = findSection(secId);
  if (!sec) return;

  const oldTitle = sec.title;
  const input = document.createElement("input");
  input.type = "text";
  input.value = oldTitle;
  input.className = "inline-rename";
  input.style.cssText = "font:inherit;font-size:inherit;font-weight:inherit;letter-spacing:inherit;color:var(--heading);background:var(--bg);border:2px solid var(--accent);border-radius:6px;padding:2px 8px;width:100%;outline:none;";

  el.replaceWith(input);
  input.focus();
  input.select();

  function commit() {
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== oldTitle) {
      sec.title = newTitle;
      DbEngine.run("UPDATE content_sections SET title=? WHERE id=?", [newTitle, secId]);
      renderSidebar();
    }
    // Replace input back with span
    const span = document.createElement("span");
    span.className = "section-title";
    span.dataset.sectionId = secId;
    span.title = "Doppelklick zum Umbenennen";
    span.textContent = sec.title;
    span.style.cursor = "pointer";
    span.addEventListener("dblclick", () => startInlineRename(span));
    input.replaceWith(span);
  }

  function cancel() {
    const span = document.createElement("span");
    span.className = "section-title";
    span.dataset.sectionId = secId;
    span.title = "Doppelklick zum Umbenennen";
    span.textContent = oldTitle;
    span.style.cursor = "pointer";
    span.addEventListener("dblclick", () => startInlineRename(span));
    input.replaceWith(span);
  }

  input.addEventListener("keydown", e => {
    if (e.key === "Enter") { e.preventDefault(); commit(); }
    if (e.key === "Escape") { e.preventDefault(); cancel(); }
  });
  input.addEventListener("blur", commit);
}

function findSection(id) {
  for (const s of (S.db.content_sections || [])) {
    if (s.id === id) return s;
    for (const ch of (s.children || [])) {
      if (ch.id === id) return ch;
      for (const sub of (ch.children || [])) { if (sub.id === id) return sub; }
    }
  }
  return null;
}

async function handleAddSection() {
  const title = prompt("Titel der neuen Sektion:");
  if (!title || !title.trim()) return;

  const id = title.trim().toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-").replace(/^-|-$/g, "");
  const sections = S.db.content_sections || [];
  const maxPos = sections.reduce((m, s) => Math.max(m, s.position || 0), 0);

  const secId = id || `sec-${Date.now()}`;
  const now = nowIso();
  DbEngine.runBatch("INSERT INTO content_sections (id, title, position, content_md, parent_id, updated_at) VALUES (?,?,?,?,?,?)",
    [secId, title.trim(), maxPos + 1, "", null, now]);
  await DbEngine.persistNow();
  reloadState();
  renderSidebar();
  renderPage();
  notify("Sektion erstellt!", "success");

  // Scroll to new section
  setTimeout(() => {
    const el = document.getElementById(`sec-${secId}`);
    if (el) { el.classList.add("visible"); window.scrollTo({ top: el.offsetTop - 70, behavior: "smooth" }); }
  }, 100);
}

/* ── 19. Report ── */
function generateReport() {
  if (!S.selectedTraineeId) return;
  const trainee = findUser(S.selectedTraineeId);
  const overall = overallProgress();
  const meta = S.db.trainee_meta[S.selectedTraineeId] || {};

  let rows = "";
  getPhases().forEach(phase => {
    const goals = S.db.learning_goals.filter(g => g.phase === phase.id);
    if (!goals.length) return;
    const pct = Math.round(phaseProgress(phase.id));
    rows += `<tr style="background:#f0f4f3"><td colspan="7" style="font-weight:700;padding:8px">${esc(phase.label)} — ${pct}%</td></tr>`;
    const mMap = {};
    goals.forEach(g => { if (!mMap[g.machine_id]) mMap[g.machine_id] = []; mMap[g.machine_id].push(g); });
    Object.entries(mMap).forEach(([mid, mGoals]) => {
      rows += `<tr style="background:#f8faf9"><td colspan="7" style="font-weight:600;padding:6px 8px">${esc(machineLabel(mid))}</td></tr>`;
      mGoals.forEach(g => {
        const ev = S.evalMap[g.id];
        const score = ev ? ev.score : 0;
        rows += `<tr>
          <td style="padding:4px 8px">${esc(g.title)}</td>
          <td style="text-align:center;font-weight:700">${score}%</td>
          <td style="text-align:center">${ev?.error_rate || "-"}</td>
          <td>${esc(ev?.comment || "")}</td>
          <td>${esc(ev?.action || "")}</td>
          <td>${ev ? esc(userName(ev.evaluated_by)) : "-"}</td>
          <td>${ev ? formatDateShort(ev.evaluated_at) : "-"}</td>
        </tr>`;
      });
    });
  });

  const html = `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
    <title>Bericht – ${esc(trainee?.display_name || "?")}</title>
    <style>
      body { font-family: "Inter","Segoe UI",sans-serif; margin:2rem; color:#222; font-size:12px; }
      h1 { font-size:18px; margin:0 0 4px; } .meta { color:#666; margin-bottom:12px; }
      table { width:100%; border-collapse:collapse; margin:8px 0; }
      th,td { border:1px solid #d0d5dd; padding:4px 8px; text-align:left; font-size:11px; }
      th { background:#1e87f0; color:#fff; }
      @media print { body { margin:1cm; } }
    </style></head><body>
    <h1>Bewertungsbericht: ${esc(trainee?.display_name || "?")}</h1>
    <div class="meta">Erstellt: ${formatDate(nowIso())} · Gesamt: ${overall.toFixed(1)}% · ${S.db.learning_goals.length} Lernziele</div>
    <table><thead><tr><th>Lernziel</th><th>Score</th><th>Fehler%</th><th>Kommentar</th><th>Maßnahme</th><th>Ausbilder</th><th>Datum</th></tr></thead><tbody>${rows}</tbody></table>
    ${meta.general_feedback ? `<h2>Feedback</h2><p>${esc(meta.general_feedback)}</p>` : ""}
    ${meta.conclusion ? `<h2>Fazit</h2><p>${esc(meta.conclusion)}</p>` : ""}
    <div style="margin-top:20px;border-top:1px solid #ccc;padding-top:10px;color:#666">SchulungsHub – ${formatDate(nowIso())}</div>
    <script>window.print()<\/script></body></html>`;

  const w = window.open("", "_blank");
  if (w) { w.document.write(html); w.document.close(); }
}

/* ── 20. Import / Export ── */
function exportSqliteDb() {
  const data = DbEngine.exportBinary();
  const blob = new Blob([data], { type: "application/x-sqlite3" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `schulungshub-${new Date().toISOString().slice(0, 10)}.db`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  notify("SQLite DB exportiert!", "success");
}

function downloadBackup() {
  const blob = new Blob([JSON.stringify(DbEngine.toJson(), null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `schulungshub-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function handleImport() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
      });
      importJson(await (await handle.getFile()).text());
    } catch (e) {
      if (e.name !== "AbortError") notify("Import fehlgeschlagen: " + e.message, "danger");
    }
    return;
  }
  const input = $("#import-file-input");
  input.value = "";
  input.click();
}

async function importJson(text) {
  await DbEngine.importJson(JSON.parse(text));
  reloadState();
  if (S.user) { const r = findUser(S.user.id); if (r) S.user = r; }
  initApp();
  notify("Daten importiert!", "success");
}

/* ── 21. User Header ── */
function updateUserUi() {
  const n = $("#user-name"), r = $("#user-role"), a = $("#user-avatar");
  if (!S.user) {
    if (n) n.textContent = "–";
    if (r) r.textContent = "";
    if (a) a.textContent = "?";
    return;
  }
  if (n) n.textContent = S.user.display_name.split(" ")[0];
  const roles = { admin: "Admin", trainer: "Trainer", trainee: "Azubi" };
  if (r) r.textContent = roles[S.user.role] || S.user.role;
  if (a) a.textContent = S.user.initials || S.user.display_name.slice(0, 2).toUpperCase();
  const ver = $("#app-version");
  if (ver) ver.textContent = "v" + APP_VERSION;
}

function updateTraineeSelect() {
  const sel = $("#trainee-select");
  const wrap = $("#dropdown-trainee-wrap");
  if (!canVerify()) {
    if (wrap) wrap.classList.add("hidden");
    return;
  }
  if (wrap) wrap.classList.remove("hidden");
  sel.innerHTML = "";
  S.trainees = allTrainees();
  S.trainees.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t.id;
    opt.textContent = t.display_name;
    sel.appendChild(opt);
  });
  if (S.selectedTraineeId) sel.value = S.selectedTraineeId;
}

/* ── 22. Login ── */
function redirectToLogin() {
  window.location.href = "login.html";
}

async function handleLogout() {
  await setSession(null);
  redirectToLogin();
}

/* ── 23. Change Password ── */
function openChangePassword() {
  const dlg = $("#changepw-dialog");
  if (!dlg) return;
  dlg.showModal();
}

async function handleChangePassword(e) {
  e.preventDefault();
  const err = $("#changepw-error");
  err.textContent = "";
  const pw1 = ($("#changepw-new")?.value || "");
  const pw2 = ($("#changepw-confirm")?.value || "");

  if (pw1.length < 8) { err.textContent = "Mindestens 8 Zeichen."; return; }
  if (pw1 !== pw2) { err.textContent = "Passwörter stimmen nicht überein."; return; }

  const user = S.db.users.find(u => u.id === S.user.id);
  if (!user) return;

  user.password_hash = await createPasswordHash(pw1);
  user.must_change_password = false;
  DbEngine.runBatch("UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?",
    [user.password_hash, S.user.id]);
  await DbEngine.persistNow();

  $("#changepw-dialog").close();
  $("#changepw-form").reset();
  notify("Passwort geändert!", "success");
  initApp();
}

/* ── 23b. User Management Dialog ── */
function openUserManagement() {
  if (!canVerify()) return;
  const dlg = $("#usermgmt-dialog");
  if (!dlg) return;
  renderUserManagementDialog();
  dlg.showModal();
}

function renderUserManagementDialog() {
  const list = $("#usermgmt-list");
  if (!list) return;

  const isAdmin = canAdmin();
  const users = allUsers().filter(u => {
    if (u.id === S.user.id) return false; // Don't show yourself
    if (isAdmin) return true; // Admin sees all (trainers + trainees)
    return u.role === "trainee" && u.created_by === S.user.id; // Trainer: own trainees
  });

  const trainers = users.filter(u => u.role === "trainer");
  const trainees = users.filter(u => u.role === "trainee");

  const userRow = (u) => {
    const creator = u.created_by ? userName(u.created_by) : "–";
    const date = u.created_at ? formatDate(u.created_at) : "–";
    const roleLabel = u.role === "trainer" ? "Trainer" : u.role === "admin" ? "Admin" : "Schüler";
    const pwBadge = u.must_change_password ? ' <span class="mono-label" style="color:var(--accent)">PW-WECHSEL</span>' : "";
    const rfidBtn = isAdmin
      ? `<button class="btn-icon umgmt-rfid" data-user-id="${u.id}" title="RFID-Chip zuweisen"><span uk-icon="icon: bolt; ratio:0.75"></span></button>`
      : "";
    const rfidBadge = u.rfid_hash ? ' <span class="mono-label" style="opacity:0.4">RFID</span>' : "";
    return `<div class="usermgmt-row">
      <div class="usermgmt-row-info">
        <span class="usermgmt-name">${esc(u.display_name)}${pwBadge}${rfidBadge}</span>
        <span class="usermgmt-meta">${roleLabel} · ${esc(u.username)} · angelegt: ${date} · von: ${esc(creator)}</span>
      </div>
      <div class="usermgmt-row-actions">
        ${rfidBtn}
        <button class="btn-icon umgmt-reset-pw" data-user-id="${u.id}" title="Passwort zurücksetzen"><span uk-icon="icon: lock; ratio:0.75"></span></button>
        <button class="btn-icon umgmt-delete" data-user-id="${u.id}" title="Entfernen"><span uk-icon="icon: trash; ratio:0.75"></span></button>
      </div>
    </div>`;
  };

  let html = "";

  if (isAdmin && trainers.length) {
    html += `<div class="usermgmt-group-label">Trainer</div>`;
    trainers.forEach(u => html += userRow(u));
  }

  html += `<div class="usermgmt-group-label">Schüler${!isAdmin ? " (eigene)" : ""}</div>`;
  if (trainees.length) {
    trainees.forEach(u => html += userRow(u));
  } else {
    html += `<p style="opacity:0.5; font-size:13px; padding:8px 0">Keine Schüler angelegt.</p>`;
  }

  list.innerHTML = html;

  // Bind delete buttons
  list.querySelectorAll(".umgmt-delete").forEach(btn => {
    btn.addEventListener("click", () => {
      handleDeleteUser(parseInt(btn.dataset.userId, 10));
      renderUserManagementDialog(); // Refresh list
    });
  });

  // Bind PW reset buttons
  list.querySelectorAll(".umgmt-reset-pw").forEach(btn => {
    btn.addEventListener("click", async () => {
      const uid = parseInt(btn.dataset.userId, 10);
      await handleResetPassword(uid);
      renderUserManagementDialog();
    });
  });

  // Bind RFID buttons (admin only)
  list.querySelectorAll(".umgmt-rfid").forEach(btn => {
    btn.addEventListener("click", () => {
      const uid = parseInt(btn.dataset.userId, 10);
      openRfidAssign(uid);
    });
  });
}

async function handleResetPassword(userId) {
  const user = S.db.users.find(u => u.id === userId);
  if (!user) return;
  if (!canVerify()) return;
  // Admin can reset anyone, trainer only own trainees
  if (!canAdmin() && !(user.role === "trainee" && user.created_by === S.user.id)) return;

  if (!confirm(`Passwort von "${user.display_name}" auf "start123" zurücksetzen?`)) return;

  user.password_hash = await createPasswordHash("start123");
  user.must_change_password = true;
  DbEngine.runBatch("UPDATE users SET password_hash=?, must_change_password=1 WHERE id=?",
    [user.password_hash, userId]);
  await DbEngine.persistNow();
  notify(`Passwort von ${user.display_name} zurückgesetzt.`, "success");
}

/* ── RFID Assign (Admin) ── */
function openRfidAssign(userId) {
  if (!canAdmin()) return;
  const user = S.db.users.find(u => u.id === userId);
  if (!user) return;

  const dlg = $("#rfid-dialog");
  if (!dlg) return;

  // Populate dialog content
  $("#rfid-user-name").innerHTML = `<strong>${esc(user.display_name)}</strong>`;
  $("#rfid-status-text").textContent = user.rfid_hash
    ? "Hat bereits einen RFID-Chip. Neuer Scan überschreibt."
    : "Noch kein RFID-Chip zugewiesen.";

  const input = $("#rfid-scan-input");
  const saveBtn = $("#rfid-save");
  const removeBtn = $("#rfid-remove");

  // Reset state
  input.value = "";
  saveBtn.disabled = true;
  saveBtn.textContent = "Speichern";
  removeBtn.classList.toggle("hidden", !user.rfid_hash);

  let scanTimer = null;
  let scannedTag = "";

  // Clone buttons to remove old event listeners
  const newSave = saveBtn.cloneNode(true);
  saveBtn.replaceWith(newSave);
  const newCancel = $("#rfid-cancel").cloneNode(true);
  $("#rfid-cancel").replaceWith(newCancel);
  const newRemove = removeBtn.cloneNode(true);
  removeBtn.replaceWith(newRemove);

  // Scanner types fast, wait 300ms after last char
  function onInput() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scannedTag = input.value.trim();
      if (scannedTag.length >= 4) {
        newSave.disabled = false;
        newSave.textContent = `Speichern (${scannedTag})`;
      }
    }, 300);
  }
  input.removeEventListener("input", input._rfidHandler);
  input._rfidHandler = onInput;
  input.addEventListener("input", onInput);

  newSave.addEventListener("click", async () => {
    if (!scannedTag) return;
    const hash = await sha256Hex(scannedTag);
    DbEngine.runBatch("UPDATE users SET rfid_hash=? WHERE id=?", [hash, userId]);
    await DbEngine.persistNow();
    reloadState();
    const savedUser = findUser(userId);
    notify(`RFID-Chip für ${savedUser ? savedUser.display_name : "Benutzer"} gespeichert.`, "success");
    dlg.close();
    renderUserManagementDialog();
  });

  newCancel.addEventListener("click", () => dlg.close());

  if (user.rfid_hash) {
    newRemove.addEventListener("click", async () => {
      DbEngine.runBatch("UPDATE users SET rfid_hash='' WHERE id=?", [userId]);
      await DbEngine.persistNow();
      reloadState();
      notify(`RFID-Chip von ${user.display_name} entfernt.`, "success");
      dlg.close();
      renderUserManagementDialog();
    });
  }

  // Close on backdrop click
  dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); }, { once: true });

  // Open as modal (stacks on top of usermgmt-dialog)
  dlg.showModal();
  setTimeout(() => input.focus(), 50);
}

/* ── 24. Admin ── */
async function handleDeleteUser(userId) {
  if (!canVerify()) return;
  const user = S.db.users.find(u => u.id === userId);
  if (!user || user.id === S.user.id) return;

  // Permission check: admin can delete anyone, trainer only own trainees
  if (!canAdmin() && !(user.role === "trainee" && user.created_by === S.user.id)) return;

  if (!confirm(`"${user.display_name}" wirklich entfernen?`)) return;

  DbEngine.runBatch("UPDATE users SET active=0 WHERE id=?", [userId]);
  DbEngine.runBatch("DELETE FROM evaluations WHERE trainee_id=?", [userId]);
  DbEngine.runBatch("DELETE FROM trainee_meta WHERE trainee_id=?", [userId]);
  await DbEngine.persistNow();
  reloadState();
  notify(`${user.display_name} entfernt.`, "success");
  S.trainees = allTrainees();
  updateTraineeSelect();
  if (S.selectedTraineeId === userId) {
    S.selectedTraineeId = S.trainees[0]?.id || null;
    S.evalMap = S.selectedTraineeId ? buildEvalMap(S.selectedTraineeId) : {};
  }
  renderSidebar();
  renderPage();
}

async function handleCreateUser(e) {
  e.preventDefault();
  if (!canVerify()) return;
  const fd = new FormData($("#admin-form"));
  const vorname = (fd.get("vorname") || "").trim();
  const nachname = (fd.get("nachname") || "").trim();
  const role = fd.get("role") || "trainee";
  const rfidRaw = (fd.get("rfid_tag") || "").trim();

  if (!vorname || !nachname) { notify("Vor- und Nachname ausfüllen.", "warning"); return; }

  // Generate username: vorname.nachname (lowercase, no special chars)
  const clean = s => s.toLowerCase().replace(/[äÄ]/g, "ae").replace(/[öÖ]/g, "oe").replace(/[üÜ]/g, "ue").replace(/[ß]/g, "ss").replace(/[^a-z0-9]/g, "");
  let uname = clean(vorname) + "." + clean(nachname);

  // Ensure unique
  let suffix = 0;
  while (allUsers().some(u => u.username === (suffix ? uname + suffix : uname))) suffix++;
  if (suffix) uname += suffix;

  const displayName = vorname + " " + nachname;
  const initials = (vorname[0] + nachname[0]).toUpperCase();

  // Hash RFID if provided
  let rfidHash = "";
  if (rfidRaw) {
    const enc = new TextEncoder().encode(rfidRaw);
    const buf = await crypto.subtle.digest("SHA-256", enc);
    rfidHash = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  // Fixed default password: start123
  const passwordHash = await createPasswordHash("start123");

  const newId = nextId(S.db.users);
  const now = nowIso();
  DbEngine.runBatch(
    "INSERT INTO users (id,username,display_name,initials,role,active,password_hash,rfid_hash,created_at,created_by,must_change_password,theme) VALUES (?,?,?,?,?,1,?,?,?,?,1,NULL)",
    [newId, uname, displayName, initials, role, passwordHash, rfidHash, now, S.user.id]
  );
  await DbEngine.persistNow();
  reloadState();
  $("#admin-form").reset();
  $("#admin-dialog").close();
  notify(`${displayName} angelegt! Login: ${uname} / start123`, "success");
  S.trainees = allTrainees();
  updateTraineeSelect();
  renderSidebar();
  renderPage();
}

/* ── 24. Mobile Menu ── */
function openMobileMenu() {
  const sb = $("#sidebar"), ov = $("#mobile-overlay");
  if (sb) sb.classList.add("mobile-open");
  if (ov) ov.classList.add("active");
  document.body.style.overflow = "hidden";
}

function closeMobileMenu() {
  const sb = $("#sidebar"), ov = $("#mobile-overlay");
  if (sb) sb.classList.remove("mobile-open");
  if (ov) ov.classList.remove("active");
  document.body.style.overflow = "";
}

/* ── 25. Scroll to Top ── */
function setupScrollTop() {
  const btn = $("#scroll-top");
  if (!btn) return;
  btn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
  window.addEventListener("scroll", () => {
    btn.classList.toggle("visible", window.scrollY > 300);
  }, { passive: true });
}

/* ── 26. Refresh ── */
function refreshAll() {
  if (!S.user) return;
  if (S.editingSection) return; // Editor offen → kein Auto-Refresh
  S.evalMap = S.selectedTraineeId ? buildEvalMap(S.selectedTraineeId) : {};
  renderSidebar();
  renderPage();
}

/* ── 27. Lock down for non-admins ── */
function setupDevLock() {
  // Block right-click
  document.addEventListener("contextmenu", e => {
    if (!canAdmin()) e.preventDefault();
  });

  // Block dev-tools shortcuts
  document.addEventListener("keydown", e => {
    if (canAdmin()) return;
    // F12
    if (e.key === "F12") { e.preventDefault(); return; }
    // Ctrl+Shift+I / Ctrl+Shift+J / Ctrl+Shift+C (DevTools)
    if (e.ctrlKey && e.shiftKey && "IJC".includes(e.key.toUpperCase())) { e.preventDefault(); return; }
    // Ctrl+U (View Source)
    if (e.ctrlKey && e.key.toUpperCase() === "U") { e.preventDefault(); return; }
    // Cmd variants (macOS)
    if (e.metaKey && e.altKey && "IJC".includes(e.key.toUpperCase())) { e.preventDefault(); return; }
    if (e.metaKey && e.key.toUpperCase() === "U") { e.preventDefault(); return; }
  });
}

/* ── 28. Global Events ── */
function bindGlobalEvents() {
  // Header search
  const searchInput = $("#header-search");
  if (searchInput) {
    let searchTimer = null;
    searchInput.addEventListener("input", () => {
      clearTimeout(searchTimer);
      const q = searchInput.value.trim();
      if (q.length < 2) {
        closeSearchOverlay(false);
        return;
      }
      searchTimer = setTimeout(() => {
        const results = performSearch(q);
        renderSearchResults(results, q);
      }, 250);
    });
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeSearchOverlay();
    });
  }

  const chip = $("#user-chip");
  if (chip) chip.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!S.user) return;
    const dd = $("#user-dropdown");
    if (dd) {
      dd.classList.toggle("hidden");
      // Hide items by role
      const addItem = $("#menu-add-user");
      if (addItem) addItem.classList.toggle("hidden", !canVerify());
      const manageItem = $("#menu-manage-users");
      if (manageItem) manageItem.classList.toggle("hidden", !canVerify());
      const examEditorItem = $("#menu-exam-editor");
      if (examEditorItem) examEditorItem.classList.toggle("hidden", !canAdmin());
      const reportItem = $("#menu-report");
      if (reportItem) reportItem.classList.toggle("hidden", !canVerify());
    }
  });

  // Close dropdown on outside click
  document.addEventListener("click", () => {
    const dd = $("#user-dropdown");
    if (dd && !dd.classList.contains("hidden")) dd.classList.add("hidden");
  });

  // Menu items
  const menuLogout = $("#menu-logout");
  if (menuLogout) menuLogout.addEventListener("click", handleLogout);

  const menuAddUser = $("#menu-add-user");
  if (menuAddUser) menuAddUser.addEventListener("click", () => {
    const dd = $("#user-dropdown");
    if (dd) dd.classList.add("hidden");
    const roleSelect = $("#admin-role-select");
    if (roleSelect) {
      roleSelect.classList.toggle("hidden", !canAdmin());
      if (!canAdmin()) roleSelect.value = "trainee";
    }
    $("#admin-dialog").showModal();
  });

  const menuManage = $("#menu-manage-users");
  if (menuManage) menuManage.addEventListener("click", () => {
    const dd = $("#user-dropdown");
    if (dd) dd.classList.add("hidden");
    openUserManagement();
  });

  const menuExamStart = $("#menu-exam-start");
  if (menuExamStart) menuExamStart.addEventListener("click", () => {
    const dd = $("#user-dropdown");
    if (dd) dd.classList.add("hidden");
    startExam();
  });

  const menuExamAnalysis = $("#menu-exam-analysis");
  if (menuExamAnalysis) menuExamAnalysis.addEventListener("click", () => {
    const dd = $("#user-dropdown");
    if (dd) dd.classList.add("hidden");
    openExamAnalysis();
  });

  const menuExamEditor = $("#menu-exam-editor");
  if (menuExamEditor) menuExamEditor.addEventListener("click", () => {
    const dd = $("#user-dropdown");
    if (dd) dd.classList.add("hidden");
    openExamEditor();
  });

  const menuReport = $("#menu-report");
  if (menuReport) menuReport.addEventListener("click", () => {
    const dd = $("#user-dropdown");
    if (dd) dd.classList.add("hidden");
    generateReport();
  });

  const sel = $("#trainee-select");
  if (sel) {
    sel.addEventListener("click", (e) => e.stopPropagation());
    sel.addEventListener("change", () => {
      S.selectedTraineeId = parseInt(sel.value, 10);
      S.evalMap = buildEvalMap(S.selectedTraineeId);
      refreshAll();
    });
  }

  const tb = $("#theme-toggle");
  if (tb) tb.addEventListener("click", toggleThemeReveal);

  $$(".font-switcher button").forEach(b => b.addEventListener("click", () => applyFont(b.dataset.font)));

  const menuSave = $("#menu-save");
  if (menuSave) menuSave.addEventListener("click", async (e) => {
    e.preventDefault();
    const dd = $("#user-dropdown");
    if (dd) dd.classList.add("hidden");
    updateSaveStatus("saving");
    const ok = await DbEngine.persistNow();
    if (ok) {
      notify("Gespeichert!", "success");
    } else {
      notify("Speichern fehlgeschlagen!", "danger");
    }
  });

  const mob = $("#mobile-toggle");
  if (mob) mob.addEventListener("click", () => {
    const sb = $("#sidebar");
    if (sb && sb.classList.contains("mobile-open")) closeMobileMenu();
    else openMobileMenu();
  });

  const overlay = $("#mobile-overlay");
  if (overlay) overlay.addEventListener("click", closeMobileMenu);

  setupScrollTop();
  setupScrollSpy();

  // Header nav links
  $$(".header-nav-link[data-target]").forEach(link => {
    link.addEventListener("click", e => {
      e.preventDefault();
      const target = document.getElementById(link.dataset.target);
      if (target) {
        target.classList.add("visible");
        window.scrollTo({ top: target.offsetTop - 70, behavior: "smooth" });
      }
    });
  });

  const af = $("#admin-form");
  if (af) af.addEventListener("submit", handleCreateUser);

  const cpf = $("#changepw-form");
  if (cpf) cpf.addEventListener("submit", handleChangePassword);
  const cpd = $("#changepw-dialog");
  if (cpd) cpd.addEventListener("cancel", e => { if (S.user?.must_change_password) e.preventDefault(); });

  // User management dialog close
  const umClose = $("#usermgmt-close");
  if (umClose) umClose.addEventListener("click", () => $("#usermgmt-dialog").close());

  const fi = $("#import-file-input");
  if (fi) fi.addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try { importJson(await file.text()); } catch { notify("Import fehlgeschlagen.", "danger"); }
  });

  // Password toggle (eye icon)
  document.querySelectorAll(".pw-toggle").forEach(btn => {
    btn.addEventListener("click", () => {
      const inp = document.getElementById(btn.dataset.target);
      if (!inp) return;
      const show = inp.type === "password";
      inp.type = show ? "text" : "password";
      btn.classList.toggle("visible", show);
      btn.innerHTML = show ? "&#9675;" : "&#9673;";
    });
  });
}

/* ── 28. Init / Boot ── */
function initApp() {
  if (!S.user) return;

  // Load user's theme preference
  const userObj = S.db.users.find(u => u.id === S.user.id);
  if (userObj?.theme) applyTheme(userObj.theme);

  S.trainees = allTrainees();
  if (canVerify()) {
    if (!S.selectedTraineeId || !S.trainees.find(t => t.id === S.selectedTraineeId)) {
      S.selectedTraineeId = S.trainees[0]?.id || null;
    }
  } else {
    S.selectedTraineeId = S.user.role === "trainee" ? S.user.id : null;
  }

  S.evalMap = S.selectedTraineeId ? buildEvalMap(S.selectedTraineeId) : {};

  updateUserUi();
  updateTraineeSelect();
  updateHeaderNav();
  renderSidebar();
  renderPage();

  // Force password change on first login (must_change_password flag)
  if (S.user.must_change_password) {
    openChangePassword();
  }
}

function updateHeaderNav() {
  const datenLink = $("#nav-daten");
  if (datenLink) datenLink.classList.toggle("hidden", !canAdmin());
}

/* ── NAS Connection Bar (non-blocking) ── */
function showNasBar(mode) {
  let bar = $("#nas-bar");
  if (bar) bar.remove();

  bar = document.createElement("div");
  bar.id = "nas-bar";
  bar.className = "nas-bar";

  if (mode === "needs_permission") {
    bar.innerHTML = `<span>⚠ NAS-Zugriff nötig – Speichern nicht möglich</span>
      <button class="nas-bar-btn" id="btn-nas-permission">Zugriff erlauben</button>`;
    document.body.prepend(bar);
    document.getElementById("btn-nas-permission").addEventListener("click", async () => {
      try {
        const ok = await DbEngine.requestPermission();
        if (ok) {
          reloadState();
          refreshAll();
          bar.remove();
          updateSaveStatus("saved");
          notify("NAS verbunden!", "success");
        } else {
          notify("Berechtigung verweigert.", "danger");
        }
      } catch (e) {
        notify("Fehler: " + e.message, "danger");
      }
    });
  } else {
    // no_handle: first-time setup
    bar.innerHTML = `<span>Speichern nicht aktiv – data.db verbinden</span>
      <button class="nas-bar-btn" id="btn-nas-connect">data.db bestätigen</button>`;
    document.body.prepend(bar);
    document.getElementById("btn-nas-connect").addEventListener("click", async () => {
      try {
        await DbEngine.connect();
        reloadState();
        refreshAll();
        bar.remove();
        updateSaveStatus("saved");
        notify("data.db verbunden!", "success");
      } catch (e) {
        if (e.name !== "AbortError") notify("Verbindung fehlgeschlagen: " + e.message, "danger");
      }
    });
  }

  updateSaveStatus("error");
}

/* ── beforeunload + visibilitychange Guards ── */
function setupGuards() {
  window.addEventListener("beforeunload", (e) => {
    if (DbEngine.dirty) {
      e.preventDefault();
      e.returnValue = "Ungespeicherte Änderungen! Wirklich schliessen?";
      return e.returnValue;
    }
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && DbEngine.dirty) {
      DbEngine.persistNow();
    }
  });
}

/* ================================================================
   EXAM MODE – Prüfungsmodus
   ================================================================ */

const EXAM_TOTAL = 6; // TODO: zurück auf 20 für Produktion
const EXAM_PASS_PCT = 80;

function fisherYates(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

let _examState = null; // { questions, current, answers, startedAt }

function startExam() {
  const all = DbEngine.queryAll("SELECT * FROM exam_questions");
  if (all.length < EXAM_TOTAL) {
    UIkit.notification({ message: `Nicht genug Fragen (${all.length}/${EXAM_TOTAL}). Mindestens ${EXAM_TOTAL} nötig.`, status: "warning", pos: "top-center" });
    return;
  }
  // Shuffle + pick
  const shuffled = fisherYates(all).slice(0, EXAM_TOTAL);
  shuffled.forEach(q => { q._options = fisherYates(JSON.parse(q.options)); });

  _examState = { questions: shuffled, current: 0, answers: [], startedAt: new Date().toISOString() };
  renderExamOverlay();
}

function renderExamOverlay() {
  let ov = $("#exam-overlay");
  if (ov) ov.remove();

  ov = document.createElement("div");
  ov.id = "exam-overlay";
  ov.className = "exam-overlay";

  if (!_examState) return;
  const { questions, current, answers } = _examState;

  // Finished?
  if (current >= questions.length) {
    renderExamResult(ov);
    document.body.appendChild(ov);
    return;
  }

  const q = questions[current];
  const pct = Math.round((current / questions.length) * 100);
  const opts = q._options;

  let optHtml = "";
  if (q.type === "image") {
    optHtml = `<div class="exam-image-grid">`;
    opts.forEach((o, i) => {
      optHtml += `<button class="exam-image-option" data-idx="${i}">
        <img src="${o.image_b64 || ""}" alt="Option ${i + 1}">
        ${o.text ? `<span>${esc(o.text)}</span>` : ""}
      </button>`;
    });
    optHtml += `</div>`;
  } else if (q.type === "truefalse") {
    optHtml = `<div class="exam-options">
      <button class="exam-option" data-idx="0">Richtig</button>
      <button class="exam-option" data-idx="1">Falsch</button>
    </div>`;
    // Remap: options[0] = {text:"Richtig",correct:true/false}, options[1] = {text:"Falsch",...}
  } else {
    // single choice
    optHtml = `<div class="exam-options">`;
    opts.forEach((o, i) => {
      optHtml += `<button class="exam-option" data-idx="${i}">${esc(o.text)}</button>`;
    });
    optHtml += `</div>`;
  }

  ov.innerHTML = `
    <div class="exam-card">
      <div class="exam-topbar">
        <div class="exam-progress-track"><div class="exam-progress-fill" style="width:${pct}%"></div></div>
        <span class="exam-progress-label">Frage ${current + 1} / ${questions.length}</span>
        <button class="exam-close-btn" id="exam-cancel" title="Abbrechen">&times;</button>
      </div>
      <div class="exam-question-body">
        <p class="exam-question-text">${esc(q.question)}</p>
        ${optHtml}
      </div>
      <div class="exam-meta">
        ${q.phase ? `<span class="search-badge badge-goal">${esc(q.phase)}</span>` : ""}
        <span class="exam-difficulty">${"●".repeat(q.difficulty || 1)}${"○".repeat(3 - (q.difficulty || 1))}</span>
      </div>
    </div>`;

  document.body.appendChild(ov);

  // Bind answer clicks
  ov.querySelectorAll(".exam-option, .exam-image-option").forEach(btn => {
    btn.addEventListener("click", () => handleExamAnswer(btn, opts, q));
  });

  // Cancel
  ov.querySelector("#exam-cancel").addEventListener("click", () => {
    if (confirm("Prüfung wirklich abbrechen?")) closeExam();
  });
}

function handleExamAnswer(btn, opts, q) {
  const idx = parseInt(btn.dataset.idx);
  let correct = false;

  if (q.type === "truefalse") {
    const trueIsCorrect = q._options.find(o => o.correct)?.text?.toLowerCase?.() === "richtig"
      || q._options[0]?.correct;
    correct = (idx === 0) === !!trueIsCorrect;
  } else {
    correct = !!opts[idx]?.correct;
  }

  _examState.answers.push({ question_id: q.id, chosen: idx, correct });

  // Visual feedback
  const allBtns = $$("#exam-overlay .exam-option, #exam-overlay .exam-image-option");
  allBtns.forEach(b => b.classList.add("disabled"));
  btn.classList.add(correct ? "exam-correct" : "exam-wrong");

  // Highlight correct one
  if (!correct) {
    allBtns.forEach((b, i) => {
      if (q.type === "truefalse") {
        const trueIsCorrect = q._options.find(o => o.correct)?.text?.toLowerCase?.() === "richtig" || q._options[0]?.correct;
        if ((i === 0) === !!trueIsCorrect) b.classList.add("exam-correct");
      } else if (opts[parseInt(b.dataset.idx)]?.correct) {
        b.classList.add("exam-correct");
      }
    });
  }

  // Auto-advance
  setTimeout(() => {
    _examState.current++;
    renderExamOverlay();
  }, correct ? 600 : 1200);
}

function renderExamResult(ov) {
  const { questions, answers, startedAt } = _examState;
  const score = answers.filter(a => a.correct).length;
  const wrong = answers.filter(a => !a.correct);
  const total = questions.length;
  const pct = Math.round((score / total) * 100);
  const passed = pct >= EXAM_PASS_PCT;
  const finishedAt = new Date().toISOString();
  const trainee = S.selectedTraineeId ? userName(S.selectedTraineeId) : (S.user?.display_name || "–");
  const dateStr = new Date(finishedAt).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  const timeStr = new Date(finishedAt).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });

  // Save
  const tid = S.selectedTraineeId || S.user?.id;
  if (tid) {
    DbEngine.run(
      "INSERT INTO exam_results (trainee_id,score,total,passed,answers,started_at,finished_at) VALUES (?,?,?,?,?,?,?)",
      [tid, score, total, passed ? 1 : 0, JSON.stringify(answers), startedAt, finishedAt]
    );
  }

  // Build error cards (only wrong answers)
  let errCards = "";
  if (wrong.length === 0) {
    errCards = `<div class="er-no-errors">Keine Fehler — alle Fragen richtig beantwortet.</div>`;
  } else {
    wrong.forEach((a, i) => {
      const q = questions.find(q => q.id === a.question_id);
      if (!q) return;
      const correctOpt = q._options.find(o => o.correct);
      const chosenOpt = q._options[a.chosen];
      errCards += `<div class="er-card">
        <div class="er-card-head">
          <span class="er-card-num">${i + 1}</span>
          <span class="er-card-q">${esc(q.question)}</span>
        </div>
        <div class="er-card-row er-wrong"><span class="er-label">Deine Antwort</span><span>${esc(chosenOpt?.text || "–")}</span></div>
        <div class="er-card-row er-right"><span class="er-label">Richtig</span><span>${esc(correctOpt?.text || "–")}</span></div>
        ${q.explanation ? `<div class="er-card-expl">${esc(q.explanation)}</div>` : ""}
      </div>`;
    });
  }

  ov.classList.add("exam-result-page");
  ov.innerHTML = `
    <div class="er-page">
      <div class="er-header">
        <span class="er-title">Prüfungsergebnis</span>
        <div class="er-header-actions">
          <button class="btn-secondary btn-sm" id="exam-retry">Wiederholen</button>
          <button class="btn-primary btn-sm" id="exam-close-result">Schliessen</button>
        </div>
      </div>
      <div class="er-layout">
        <aside class="er-sidebar">
          <div class="er-stat-block ${passed ? "er-pass" : "er-fail"}">
            <div class="er-verdict">${passed ? "Bestanden" : "Nicht bestanden"}</div>
            <div class="er-pct">${pct}%</div>
          </div>
          <div class="er-stats">
            <div class="er-stat"><span class="er-stat-label">Teilnehmer</span><span class="er-stat-val">${esc(trainee)}</span></div>
            <div class="er-stat"><span class="er-stat-label">Datum</span><span class="er-stat-val">${dateStr}, ${timeStr}</span></div>
            <div class="er-stat"><span class="er-stat-label">Fragen</span><span class="er-stat-val">${total}</span></div>
            <div class="er-stat"><span class="er-stat-label">Richtig</span><span class="er-stat-val er-val-ok">${score}</span></div>
            <div class="er-stat"><span class="er-stat-label">Falsch</span><span class="er-stat-val er-val-err">${wrong.length}</span></div>
            <div class="er-stat"><span class="er-stat-label">Bestehensgrenze</span><span class="er-stat-val">${EXAM_PASS_PCT}%</span></div>
          </div>
        </aside>
        <main class="er-main">
          <h2>Falsche Antworten <span>(${wrong.length})</span></h2>
          <div class="er-grid">${errCards}</div>
        </main>
      </div>
    </div>`;

  ov.querySelector("#exam-close-result").addEventListener("click", closeExam);
  ov.querySelector("#exam-retry").addEventListener("click", () => { closeExam(); startExam(); });
}

function closeExam() {
  _examState = null;
  const ov = $("#exam-overlay");
  if (ov) ov.remove();
}

/* ── Exam Editor (Admin/Trainer) ── */

function openExamEditor() {
  let ov = $("#exam-editor-overlay");
  if (ov) ov.remove();

  ov = document.createElement("div");
  ov.id = "exam-editor-overlay";
  ov.className = "exam-overlay";

  const questions = DbEngine.queryAll("SELECT q.*, cs.title AS section_title FROM exam_questions q LEFT JOIN content_sections cs ON q.section_id = cs.id ORDER BY q.created_at DESC");

  const sections = DbEngine.queryAll("SELECT id, title FROM content_sections WHERE parent_id IS NOT NULL ORDER BY position");
  const secOpts = sections.map(s => `<option value="${s.id}">${esc(s.title)}</option>`).join("");

  const phases = getPhases();
  const phaseOpts = phases.map(p => `<option value="${p.id}">${esc(p.label)}</option>`).join("");

  let listHtml = "";
  questions.forEach(q => {
    const opts = JSON.parse(q.options || "[]");
    listHtml += `<div class="exam-editor-item" data-id="${q.id}">
      <div class="exam-editor-item-head">
        <span class="search-badge badge-goal">${esc(q.phase || "–")}</span>
        <span class="exam-editor-q">${esc(q.question)}</span>
        <button class="exam-editor-edit" data-id="${q.id}" title="Bearbeiten">✎</button>
        <button class="exam-editor-del" data-id="${q.id}" title="Löschen">&times;</button>
      </div>
      <div class="exam-editor-item-detail">
        ${opts.map(o => `<span class="${o.correct ? "exam-opt-correct" : "exam-opt-wrong"}">${esc(o.text)}</span>`).join(" ")}
      </div>
    </div>`;
  });

  ov.innerHTML = `
    <div class="exam-card exam-editor-card">
      <div class="exam-topbar">
        <span class="exam-progress-label" style="font-weight:700">Fragen verwalten (${questions.length})</span>
        <button class="exam-close-btn" id="exam-editor-close">&times;</button>
      </div>

      <div class="exam-editor-form">
        <h3 id="eq-form-title">Neue Frage</h3>
        <input type="hidden" id="eq-edit-id" value="">
        <div class="exam-form-row">
          <select id="eq-phase" class="exam-form-select">${phaseOpts}</select>
          <select id="eq-section" class="exam-form-select"><option value="">– Sektion –</option>${secOpts}</select>
          <select id="eq-type" class="exam-form-select">
            <option value="single">Single Choice</option>
            <option value="truefalse">Wahr / Falsch</option>
          </select>
          <select id="eq-diff" class="exam-form-select">
            <option value="1">Leicht</option>
            <option value="2">Mittel</option>
            <option value="3">Schwer</option>
          </select>
        </div>
        <input type="text" id="eq-question" class="exam-form-input" placeholder="Frage eingeben...">
        <div id="eq-options-wrap">
          <div class="exam-form-opt"><input type="text" placeholder="Antwort A (richtig)" data-idx="0" class="exam-form-input eq-opt"><label><input type="radio" name="eq-correct" value="0" checked> ✓</label></div>
          <div class="exam-form-opt"><input type="text" placeholder="Antwort B" data-idx="1" class="exam-form-input eq-opt"><label><input type="radio" name="eq-correct" value="1"> ✓</label></div>
          <div class="exam-form-opt"><input type="text" placeholder="Antwort C" data-idx="2" class="exam-form-input eq-opt"><label><input type="radio" name="eq-correct" value="2"> ✓</label></div>
          <div class="exam-form-opt"><input type="text" placeholder="Antwort D" data-idx="3" class="exam-form-input eq-opt"><label><input type="radio" name="eq-correct" value="3"> ✓</label></div>
        </div>
        <input type="text" id="eq-explanation" class="exam-form-input" placeholder="Erklärung (optional)">
        <div class="exam-form-actions">
          <button class="btn-primary btn-sm" id="eq-save">Frage hinzufügen</button>
          <button class="btn-secondary btn-sm hidden" id="eq-cancel-edit">Abbrechen</button>
        </div>
      </div>

      <div class="exam-editor-list">${listHtml || '<p style="opacity:0.4;padding:12px">Noch keine Fragen.</p>'}</div>
    </div>`;

  document.body.appendChild(ov);

  const typeSelect = ov.querySelector("#eq-type");
  const optsWrap = ov.querySelector("#eq-options-wrap");
  const editIdField = ov.querySelector("#eq-edit-id");
  const formTitle = ov.querySelector("#eq-form-title");
  const saveBtn = ov.querySelector("#eq-save");
  const cancelBtn = ov.querySelector("#eq-cancel-edit");

  // Type change → toggle options
  typeSelect.addEventListener("change", () => {
    optsWrap.style.display = typeSelect.value === "truefalse" ? "none" : "";
  });

  // Reset form to "new" mode
  function resetForm() {
    editIdField.value = "";
    formTitle.textContent = "Neue Frage";
    saveBtn.textContent = "Frage hinzufügen";
    cancelBtn.classList.add("hidden");
    ov.querySelector("#eq-question").value = "";
    ov.querySelector("#eq-explanation").value = "";
    ov.querySelector("#eq-phase").selectedIndex = 0;
    ov.querySelector("#eq-section").selectedIndex = 0;
    typeSelect.value = "single";
    optsWrap.style.display = "";
    ov.querySelector("#eq-diff").value = "1";
    ov.querySelectorAll(".eq-opt").forEach((inp, i) => { inp.value = ""; });
    ov.querySelector("input[name=eq-correct][value='0']").checked = true;
    // Remove highlight from list
    ov.querySelectorAll(".exam-editor-item").forEach(el => el.classList.remove("editing"));
  }

  // Load question into form for editing
  function loadIntoForm(qId) {
    const q = questions.find(x => x.id === qId);
    if (!q) return;
    editIdField.value = q.id;
    formTitle.textContent = "Frage bearbeiten";
    saveBtn.textContent = "Änderung speichern";
    cancelBtn.classList.remove("hidden");

    ov.querySelector("#eq-question").value = q.question;
    ov.querySelector("#eq-explanation").value = q.explanation || "";
    ov.querySelector("#eq-phase").value = q.phase || phases[0]?.id;
    ov.querySelector("#eq-section").value = q.section_id || "";
    typeSelect.value = q.type || "single";
    ov.querySelector("#eq-diff").value = String(q.difficulty || 1);
    optsWrap.style.display = q.type === "truefalse" ? "none" : "";

    const opts = JSON.parse(q.options || "[]");
    ov.querySelectorAll(".eq-opt").forEach((inp, i) => {
      inp.value = opts[i]?.text || "";
      if (opts[i]?.correct) ov.querySelector(`input[name=eq-correct][value='${i}']`).checked = true;
    });

    // Highlight in list
    ov.querySelectorAll(".exam-editor-item").forEach(el => el.classList.toggle("editing", el.dataset.id === qId));

    // Scroll form into view
    ov.querySelector(".exam-editor-form").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  cancelBtn.addEventListener("click", resetForm);

  // Save (insert or update)
  saveBtn.addEventListener("click", () => {
    const question = ov.querySelector("#eq-question").value.trim();
    if (!question) return;

    const type = typeSelect.value;
    const phase = ov.querySelector("#eq-phase").value;
    const sectionId = ov.querySelector("#eq-section").value || null;
    const diff = parseInt(ov.querySelector("#eq-diff").value);
    const explanation = ov.querySelector("#eq-explanation").value.trim();

    let options;
    if (type === "truefalse") {
      options = [{ text: "Richtig", correct: true }, { text: "Falsch", correct: false }];
    } else {
      const correctIdx = parseInt(ov.querySelector("input[name=eq-correct]:checked")?.value || "0");
      options = [];
      ov.querySelectorAll(".eq-opt").forEach((inp, i) => {
        const t = inp.value.trim();
        if (t) options.push({ text: t, correct: i === correctIdx });
      });
      if (options.length < 2) {
        UIkit.notification({ message: "Mindestens 2 Antworten nötig", status: "warning", pos: "top-center" });
        return;
      }
    }

    const existingId = editIdField.value;
    if (existingId) {
      // Update
      DbEngine.run(
        "UPDATE exam_questions SET section_id=?, phase=?, type=?, question=?, options=?, explanation=?, difficulty=? WHERE id=?",
        [sectionId, phase, type, question, JSON.stringify(options), explanation, diff, existingId]
      );
      UIkit.notification({ message: "Frage aktualisiert", status: "success", pos: "top-center", timeout: 1500 });
    } else {
      // Insert
      const id = "eq-" + Date.now() + "-" + Math.random().toString(36).slice(2, 6);
      DbEngine.run(
        "INSERT INTO exam_questions VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        [id, sectionId, null, phase, type, question, JSON.stringify(options), explanation, diff, S.user?.id || null, new Date().toISOString()]
      );
      UIkit.notification({ message: "Frage hinzugefügt", status: "success", pos: "top-center", timeout: 1500 });
    }

    openExamEditor();
  });

  // Edit click
  ov.querySelectorAll(".exam-editor-edit").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      loadIntoForm(btn.dataset.id);
    });
  });

  // Delete
  ov.querySelectorAll(".exam-editor-del").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!confirm("Frage löschen?")) return;
      DbEngine.run("DELETE FROM exam_questions WHERE id = ?", [btn.dataset.id]);
      openExamEditor();
    });
  });

  // Close
  ov.querySelector("#exam-editor-close").addEventListener("click", () => {
    ov.remove();
    const qCount = $("#exam-q-count");
    if (qCount) {
      const cnt = DbEngine.queryAll("SELECT COUNT(*) AS c FROM exam_questions")[0]?.c || 0;
      qCount.textContent = cnt > 0 ? `${cnt} Fragen im Pool` : "Noch keine Fragen";
    }
  });
}

/* ── Exam Analysis ── */

function openExamAnalysis() {
  const tid = S.selectedTraineeId || S.user?.id;
  if (!tid) return;

  const trainee = userName(tid);
  const results = DbEngine.queryAll("SELECT * FROM exam_results WHERE trainee_id = ? ORDER BY finished_at ASC", [tid]);

  if (!results.length) {
    UIkit.notification({ message: "Noch keine Prüfungen vorhanden.", status: "warning", pos: "top-center" });
    return;
  }

  // Parse all answers across all exams
  const allAnswers = []; // { question_id, correct, exam_date }
  results.forEach(r => {
    const ans = JSON.parse(r.answers || "[]");
    ans.forEach(a => allAnswers.push({ ...a, exam_date: r.finished_at, exam_id: r.id }));
  });

  // Load all question metadata
  const qMap = {};
  DbEngine.queryAll("SELECT q.*, cs.title AS section_title FROM exam_questions q LEFT JOIN content_sections cs ON q.section_id = cs.id").forEach(q => {
    qMap[q.id] = q;
  });

  // Aggregate per question: how often wrong vs total
  const qStats = {}; // { [qId]: { question, phase, section, total, wrong } }
  allAnswers.forEach(a => {
    if (!qStats[a.question_id]) {
      const q = qMap[a.question_id];
      qStats[a.question_id] = {
        question: q?.question || "(gelöscht)",
        phase: q?.phase || "–",
        section: q?.section_title || "–",
        total: 0,
        wrong: 0,
      };
    }
    qStats[a.question_id].total++;
    if (!a.correct) qStats[a.question_id].wrong++;
  });

  // Sort by error rate desc
  const qRanked = Object.entries(qStats)
    .map(([id, s]) => ({ id, ...s, errorRate: s.total > 0 ? s.wrong / s.total : 0 }))
    .filter(q => q.wrong > 0)
    .sort((a, b) => b.errorRate - a.errorRate || b.wrong - a.wrong);

  // Aggregate per phase
  const phaseStats = {};
  allAnswers.forEach(a => {
    const q = qMap[a.question_id];
    const ph = q?.phase || "–";
    if (!phaseStats[ph]) phaseStats[ph] = { total: 0, wrong: 0 };
    phaseStats[ph].total++;
    if (!a.correct) phaseStats[ph].wrong++;
  });

  const phaseRanked = Object.entries(phaseStats)
    .map(([phase, s]) => ({ phase, ...s, errorRate: s.total > 0 ? s.wrong / s.total : 0 }))
    .sort((a, b) => b.errorRate - a.errorRate);

  // Aggregate per section
  const secStats = {};
  allAnswers.forEach(a => {
    const q = qMap[a.question_id];
    const sec = q?.section_title || "Ohne Zuordnung";
    if (!secStats[sec]) secStats[sec] = { total: 0, wrong: 0 };
    secStats[sec].total++;
    if (!a.correct) secStats[sec].wrong++;
  });

  const secRanked = Object.entries(secStats)
    .map(([section, s]) => ({ section, ...s, errorRate: s.total > 0 ? s.wrong / s.total : 0 }))
    .filter(s => s.wrong > 0)
    .sort((a, b) => b.errorRate - a.errorRate);

  // History table (with delete if allowed)
  const canDel = canDeleteExams(tid);
  let histRows = "";
  // Show newest first in history
  [...results].reverse().forEach(r => {
    const pct = Math.round((r.score / r.total) * 100);
    const date = r.finished_at ? new Date(r.finished_at).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" }) : "–";
    const passed = r.passed;
    const delBtn = canDel ? `<button class="ea-hist-del" data-exam-id="${r.id}" title="Löschen">&times;</button>` : "";
    histRows += `<tr>
      <td>${date}</td>
      <td>${r.score}/${r.total}</td>
      <td><span class="exam-hist-badge ${passed ? "exam-hist-pass" : "exam-hist-fail"}">${pct}%</span></td>
      ${canDel ? `<td class="exam-hist-del-cell">${delBtn}</td>` : ""}
    </tr>`;
  });
  const delAllBtn = canDel && results.length > 1
    ? `<button class="btn-secondary btn-xs ea-del-all" id="ea-del-all">Alle löschen</button>` : "";

  // Trend (score over time, chronological)
  let trendHtml = "";
  results.forEach((r, i) => {
    const pct = Math.round((r.score / r.total) * 100);
    const date = r.finished_at ? new Date(r.finished_at).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" }) : "–";
    const passed = r.passed;
    trendHtml += `<div class="ea-trend-item">
      <span class="ea-trend-date">${date}</span>
      <div class="ea-trend-bar-track">
        <div class="ea-trend-bar-fill ${passed ? "ea-bar-pass" : "ea-bar-fail"}" style="width:${pct}%"></div>
      </div>
      <span class="ea-trend-pct ${passed ? "er-val-ok" : "er-val-err"}">${pct}%</span>
    </div>`;
  });

  // Problem questions table
  let qTableHtml = "";
  if (qRanked.length === 0) {
    qTableHtml = `<p class="ea-empty">Keine wiederkehrenden Fehler gefunden.</p>`;
  } else {
    qRanked.forEach(q => {
      const errPct = Math.round(q.errorRate * 100);
      const barW = Math.max(errPct, 4);
      qTableHtml += `<div class="ea-q-row">
        <div class="ea-q-info">
          <span class="ea-q-text">${esc(q.question)}</span>
          <span class="ea-q-meta">${esc(q.phase)} · ${esc(q.section)}</span>
        </div>
        <div class="ea-q-stats">
          <span class="ea-q-count">${q.wrong}× falsch <span class="ea-q-of">/ ${q.total}</span></span>
          <div class="ea-q-bar-track"><div class="ea-q-bar-fill" style="width:${barW}%"></div></div>
          <span class="ea-q-pct">${errPct}%</span>
        </div>
      </div>`;
    });
  }

  // Phase overview
  let phaseHtml = "";
  phaseRanked.forEach(p => {
    const errPct = Math.round(p.errorRate * 100);
    phaseHtml += `<div class="ea-phase-row">
      <span class="ea-phase-label">${esc(p.phase)}</span>
      <div class="ea-phase-bar-track">
        <div class="ea-phase-bar-fill" style="width:${errPct}%"></div>
      </div>
      <span class="ea-phase-val">${p.wrong}/${p.total} <span>(${errPct}%)</span></span>
    </div>`;
  });

  // Section overview
  let secHtml = "";
  if (secRanked.length) {
    secRanked.forEach(s => {
      const errPct = Math.round(s.errorRate * 100);
      secHtml += `<div class="ea-phase-row">
        <span class="ea-phase-label ea-sec-label">${esc(s.section)}</span>
        <div class="ea-phase-bar-track">
          <div class="ea-phase-bar-fill" style="width:${errPct}%"></div>
        </div>
        <span class="ea-phase-val">${s.wrong}/${s.total} <span>(${errPct}%)</span></span>
      </div>`;
    });
  }

  // Build overlay
  let ov = $("#exam-analysis-overlay");
  if (ov) ov.remove();
  ov = document.createElement("div");
  ov.id = "exam-analysis-overlay";
  ov.className = "exam-overlay exam-result-page";

  const totalQ = allAnswers.length;
  const totalWrong = allAnswers.filter(a => !a.correct).length;
  const avgPct = results.length ? Math.round(results.reduce((s, r) => s + (r.score / r.total) * 100, 0) / results.length) : 0;
  const passCount = results.filter(r => r.passed).length;

  ov.innerHTML = `
    <div class="er-page">
      <div class="er-header">
        <span class="er-title">Schwächenanalyse: ${esc(trainee)}</span>
        <div class="er-header-actions">
          <button class="btn-primary btn-sm" id="ea-close">Schliessen</button>
        </div>
      </div>
      <div class="er-layout">
        <aside class="er-sidebar">
          <div class="er-stat-block ${avgPct >= EXAM_PASS_PCT ? "er-pass" : "er-fail"}">
            <div class="er-verdict">Durchschnitt</div>
            <div class="er-pct">${avgPct}%</div>
          </div>
          <div class="er-stats">
            <div class="er-stat"><span class="er-stat-label">Prüfungen</span><span class="er-stat-val">${results.length}</span></div>
            <div class="er-stat"><span class="er-stat-label">Bestanden</span><span class="er-stat-val er-val-ok">${passCount}</span></div>
            <div class="er-stat"><span class="er-stat-label">Nicht best.</span><span class="er-stat-val er-val-err">${results.length - passCount}</span></div>
            <div class="er-stat"><span class="er-stat-label">Fragen ges.</span><span class="er-stat-val">${totalQ}</span></div>
            <div class="er-stat"><span class="er-stat-label">Davon falsch</span><span class="er-stat-val er-val-err">${totalWrong}</span></div>
            <div class="er-stat"><span class="er-stat-label">Fehlerquote</span><span class="er-stat-val er-val-err">${totalQ ? Math.round(totalWrong / totalQ * 100) : 0}%</span></div>
          </div>

          <div class="ea-sidebar-section">
            <h4>Alle Prüfungen (${results.length})</h4>
            <table class="exam-history-table ea-hist-table"><tbody>${histRows}</tbody></table>
            ${delAllBtn}
          </div>

          <div class="ea-sidebar-section">
            <h4>Verlauf</h4>
            ${trendHtml}
          </div>

          <div class="ea-sidebar-section">
            <h4>Fehler nach Phase</h4>
            ${phaseHtml}
          </div>
        </aside>
        <main class="er-main">
          ${secHtml ? `<h2>Schwächen nach Themengebiet</h2>
          <div class="ea-section-list">${secHtml}</div>` : ""}

          <h2 style="${secHtml ? "margin-top:28px" : ""}">Problemfragen <span>(${qRanked.length})</span></h2>
          <div class="ea-questions-list">${qTableHtml}</div>
        </main>
      </div>
    </div>`;

  document.body.appendChild(ov);
  ov.querySelector("#ea-close").addEventListener("click", () => ov.remove());

  // Delete single exam result
  ov.querySelectorAll(".ea-hist-del").forEach(btn => {
    btn.addEventListener("click", () => {
      if (!confirm("Prüfungsergebnis löschen?")) return;
      DbEngine.run("DELETE FROM exam_results WHERE id = ?", [parseInt(btn.dataset.examId)]);
      ov.remove();
      openExamAnalysis(); // reload
    });
  });

  // Delete all
  const delAll = ov.querySelector("#ea-del-all");
  if (delAll) delAll.addEventListener("click", () => {
    if (!confirm("Alle Prüfungsergebnisse für diesen Schüler löschen?")) return;
    DbEngine.run("DELETE FROM exam_results WHERE trainee_id = ?", [tid]);
    ov.remove();
  });
}

/* ── End Exam Mode ── */

async function boot() {
  loadPrefs();
  applyTheme(S.prefs.theme);
  applyFont(S.prefs.font);
  bindGlobalEvents();
  setupDevLock();
  setupGuards();

  // Save status callback
  DbEngine.onSaveStatus = updateSaveStatus;
  DbEngine.onConnectionLost = (err) => {
    console.error("NAS connection lost:", err);
    showSaveError();
  };

  // Try to reconnect – DB is ALWAYS available after this (from file or seed)
  const status = await DbEngine.tryReconnect();
  reloadState();
  await restoreSession();

  const spinner = $("#loading-spinner");
  if (spinner) spinner.remove();

  if (status === "connected") {
    updateSaveStatus("saved");
  } else {
    // Not connected → app works (read from seed), but saves disabled
    showNasBar(status);
  }

  setupShiftLogout();
  if (S.user) initApp();
  else redirectToLogin();
}

boot();
