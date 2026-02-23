/* ================================================================
   SchulungsHub v3 – Application Logic
   Single-Page ScrollSpy, Markdown, Built-in Editor
   ================================================================ */

/* ── 1. Config ── */
const SESSION_KEY = "schulungsHub.session";
const PREFS_KEY   = "schulungsHub.prefs";
const SYNC_INTERVAL = 300000; // 5 min
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
  syncTimer: null,
  syncState: "local",
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

/* ── 5. Data Access (sql.js + File System Access API via DbEngine) ── */

function normalizeDb(raw) {
  const db = deepClone(raw || {});
  db.meta = db.meta || {};
  db.meta.schema_version = 3;
  db.meta.updated_at = db.meta.updated_at || nowIso();
  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.machines)) db.machines = [];
  if (!Array.isArray(db.content_sections)) db.content_sections = [];
  if (!Array.isArray(db.learning_goals)) db.learning_goals = [];
  if (!Array.isArray(db.evaluations)) db.evaluations = [];
  if (!db.trainee_meta) db.trainee_meta = {};
  db.users.forEach(u => { if (u.active === undefined) u.active = true; });
  db.machines.sort((a, b) => (a.position || 0) - (b.position || 0));
  db.learning_goals.sort((a, b) => (a.position || 0) - (b.position || 0));
  db.content_sections.sort((a, b) => (a.position || 0) - (b.position || 0));
  return db;
}

async function loadDb() {
  await DbEngine.init();
  return normalizeDb(DbEngine.toJson());
}

function persistDb() {
  S.db.meta.updated_at = nowIso();
  DbEngine.fromJson(S.db);
  DbEngine.persist();
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

/* ── 9. Sync Engine (direct SQLite file on NAS) ── */
async function connectFile() {
  if (!window.showOpenFilePicker) {
    notify("File System Access API nicht verfügbar. Bitte Chrome/Edge verwenden (kein file://, kein Firefox).", "warning");
    return;
  }
  try {
    await DbEngine.connect();
    S.db = normalizeDb(DbEngine.toJson());
    startSyncTimer();
    setSyncState("connected");
    refreshAll();
    notify("Datenbank verbunden!", "success");
  } catch (e) {
    if (e.name !== "AbortError") {
      setSyncState("error");
      notify("Verbindung fehlgeschlagen: " + e.message, "danger");
    }
  }
}

async function disconnectFile() {
  stopSyncTimer();
  DbEngine.disconnect();
  setSyncState("local");
}

async function requestFilePermission() {
  try {
    const granted = await DbEngine.requestPermission();
    if (granted) {
      S.db = normalizeDb(DbEngine.toJson());
      startSyncTimer();
      setSyncState("connected");
      refreshAll();
      return true;
    }
  } catch { /* */ }
  return false;
}

async function syncTick() {
  if (!DbEngine.connected) return;
  try {
    setSyncState("syncing");
    const remote = await DbEngine.readRemoteJson();
    if (remote) {
      const remoteNorm = normalizeDb(remote);
      mergeDb(remoteNorm);
    }
    persistDb(); // Writes merged data to file + localStorage
    setSyncState("connected");
    refreshAll();
  } catch (e) {
    console.warn("Sync error:", e);
    setSyncState("error");
  }
}

function mergeDb(remote) {
  const seen = new Set();
  const merged = [];
  [...(S.db.evaluations || []), ...(remote.evaluations || [])].forEach(e => {
    const fp = `${e.trainee_id}|${e.goal_id}|${e.evaluated_at}|${e.evaluated_by}`;
    if (!seen.has(fp)) { seen.add(fp); merged.push(e); }
  });
  S.db.evaluations = merged;

  const uMap = {};
  [...(S.db.users || []), ...(remote.users || [])].forEach(u => {
    if (!uMap[u.id] || new Date(u.created_at || 0) > new Date(uMap[u.id].created_at || 0)) uMap[u.id] = u;
  });
  S.db.users = Object.values(uMap);

  if (remote.content_sections && remote.content_sections.length) {
    const localMap = {};
    (S.db.content_sections || []).forEach(s => { localMap[s.id] = s; });
    remote.content_sections.forEach(rs => {
      if (!localMap[rs.id] || (rs.updated_at && rs.updated_at > (localMap[rs.id].updated_at || ""))) localMap[rs.id] = rs;
    });
    S.db.content_sections = Object.values(localMap).sort((a, b) => (a.position || 0) - (b.position || 0));
  }

  Object.assign(S.db.trainee_meta, remote.trainee_meta || {});
}

function startSyncTimer() { stopSyncTimer(); S.syncTimer = setInterval(syncTick, SYNC_INTERVAL); }
function stopSyncTimer() { if (S.syncTimer) { clearInterval(S.syncTimer); S.syncTimer = null; } }

function setSyncState(state) {
  S.syncState = state;
  const el = $("#sync-indicator");
  if (!el) return;
  el.dataset.state = state;

  // Hide completely when local – show only when connected/syncing/error
  if (state === "local") {
    el.classList.add("hidden");
  } else {
    el.classList.remove("hidden");
    const labels = { connected: "Verbunden", syncing: "Sync...", error: "Fehler" };
    $("#sync-label").textContent = labels[state] || "";
  }
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
    const u = S.db.users.find(x => x.id === S.user.id);
    if (u) { u.theme = theme; persistDb(); }
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
    h += `<a class="nav-link" data-target="sec-phase-${p.id}">
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
  persistDb();
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
  persistDb();
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
  persistDb();
  refreshAll();
}

function reassignGoal(goalId, field, value) {
  const goal = S.db.learning_goals.find(g => g.id === goalId);
  if (!goal) return;
  goal[field] = value;
  // Reset position to end of new group
  const siblings = S.db.learning_goals.filter(g =>
    g.phase === goal.phase && g.machine_id === goal.machine_id && g.id !== goalId);
  goal.position = siblings.length ? Math.max(...siblings.map(g => g.position || 0)) + 1 : 0;
  persistDb();
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
    phaseHtml += `<div class="phase-bar-wrap">
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
        ${canVerify() ? '<button class="btn-primary btn-sm" id="btn-report" type="button" style="margin-top:20px">Bericht erstellen</button>' : ""}
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
      <details class="machine-group" ${sm || mGoals.length <= 8 ? "open" : ""}>
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

  // Inline fields for trainers (always visible)
  let fieldsHtml = "";
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

  return `<div class="goal-row${fieldsHtml ? ' has-fields' : ''}${sm ? ' sort-active' : ''}" data-goal-id="${goal.id}" data-score="${score}">
    <div class="goal-row-main">
      ${sm ? '' : `<div class="rating-pill">${segs}</div>`}
      <span class="goal-row-title">${esc(goal.title)}</span>
      <span class="goal-row-meta">${meta}</span>
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
  const fsaAvailable = !!window.showOpenFilePicker;
  const fsaHint = fsaAvailable ? "" : '<p style="font-size:12px;opacity:0.5;margin-top:8px">File System Access API nicht verfügbar. NAS-Sync braucht Chrome/Edge (kein file://).</p>';
  return `
    <div class="doc-section" id="sec-daten">
      <h2>Datenverwaltung</h2>
      <div class="daten-actions">
        <button class="btn-secondary btn-sm" id="btn-connect-page" ${fsaAvailable ? "" : "disabled"}>${DbEngine.connected ? '✕ Trennen' : '↗ data.db verbinden'}</button>
        <button class="btn-secondary btn-sm" id="btn-export-db">↓ SQLite DB exportieren</button>
        <button class="btn-secondary btn-sm" id="btn-backup-page">↓ JSON Backup</button>
        <button class="btn-secondary btn-sm" id="btn-import-page">↑ Import</button>
      </div>
      ${fsaHint}
    </div>`;
}

/* ── 16. Page Event Binding ── */
function bindPageEvents() {
  const pane = $("#content-pane");

  // Report button
  const reportBtn = $("#btn-report");
  if (reportBtn) reportBtn.addEventListener("click", generateReport);

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
  const connPage = $("#btn-connect-page");
  if (connPage) connPage.addEventListener("click", () => DbEngine.connected ? disconnectFile() : connectFile());
  const exportDb = $("#btn-export-db");
  if (exportDb) exportDb.addEventListener("click", exportSqliteDb);
  const backupPage = $("#btn-backup-page");
  if (backupPage) backupPage.addEventListener("click", downloadBackup);
  const impPage = $("#btn-import-page");
  if (impPage) impPage.addEventListener("click", handleImport);

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

  const ev = {
    id: nextId(S.db.evaluations),
    trainee_id: S.selectedTraineeId,
    goal_id: goalId,
    score,
    error_rate: errorRate || 0,
    comment: (comment || "").trim(),
    action: (action || "").trim(),
    evaluated_by: S.user.id,
    evaluated_at: nowIso(),
  };

  S.db.evaluations.push(ev);
  persistDb();
  S.evalMap[goalId] = ev;
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
        <button type="button" data-wrap="\`" title="Code">Code</button>
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
      updatePreview();
    });
  });

  // Save
  container.querySelector(".editor-save-btn").addEventListener("click", () => {
    sec.content_md = textarea.value;
    sec.updated_at = nowIso();
    persistDb();
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
      persistDb();
      // Update sidebar
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

function handleAddSection() {
  const title = prompt("Titel der neuen Sektion:");
  if (!title || !title.trim()) return;

  const id = title.trim().toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-").replace(/^-|-$/g, "");
  const sections = S.db.content_sections || [];
  const maxPos = sections.reduce((m, s) => Math.max(m, s.position || 0), 0);

  sections.push({
    id: id || `sec-${Date.now()}`,
    title: title.trim(),
    content_md: "",
    position: maxPos + 1,
    children: [],
    updated_at: nowIso(),
  });

  persistDb();
  renderSidebar();
  renderPage();
  notify("Sektion erstellt!", "success");

  // Scroll to new section
  setTimeout(() => {
    const el = document.getElementById(`sec-${id}`);
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
  const blob = new Blob([JSON.stringify(S.db, null, 2)], { type: "application/json" });
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

function importJson(text) {
  S.db = normalizeDb(JSON.parse(text));
  persistDb();
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
}

function updateTraineeSelect() {
  const sel = $("#trainee-select");
  if (!canVerify()) { sel.classList.add("hidden"); return; }
  sel.classList.remove("hidden");
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
  delete user.must_change_password;
  persistDb();

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
  persistDb();
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
    const idx = S.db.users.findIndex(u => String(u.id) === String(userId));
    if (idx === -1) { notify("User nicht gefunden!", "warning"); return; }
    S.db.users[idx].rfid_hash = hash;
    persistDb();
    console.log("RFID saved:", { userId, scannedTag, hash, stored: S.db.users[idx].rfid_hash });
    notify(`RFID-Chip für ${S.db.users[idx].display_name} gespeichert.`, "success");
    dlg.close();
    renderUserManagementDialog();
  });

  newCancel.addEventListener("click", () => dlg.close());

  if (user.rfid_hash) {
    newRemove.addEventListener("click", () => {
      user.rfid_hash = "";
      persistDb();
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
function handleDeleteUser(userId) {
  if (!canVerify()) return;
  const user = S.db.users.find(u => u.id === userId);
  if (!user || user.id === S.user.id) return;

  // Permission check: admin can delete anyone, trainer only own trainees
  if (!canAdmin() && !(user.role === "trainee" && user.created_by === S.user.id)) return;

  if (!confirm(`"${user.display_name}" wirklich entfernen?`)) return;

  // Remove user
  S.db.users = S.db.users.filter(u => u.id !== userId);
  // Remove their evaluations
  S.db.evaluations = S.db.evaluations.filter(e => e.trainee_id !== userId);
  // Clean trainee_meta
  delete S.db.trainee_meta[userId];

  persistDb();
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

  S.db.users.push({
    id: nextId(S.db.users),
    username: uname,
    display_name: displayName,
    initials,
    role,
    active: true,
    password_hash: passwordHash,
    rfid_hash: rfidHash,
    must_change_password: true,
    created_by: S.user.id,
    created_at: nowIso(),
  });

  persistDb();
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
  const chip = $("#user-chip");
  if (chip) chip.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!S.user) return;
    const dd = $("#user-dropdown");
    if (dd) {
      dd.classList.toggle("hidden");
      // Hide "Benutzer anlegen" + "Benutzer ändern" for trainees
      const addItem = $("#menu-add-user");
      if (addItem) addItem.classList.toggle("hidden", !canVerify());
      const manageItem = $("#menu-manage-users");
      if (manageItem) manageItem.classList.toggle("hidden", !canVerify());
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

  const sel = $("#trainee-select");
  if (sel) sel.addEventListener("change", () => {
    S.selectedTraineeId = parseInt(sel.value, 10);
    S.evalMap = buildEvalMap(S.selectedTraineeId);
    refreshAll();
  });

  const tb = $("#theme-toggle");
  if (tb) tb.addEventListener("click", toggleThemeReveal);

  $$(".font-switcher button").forEach(b => b.addEventListener("click", () => applyFont(b.dataset.font)));

  const saveBtn = $("#save-btn");
  if (saveBtn) saveBtn.addEventListener("click", () => {
    saveBtn.classList.add("saving");
    saveBtn.querySelector(".save-label").textContent = "Speichert…";
    persistDb();
    setTimeout(() => {
      saveBtn.classList.remove("saving");
      saveBtn.classList.add("saved");
      saveBtn.querySelector(".save-label").textContent = "Gespeichert!";
      setTimeout(() => {
        saveBtn.classList.remove("saved");
        saveBtn.querySelector(".save-label").textContent = "Speichern";
      }, 1500);
    }, 300);
  });

  const sync = $("#sync-indicator");
  if (sync) sync.addEventListener("click", () => DbEngine.connected ? disconnectFile() : connectFile());

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
  if (cpd) cpd.addEventListener("cancel", e => { if (S.user?.must_change_password && S.user?.role !== "trainee") e.preventDefault(); });

  // User management dialog close
  const umClose = $("#usermgmt-close");
  if (umClose) umClose.addEventListener("click", () => $("#usermgmt-dialog").close());

  const fi = $("#import-file-input");
  if (fi) fi.addEventListener("change", async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    try { importJson(await file.text()); } catch { notify("Import fehlgeschlagen.", "danger"); }
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
}

function updateHeaderNav() {
  const datenLink = $("#nav-daten");
  if (datenLink) datenLink.classList.toggle("hidden", !canAdmin());
}

async function boot() {
  S.db = await loadDb();
  loadPrefs();
  applyTheme(S.prefs.theme);
  applyFont(S.prefs.font);
  await restoreSession();
  bindGlobalEvents();
  setupDevLock();
  setupShiftLogout();

  // Callback wenn Datei-Schreibzugriff fehlschlägt
  DbEngine.onWriteFail = () => {
    stopSyncTimer();
    setSyncState("local");
    notify("Schreibzugriff verloren. Bitte erneut verbinden.", "warning");
  };

  // Auto-reconnect to NAS file if handle was stored
  if (DbEngine.connected) {
    startSyncTimer();
    setSyncState("connected");
  } else if (DbEngine.hasStoredHandle) {
    // Handle exists but permission expired → will need user click
    setSyncState("local");
  }

  const spinner = $("#loading-spinner");
  if (spinner) spinner.remove();

  if (S.user) initApp();
  else redirectToLogin();
}

boot();
