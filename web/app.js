/* ================================================================
   SchulungsHub v2 – Application Logic
   Auth, Sync, 5-Step Rating, Navigation, Dashboard, Report
   ================================================================ */

/* ---------- 1. Constants & Config ---------- */
const STORAGE_KEY = "schulungsHub.db.v2";
const SESSION_KEY = "schulungsHub.session";
const PREFS_KEY = "schulungsHub.prefs";
const SYNC_INTERVAL = 15000;

const PHASES = [
  { id: "P1", label: "P1: Grundlagen", color: "#0d9488" },
  { id: "P2", label: "P2: Fortgeschritten", color: "#3b82f6" },
  { id: "P3", label: "P3: Experte", color: "#8b5cf6" },
  { id: "P4", label: "P4: Spezialist", color: "#f59e0b" },
  { id: "Mes", label: "MES", color: "#ec4899" },
];

const SCORE_STEPS = [0, 25, 50, 75, 100];

/* ---------- 2. State ---------- */
const S = {
  db: null,
  user: null,
  trainees: [],
  selectedTraineeId: null,
  evalMap: {},          // { "traineeId|goalId": latestEval }
  syncHandle: null,     // File System Access handle
  syncTimer: null,
  syncState: "local",   // local|connected|syncing|error
  prefs: { theme: "light", font: "M" },
  loginMode: "password",
  renderedPhases: new Set(),
  sectionObserver: null,
  fadeObserver: null,
};

/* ---------- 3. Utilities ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

function nowIso() { return new Date().toISOString(); }
function deepClone(v) { return JSON.parse(JSON.stringify(v)); }

function escapeHtml(s) {
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
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function nextId(arr) {
  if (!arr || !arr.length) return 1;
  return arr.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
}

/* ---------- 4. Crypto (PBKDF2-SHA256) ---------- */
function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(password, saltHex, iterations) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}

async function verifyPassword(password, storedHash) {
  const p = String(storedHash || "").split("$");
  if (p.length !== 4 || p[0] !== "pbkdf2_sha256") return false;
  const iter = parseInt(p[1], 10);
  if (!iter || iter <= 0) return false;
  const candidate = await pbkdf2(password, p[2], iter);
  return timingSafeEqual(candidate, p[3]);
}

async function createPasswordHash(password) {
  const iter = 120000;
  const salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  const digest = await pbkdf2(password, salt, iter);
  return `pbkdf2_sha256$${iter}$${salt}$${digest}`;
}

async function sha256Hex(text) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return bytesToHex(new Uint8Array(buf));
}

/* ---------- 5. Data Access ---------- */
function normalizeDb(raw) {
  const db = deepClone(raw || {});
  db.meta = db.meta || {};
  db.meta.schema_version = 2;
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

function loadDb() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw) {
    try { return normalizeDb(JSON.parse(raw)); } catch { /* ignore */ }
  }
  return normalizeDb(window.FI_TEACH_DEFAULT_DATA || {});
}

function persistDb() {
  S.db.meta.updated_at = nowIso();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(S.db));
}

function allUsers() { return (S.db?.users || []).filter(u => u.active !== false); }

function allTrainees() {
  return allUsers().filter(u => u.role === "trainee").sort((a, b) => a.display_name.localeCompare(b.display_name, "de"));
}

function findUser(id) { return allUsers().find(u => u.id === id) || null; }
function userName(id) { const u = findUser(id); return u ? u.display_name : "?"; }
function canVerify() { return S.user && (S.user.role === "admin" || S.user.role === "trainer"); }
function canAdmin() { return S.user && S.user.role === "admin"; }

function machineLabel(id) {
  const m = (S.db?.machines || []).find(m => m.id === id);
  return m ? m.label : id;
}

/* ---------- 6. Evaluation Queries ---------- */
function buildEvalMap(traineeId) {
  const map = {};
  const evals = (S.db.evaluations || [])
    .filter(e => e.trainee_id === traineeId)
    .sort((a, b) => new Date(a.evaluated_at) - new Date(b.evaluated_at));
  evals.forEach(e => { map[e.goal_id] = e; });
  return map;
}

function goalScore(goalId) {
  const ev = S.evalMap[goalId];
  return ev ? (ev.score || 0) : 0;
}

function computePhaseProgress(phaseId) {
  const goals = S.db.learning_goals.filter(g => g.phase === phaseId);
  if (!goals.length) return 0;
  const total = goals.reduce((s, g) => s + goalScore(g.id), 0);
  return total / goals.length;
}

function computeMachineProgress(phaseId, machineId) {
  const goals = S.db.learning_goals.filter(g => g.phase === phaseId && g.machine_id === machineId);
  if (!goals.length) return 0;
  const total = goals.reduce((s, g) => s + goalScore(g.id), 0);
  return total / goals.length;
}

function computeOverallProgress() {
  const goals = S.db.learning_goals;
  if (!goals.length) return 0;
  const total = goals.reduce((s, g) => s + goalScore(g.id), 0);
  return total / goals.length;
}

function computeEta() {
  if (!S.selectedTraineeId) return null;
  const evals = (S.db.evaluations || [])
    .filter(e => e.trainee_id === S.selectedTraineeId && e.score > 0)
    .sort((a, b) => new Date(a.evaluated_at) - new Date(b.evaluated_at));
  if (evals.length < 2) return null;

  const first = new Date(evals[0].evaluated_at);
  const overall = computeOverallProgress();
  if (overall <= 0 || overall >= 100) return null;

  const elapsed = Math.max((Date.now() - first.getTime()) / (1000 * 3600 * 24), 1);
  const pacePerDay = overall / elapsed;
  if (pacePerDay <= 0) return null;

  const remaining = 100 - overall;
  const days = Math.ceil(remaining / pacePerDay);
  return new Date(Date.now() + days * 86400000);
}

function recentHistory(limit = 20) {
  if (!S.selectedTraineeId) return [];
  return (S.db.evaluations || [])
    .filter(e => e.trainee_id === S.selectedTraineeId)
    .sort((a, b) => new Date(b.evaluated_at) - new Date(a.evaluated_at))
    .slice(0, limit);
}

/* ---------- 7. Auth ---------- */
async function loginPassword(username, password) {
  const u = allUsers().find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!u) return null;
  return (await verifyPassword(password, u.password_hash)) ? u : null;
}

function loginRfid(tagHash) {
  const h = tagHash.trim().toLowerCase();
  return allUsers().find(u => (u.rfid_hash || "").toLowerCase() === h) || null;
}

function setSession(user) {
  S.user = user;
  if (user) sessionStorage.setItem(SESSION_KEY, String(user.id));
  else sessionStorage.removeItem(SESSION_KEY);
}

function restoreSession() {
  const id = parseInt(sessionStorage.getItem(SESSION_KEY), 10);
  if (id) { const u = findUser(id); if (u) { S.user = u; return; } }
  S.user = null;
}

/* ---------- 8. Sync Engine ---------- */
async function connectFile() {
  if (!window.showOpenFilePicker) {
    UIkit.notification("File System Access API nicht verfügbar. Nutze Import/Export.", { status: "warning" });
    return;
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{ description: "Schulungsdaten", accept: { "application/json": [".json"] } }],
    });
    S.syncHandle = handle;
    await syncTick();
    startSyncTimer();
    setSyncState("connected");
  } catch (e) {
    if (e.name !== "AbortError") setSyncState("error");
  }
}

async function disconnectFile() {
  stopSyncTimer();
  S.syncHandle = null;
  setSyncState("local");
}

async function syncTick() {
  if (!S.syncHandle) return;
  try {
    setSyncState("syncing");
    const file = await S.syncHandle.getFile();
    const text = await file.text();
    const remote = normalizeDb(JSON.parse(text));
    mergeDb(remote);
    persistDb();
    // Write back
    const writable = await S.syncHandle.createWritable();
    await writable.write(JSON.stringify(S.db, null, 2));
    await writable.close();
    setSyncState("connected");
    refreshAll();
  } catch (e) {
    console.warn("Sync error:", e);
    setSyncState("error");
  }
}

function mergeDb(remote) {
  // Union-merge evaluations (append-only)
  const localEvals = S.db.evaluations || [];
  const remoteEvals = remote.evaluations || [];
  const seen = new Set();
  const merged = [];
  [...localEvals, ...remoteEvals].forEach(e => {
    const fp = `${e.trainee_id}|${e.goal_id}|${e.evaluated_at}|${e.evaluated_by}`;
    if (!seen.has(fp)) { seen.add(fp); merged.push(e); }
  });
  S.db.evaluations = merged;

  // Merge users: keep union, prefer newer
  const userMap = {};
  [...(S.db.users || []), ...(remote.users || [])].forEach(u => {
    if (!userMap[u.id] || new Date(u.created_at || 0) > new Date(userMap[u.id].created_at || 0)) {
      userMap[u.id] = u;
    }
  });
  S.db.users = Object.values(userMap);

  // Merge trainee_meta
  Object.assign(S.db.trainee_meta, remote.trainee_meta || {});
}

function startSyncTimer() {
  stopSyncTimer();
  S.syncTimer = setInterval(syncTick, SYNC_INTERVAL);
}

function stopSyncTimer() {
  if (S.syncTimer) { clearInterval(S.syncTimer); S.syncTimer = null; }
}

function setSyncState(state) {
  S.syncState = state;
  const el = $("#sync-indicator");
  if (el) {
    el.dataset.state = state;
    const labels = { local: "Lokal", connected: "Verbunden", syncing: "Sync...", error: "Fehler" };
    $("#sync-label").textContent = labels[state] || state;
  }
}

/* ---------- 9. Preferences ---------- */
function loadPrefs() {
  try { Object.assign(S.prefs, JSON.parse(localStorage.getItem(PREFS_KEY))); } catch { /* ignore */ }
}

function savePrefs() {
  localStorage.setItem(PREFS_KEY, JSON.stringify(S.prefs));
}

function applyTheme(theme) {
  S.prefs.theme = theme;
  document.documentElement.dataset.theme = theme;
  savePrefs();
}

function applyFont(size) {
  S.prefs.font = size;
  document.documentElement.dataset.font = size;
  $$(".font-switcher button").forEach(b => b.classList.toggle("active", b.dataset.font === size));
  savePrefs();
}

function toggleThemeWithReveal(event) {
  const newTheme = S.prefs.theme === "light" ? "dark" : "light";
  const overlay = $("#theme-reveal");

  if (!overlay || !document.startViewTransition) {
    // Simple fallback
    applyTheme(newTheme);
    return;
  }

  // Circular reveal animation
  const rect = event.currentTarget.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  overlay.style.setProperty("--cx", cx + "px");
  overlay.style.setProperty("--cy", cy + "px");
  overlay.className = `theme-reveal-overlay ${newTheme}`;

  requestAnimationFrame(() => {
    overlay.classList.add("active");
    setTimeout(() => {
      applyTheme(newTheme);
      overlay.classList.remove("active");
      setTimeout(() => { overlay.className = "theme-reveal-overlay"; }, 100);
    }, 500);
  });
}

/* ---------- 10. UI Rendering: Sidebar ---------- */
function renderSidebar() {
  const html = buildSidebarHtml();
  $("#sidebar-desktop").innerHTML = html;
  const mobileContent = $("#sidebar-mobile-content");
  if (mobileContent) mobileContent.innerHTML = html;
  bindSidebarEvents();
}

function buildSidebarHtml() {
  let html = "";

  // Admin buttons
  if (canAdmin()) {
    html += `<div style="margin-bottom:0.8rem">
      <button class="uk-button uk-button-default uk-button-small uk-width-1-1" id="btn-add-user" type="button">
        <span uk-icon="icon: user; ratio:0.8"></span> Benutzer anlegen
      </button>
    </div>`;
  }

  // Content TOC
  html += `<div class="sidebar-section-title">Lerninhalte</div>`;
  (S.db.content_sections || []).forEach(sec => {
    html += `<a class="content-nav-link" href="#content-${sec.id}" data-content-id="${sec.id}">${escapeHtml(sec.id)}. ${escapeHtml(sec.title)}</a>`;
    (sec.children || []).forEach(ch => {
      html += `<a class="content-nav-link child" href="#content-${ch.id}" data-content-id="${ch.id}">${escapeHtml(ch.id)} ${escapeHtml(ch.title)}</a>`;
    });
  });

  // Phase / Checkpoint navigation
  html += `<div class="sidebar-section-title" style="margin-top:1.2rem">Bewertung nach Phase</div>`;
  PHASES.forEach(phase => {
    const pct = Math.round(computePhaseProgress(phase.id));
    const level = pct >= 100 ? "done" : pct >= 65 ? "high" : pct >= 25 ? "mid" : "low";
    const machines = getMachinesForPhase(phase.id);

    html += `<div class="phase-nav-item" data-phase="${phase.id}">`;
    html += `<div class="phase-header"><span class="phase-label">${escapeHtml(phase.label)}</span><span class="phase-badge" data-level="${level}">${pct}%</span></div>`;
    html += `<div class="phase-children">`;
    machines.forEach(mid => {
      const mpct = Math.round(computeMachineProgress(phase.id, mid));
      html += `<a class="machine-link" href="#phase-${phase.id}-${mid}" data-phase="${phase.id}" data-machine="${mid}">
        ${escapeHtml(machineLabel(mid))} <small>${mpct}%</small></a>`;
    });
    html += `</div></div>`;
  });

  // Sync + Backup section
  html += `<div class="sidebar-section-title" style="margin-top:1.2rem">Datenverwaltung</div>`;
  html += `<div style="display:grid;gap:0.35rem">`;
  html += `<button class="uk-button uk-button-default uk-button-small uk-width-1-1" id="btn-connect-file" type="button">
    <span uk-icon="icon: link; ratio:0.8"></span> Datei verbinden</button>`;
  html += `<button class="uk-button uk-button-default uk-button-small uk-width-1-1" id="btn-disconnect-file" type="button" style="display:none">
    <span uk-icon="icon: close; ratio:0.8"></span> Verbindung trennen</button>`;
  html += `<button class="uk-button uk-button-default uk-button-small uk-width-1-1" id="btn-backup" type="button">
    <span uk-icon="icon: download; ratio:0.8"></span> Backup herunterladen</button>`;
  html += `<button class="uk-button uk-button-default uk-button-small uk-width-1-1" id="btn-import" type="button">
    <span uk-icon="icon: upload; ratio:0.8"></span> JSON importieren</button>`;
  html += `</div>`;

  return html;
}

function getMachinesForPhase(phaseId) {
  const ids = new Set();
  S.db.learning_goals.filter(g => g.phase === phaseId).forEach(g => ids.add(g.machine_id));
  const order = {};
  (S.db.machines || []).forEach(m => { order[m.id] = m.position || 99; });
  return [...ids].sort((a, b) => (order[a] || 99) - (order[b] || 99));
}

function bindSidebarEvents() {
  // Phase expand/collapse
  $$(".phase-header").forEach(el => {
    el.addEventListener("click", () => {
      const item = el.closest(".phase-nav-item");
      item.classList.toggle("open");
    });
  });

  // Content nav scroll
  $$(".content-nav-link").forEach(el => {
    el.addEventListener("click", e => {
      e.preventDefault();
      const target = document.getElementById(el.getAttribute("href").slice(1));
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      // Close offcanvas on mobile
      const oc = UIkit.offcanvas("#sidebar-offcanvas");
      if (oc && oc.isToggled()) oc.hide();
    });
  });

  // Machine links scroll
  $$(".machine-link").forEach(el => {
    el.addEventListener("click", e => {
      e.preventDefault();
      const phase = el.dataset.phase;
      const machine = el.dataset.machine;
      ensurePhaseRendered(phase);
      const target = document.getElementById(`phase-${phase}-${machine}`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      const oc = UIkit.offcanvas("#sidebar-offcanvas");
      if (oc && oc.isToggled()) oc.hide();
    });
  });

  // Admin button
  const addUserBtn = $("#btn-add-user");
  if (addUserBtn) addUserBtn.addEventListener("click", () => $("#admin-dialog").showModal());

  // Sync buttons
  const connectBtn = $("#btn-connect-file");
  const disconnectBtn = $("#btn-disconnect-file");
  const backupBtn = $("#btn-backup");
  const importBtn = $("#btn-import");

  if (connectBtn) connectBtn.addEventListener("click", connectFile);
  if (disconnectBtn) disconnectBtn.addEventListener("click", disconnectFile);
  if (backupBtn) backupBtn.addEventListener("click", downloadBackup);
  if (importBtn) importBtn.addEventListener("click", handleImport);
}

/* ---------- 11. UI Rendering: Content Pane ---------- */
function renderContentPane() {
  const pane = $("#content-pane");
  pane.innerHTML = "";

  // Dashboard
  pane.appendChild(buildDashboard());

  // Content sections (Lerninhalte)
  const contentContainer = document.createElement("div");
  contentContainer.id = "content-sections";
  (S.db.content_sections || []).forEach(sec => {
    contentContainer.appendChild(buildContentSection(sec));
  });
  pane.appendChild(contentContainer);

  // Phase groups (Bewertung)
  const evalContainer = document.createElement("div");
  evalContainer.id = "eval-sections";
  PHASES.forEach(phase => {
    const goals = S.db.learning_goals.filter(g => g.phase === phase.id);
    if (goals.length) {
      evalContainer.appendChild(buildPhaseGroup(phase, goals));
    }
  });
  pane.appendChild(evalContainer);

  // History
  pane.appendChild(buildHistoryCard());

  // Setup observers
  setupFadeObserver();
  setupScrollSpy();
}

function buildDashboard() {
  const overall = computeOverallProgress();
  const eta = computeEta();
  const totalGoals = S.db.learning_goals.length;
  const doneGoals = S.db.learning_goals.filter(g => goalScore(g.id) >= 100).length;
  const inProgress = S.db.learning_goals.filter(g => { const s = goalScore(g.id); return s > 0 && s < 100; }).length;

  const card = document.createElement("div");
  card.className = "dashboard-card glass fade-in";
  card.id = "dashboard";

  let phaseRows = "";
  PHASES.forEach(p => {
    const pct = Math.round(computePhaseProgress(p.id));
    const count = S.db.learning_goals.filter(g => g.phase === p.id).length;
    phaseRows += `<div class="phase-row">
      <span class="phase-row-label">${escapeHtml(p.label)}</span>
      <div class="phase-row-bar"><div class="phase-row-fill" style="width:${pct}%"></div></div>
      <span class="phase-row-pct">${pct}% <span class="fs-xs text-muted">(${count})</span></span>
    </div>`;
  });

  const traineeLabel = S.selectedTraineeId ? userName(S.selectedTraineeId) : "-";
  const roleBadge = canVerify() ? "Traineransicht" : "Eigener Fortschritt";

  card.innerHTML = `
    <div class="dashboard-header">
      <div>
        <h2 class="dashboard-title">Lernfortschritt: ${escapeHtml(traineeLabel)}</h2>
        <p class="dashboard-sub">${escapeHtml(roleBadge)}</p>
      </div>
      <div class="kpi-big">
        <span class="kpi-value" id="kpi-overall">${overall.toFixed(1)}%</span>
        <span class="kpi-label">Gesamt</span>
      </div>
    </div>
    <div class="progress-bar"><span class="progress-fill" id="progress-fill" style="width:${overall}%"></span></div>
    <div class="kpi-grid">
      <div class="kpi-box"><span class="kpi-value">${doneGoals}</span><span class="kpi-label">Abgeschlossen (100%)</span></div>
      <div class="kpi-box"><span class="kpi-value">${inProgress}</span><span class="kpi-label">In Bearbeitung</span></div>
      <div class="kpi-box"><span class="kpi-value">${totalGoals}</span><span class="kpi-label">Gesamt</span></div>
      <div class="kpi-box"><span class="kpi-value" id="kpi-eta">${eta ? formatDateShort(eta.toISOString()) : "-"}</span><span class="kpi-label">Gesch. Ende</span></div>
    </div>
    <div class="phase-summary" id="phase-summary">${phaseRows}</div>
    ${canVerify() ? '<div style="margin-top:1rem"><button class="uk-button uk-button-primary uk-button-small" id="btn-report" type="button"><span uk-icon="icon: file-text; ratio:0.8"></span> Bericht erstellen</button></div>' : ''}
  `;

  return card;
}

function buildContentSection(sec) {
  const el = document.createElement("div");
  el.className = "section-card glass fade-in";
  el.id = `content-${sec.id}`;

  let childrenHtml = "";
  (sec.children || []).forEach(ch => {
    childrenHtml += `<div id="content-${ch.id}" style="margin-top:0.8rem">
      <h4 style="margin:0 0 0.3rem">${escapeHtml(ch.id)} ${escapeHtml(ch.title)}</h4>
      <div class="section-body">${ch.content_html || ""}</div>
    </div>`;
  });

  el.innerHTML = `
    <header>
      <span class="section-code">${escapeHtml(sec.id)}</span>
      <h3 class="section-title">${escapeHtml(sec.title)}</h3>
    </header>
    <div class="section-body">${sec.content_html || ""}</div>
    ${childrenHtml}
  `;

  return el;
}

function buildPhaseGroup(phase, goals) {
  const el = document.createElement("div");
  el.className = "phase-group-card glass fade-in";
  el.id = `phase-${phase.id}`;

  const pct = Math.round(computePhaseProgress(phase.id));

  // Group by machine
  const machineMap = {};
  goals.forEach(g => {
    if (!machineMap[g.machine_id]) machineMap[g.machine_id] = [];
    machineMap[g.machine_id].push(g);
  });

  const order = {};
  (S.db.machines || []).forEach(m => { order[m.id] = m.position || 99; });
  const sortedMachines = Object.keys(machineMap).sort((a, b) => (order[a] || 99) - (order[b] || 99));

  let machinesHtml = "";
  sortedMachines.forEach(mid => {
    const mGoals = machineMap[mid];
    const mpct = Math.round(computeMachineProgress(phase.id, mid));
    machinesHtml += `<div class="machine-group" id="phase-${phase.id}-${mid}">
      <div class="machine-group-header">
        <span class="machine-group-title">${escapeHtml(machineLabel(mid))}</span>
        <span class="machine-group-badge">${mpct}% &middot; ${mGoals.length} Ziele</span>
      </div>
      <ul class="goal-list">
        ${mGoals.map(g => buildGoalCardHtml(g)).join("")}
      </ul>
    </div>`;
  });

  el.innerHTML = `
    <div class="phase-group-header">
      <span class="section-code" style="background:color-mix(in srgb, ${phase.color} 14%, var(--c-surface-solid)); color:${phase.color}">${escapeHtml(phase.id)}</span>
      <h3 class="phase-group-title">${escapeHtml(phase.label)}</h3>
      <span class="phase-badge" style="margin-left:auto" data-level="${pct >= 100 ? 'done' : pct >= 65 ? 'high' : pct >= 25 ? 'mid' : 'low'}">${pct}%</span>
    </div>
    ${machinesHtml}
  `;

  // Bind rating events after inserting
  setTimeout(() => bindGoalEvents(el), 0);

  return el;
}

function buildGoalCardHtml(goal) {
  const ev = S.evalMap[goal.id];
  const score = ev ? (ev.score || 0) : 0;
  const disabled = !canVerify();

  let segsHtml = "";
  [25, 50, 75, 100].forEach(val => {
    const filled = score >= val ? "filled" : "";
    segsHtml += `<button type="button" class="rating-seg ${filled}" data-val="${val}" data-goal="${goal.id}" ${disabled ? "disabled" : ""}>${val}</button>`;
  });

  const metaText = ev
    ? `${userName(ev.evaluated_by)} &middot; ${formatDate(ev.evaluated_at)}`
    : "Noch nicht bewertet";

  return `<li class="goal-card" data-goal-id="${goal.id}" data-score="${score}">
    <div class="rating-widget">
      <div class="rating-segments">${segsHtml}</div>
      <span class="rating-label">${score}%</span>
    </div>
    <div class="goal-main">
      <div class="goal-title">${escapeHtml(goal.title)}</div>
      <div class="goal-meta">${metaText}</div>
      <div class="goal-fields">
        <div class="goal-field">
          <label>Fehlerrate %</label>
          <input type="number" min="0" max="100" step="0.5" class="goal-error-rate" data-goal="${goal.id}"
            value="${ev?.error_rate != null ? ev.error_rate : ''}" ${disabled ? "disabled" : ""} placeholder="0">
        </div>
        <div class="goal-field">
          <label>Kommentar</label>
          <input type="text" class="goal-comment" data-goal="${goal.id}"
            value="${escapeHtml(ev?.comment || '')}" ${disabled ? "disabled" : ""} placeholder="Kurzer Kommentar">
        </div>
      </div>
      <div class="goal-fields full-width">
        <div class="goal-field">
          <label>Maßnahmen</label>
          <textarea class="goal-action" data-goal="${goal.id}" rows="1" ${disabled ? "disabled" : ""} placeholder="z.B. Teamgespräch">${escapeHtml(ev?.action || '')}</textarea>
        </div>
      </div>
    </div>
  </li>`;
}

function bindGoalEvents(container) {
  // Rating segments
  container.querySelectorAll(".rating-seg").forEach(seg => {
    seg.addEventListener("click", () => {
      if (!canVerify() || !S.selectedTraineeId) return;
      const goalId = seg.dataset.goal;
      const val = parseInt(seg.dataset.val, 10);
      const current = goalScore(goalId);
      const newScore = (current === val) ? 0 : val;
      saveEvaluation(goalId, newScore);
    });
  });

  // Debounced field saves
  const debouncedSave = debounce((goalId) => {
    const card = container.querySelector(`.goal-card[data-goal-id="${goalId}"]`);
    if (!card) return;
    const score = goalScore(goalId);
    const errorRate = parseFloat(card.querySelector(".goal-error-rate")?.value) || 0;
    const comment = card.querySelector(".goal-comment")?.value || "";
    const action = card.querySelector(".goal-action")?.value || "";
    saveEvaluation(goalId, score, errorRate, comment, action);
  }, 800);

  container.querySelectorAll(".goal-error-rate, .goal-comment, .goal-action").forEach(input => {
    input.addEventListener("input", () => {
      if (!canVerify()) return;
      debouncedSave(input.dataset.goal);
    });
  });
}

function saveEvaluation(goalId, score, errorRate, comment, action) {
  if (!canVerify() || !S.selectedTraineeId) return;

  // Get current values for fields not passed
  const card = document.querySelector(`.goal-card[data-goal-id="${goalId}"]`);
  if (errorRate === undefined && card) errorRate = parseFloat(card.querySelector(".goal-error-rate")?.value) || 0;
  if (comment === undefined && card) comment = card.querySelector(".goal-comment")?.value || "";
  if (action === undefined && card) action = card.querySelector(".goal-action")?.value || "";

  const ev = {
    id: nextId(S.db.evaluations),
    trainee_id: S.selectedTraineeId,
    goal_id: goalId,
    score: score,
    error_rate: errorRate || 0,
    comment: (comment || "").trim(),
    action: (action || "").trim(),
    evaluated_by: S.user.id,
    evaluated_at: nowIso(),
  };

  S.db.evaluations.push(ev);
  persistDb();

  // Update eval map
  S.evalMap[goalId] = ev;

  // Update UI for this goal card
  updateGoalCardUi(goalId);
  updateDashboard();
  renderSidebar();
}

function updateGoalCardUi(goalId) {
  const card = document.querySelector(`.goal-card[data-goal-id="${goalId}"]`);
  if (!card) return;

  const ev = S.evalMap[goalId];
  const score = ev ? (ev.score || 0) : 0;
  card.dataset.score = score;

  // Update rating segments
  card.querySelectorAll(".rating-seg").forEach(seg => {
    const val = parseInt(seg.dataset.val, 10);
    seg.classList.toggle("filled", score >= val);
  });

  // Update label
  const label = card.querySelector(".rating-label");
  if (label) label.textContent = score + "%";

  // Update meta
  const meta = card.querySelector(".goal-meta");
  if (meta && ev) {
    meta.innerHTML = `${escapeHtml(userName(ev.evaluated_by))} &middot; ${formatDate(ev.evaluated_at)}`;
  }
}

function updateDashboard() {
  const overall = computeOverallProgress();
  const el = $("#kpi-overall");
  if (el) el.textContent = overall.toFixed(1) + "%";

  const fill = $("#progress-fill");
  if (fill) fill.style.width = overall + "%";

  const eta = computeEta();
  const etaEl = $("#kpi-eta");
  if (etaEl) etaEl.textContent = eta ? formatDateShort(eta.toISOString()) : "-";

  // Update phase rows
  const summary = $("#phase-summary");
  if (summary) {
    let html = "";
    PHASES.forEach(p => {
      const pct = Math.round(computePhaseProgress(p.id));
      const count = S.db.learning_goals.filter(g => g.phase === p.id).length;
      html += `<div class="phase-row">
        <span class="phase-row-label">${escapeHtml(p.label)}</span>
        <div class="phase-row-bar"><div class="phase-row-fill" style="width:${pct}%"></div></div>
        <span class="phase-row-pct">${pct}% <span class="fs-xs text-muted">(${count})</span></span>
      </div>`;
    });
    summary.innerHTML = html;
  }

  // Update done/inprogress counts
  const doneGoals = S.db.learning_goals.filter(g => goalScore(g.id) >= 100).length;
  const inProgress = S.db.learning_goals.filter(g => { const s = goalScore(g.id); return s > 0 && s < 100; }).length;
  const kpiBoxes = $$(".kpi-box .kpi-value");
  if (kpiBoxes[0]) kpiBoxes[0].textContent = doneGoals;
  if (kpiBoxes[1]) kpiBoxes[1].textContent = inProgress;
}

function buildHistoryCard() {
  const card = document.createElement("div");
  card.className = "history-card glass fade-in";
  card.id = "history-card";

  const history = recentHistory(20);
  let listHtml = "";
  if (!history.length) {
    listHtml = "<li>Noch keine Bewertungen vorhanden.</li>";
  } else {
    history.forEach(ev => {
      const goal = S.db.learning_goals.find(g => g.id === ev.goal_id);
      const title = goal ? goal.title : ev.goal_id;
      const machine = goal ? machineLabel(goal.machine_id) : "";
      listHtml += `<li>
        <strong>${escapeHtml(machine)} – ${escapeHtml(title)}</strong>: ${ev.score}%<br>
        ${escapeHtml(userName(ev.evaluated_by))} &middot; ${formatDate(ev.evaluated_at)}
        ${ev.comment ? `<br><span class="text-muted">${escapeHtml(ev.comment)}</span>` : ""}
      </li>`;
    });
  }

  card.innerHTML = `<h3>Letzte Bewertungen</h3><ul class="history-list">${listHtml}</ul>`;
  return card;
}

/* ---------- 12. Observers ---------- */
function setupFadeObserver() {
  if (S.fadeObserver) S.fadeObserver.disconnect();
  S.fadeObserver = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (e.isIntersecting) {
        e.target.classList.add("visible");
        S.fadeObserver.unobserve(e.target);
      }
    });
  }, { threshold: 0.1, rootMargin: "0px 0px -40px 0px" });

  $$(".fade-in").forEach(el => S.fadeObserver.observe(el));
}

function setupScrollSpy() {
  if (S.sectionObserver) S.sectionObserver.disconnect();
  S.sectionObserver = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      const id = e.target.id;
      // Highlight content nav
      $$(".content-nav-link").forEach(link => {
        link.classList.toggle("active", link.getAttribute("href") === "#" + id);
      });
    });
  }, { threshold: 0.3, rootMargin: "-15% 0px -60% 0px" });

  $$(".section-card, .phase-group-card").forEach(el => S.sectionObserver.observe(el));
}

function ensurePhaseRendered(phaseId) {
  // All phases are rendered at once in v2, this is a no-op but kept for compatibility
}

/* ---------- 13. User Header ---------- */
function updateUserUi() {
  const nameEl = $("#user-name");
  const roleEl = $("#user-role");
  const avatarEl = $("#user-avatar");

  if (!S.user) {
    nameEl.textContent = "Nicht angemeldet";
    roleEl.textContent = "";
    avatarEl.textContent = "?";
    return;
  }

  nameEl.textContent = S.user.display_name;
  const roleLabels = { admin: "Administrator", trainer: "Trainer", trainee: "Azubi" };
  roleEl.textContent = roleLabels[S.user.role] || S.user.role;
  avatarEl.textContent = S.user.initials || S.user.display_name.slice(0, 2).toUpperCase();
}

function updateTraineeSelect() {
  const sel = $("#trainee-select");
  if (!canVerify()) {
    sel.style.display = "none";
    return;
  }
  sel.style.display = "";
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

/* ---------- 14. Login ---------- */
function openLogin() {
  const d = $("#login-dialog");
  if (d && !d.open) d.showModal();
}

function closeLogin() {
  const d = $("#login-dialog");
  if (d && d.open) d.close();
}

function switchLoginMode(mode) {
  S.loginMode = mode;
  $$(".mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  $("#password-fields").classList.toggle("active", mode === "password");
  $("#rfid-fields").classList.toggle("active", mode === "rfid");
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  const errEl = $("#login-error");
  errEl.textContent = "";

  try {
    let user = null;
    if (S.loginMode === "password") {
      const username = ($("#login-user")?.value || "").trim();
      const password = $("#login-pass")?.value || "";
      if (!username || !password) throw new Error("Bitte Benutzername und Passwort eingeben.");
      user = await loginPassword(username, password);
    } else {
      const tag = ($("#login-rfid")?.value || "").trim();
      if (!tag) throw new Error("Bitte RFID-Tag scannen.");
      // Try raw hash first, then SHA-256 the input
      user = loginRfid(tag);
      if (!user) {
        const hash = await sha256Hex(tag);
        user = loginRfid(hash);
      }
    }

    if (!user) throw new Error("Ungültige Zugangsdaten.");

    setSession(user);
    closeLogin();
    initApp();
  } catch (err) {
    errEl.textContent = err.message;
  }
}

function handleLogout() {
  setSession(null);
  S.selectedTraineeId = null;
  S.evalMap = {};
  updateUserUi();
  $("#content-pane").innerHTML = `<div class="uk-text-center uk-padding-large"><p class="text-muted">Bitte anmelden.</p></div>`;
  $("#sidebar-desktop").innerHTML = "";
  const mc = $("#sidebar-mobile-content");
  if (mc) mc.innerHTML = "";
  openLogin();
}

/* ---------- 15. Admin: Create User ---------- */
async function handleCreateUser(e) {
  e.preventDefault();
  if (!canAdmin()) return;

  const form = $("#admin-form");
  const fd = new FormData(form);
  const name = (fd.get("display_name") || "").trim();
  const uname = (fd.get("username") || "").trim().toLowerCase();
  const pass = fd.get("password") || "";
  const role = fd.get("role") || "trainee";
  const rfid = (fd.get("rfid_hash") || "").trim().toLowerCase();

  if (!name || !uname || !pass) { UIkit.notification("Pflichtfelder ausfüllen.", { status: "warning" }); return; }
  if (pass.length < 8) { UIkit.notification("Passwort min. 8 Zeichen.", { status: "warning" }); return; }
  if (allUsers().some(u => u.username === uname)) { UIkit.notification("Username existiert.", { status: "warning" }); return; }

  const hash = await createPasswordHash(pass);
  S.db.users.push({
    id: nextId(S.db.users),
    username: uname,
    display_name: name,
    initials: name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2),
    role, active: true,
    password_hash: hash,
    rfid_hash: rfid,
    created_at: nowIso(),
  });

  persistDb();
  form.reset();
  $("#admin-dialog").close();
  UIkit.notification("Benutzer erstellt!", { status: "success" });

  S.trainees = allTrainees();
  updateTraineeSelect();
  renderSidebar();
}

/* ---------- 16. Import / Export ---------- */
function downloadBackup() {
  const blob = new Blob([JSON.stringify(S.db, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `schulungshub-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function handleImport() {
  if (window.showOpenFilePicker) {
    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "JSON", accept: { "application/json": [".json"] } }],
      });
      const file = await handle.getFile();
      const text = await file.text();
      importJson(text);
      S.syncHandle = handle;
      setSyncState("connected");
      startSyncTimer();
    } catch (e) {
      if (e.name !== "AbortError") UIkit.notification("Import fehlgeschlagen: " + e.message, { status: "danger" });
    }
    return;
  }

  // Fallback: file input
  const input = $("#import-file-input");
  input.value = "";
  input.click();
}

function importJson(text) {
  const parsed = JSON.parse(text);
  S.db = normalizeDb(parsed);
  persistDb();
  if (S.user) {
    const refreshed = findUser(S.user.id);
    if (refreshed) S.user = refreshed;
  }
  initApp();
  UIkit.notification("Daten importiert!", { status: "success" });
}

/* ---------- 17. Report Export ---------- */
function generateReport() {
  if (!S.selectedTraineeId) return;

  const trainee = findUser(S.selectedTraineeId);
  const overall = computeOverallProgress();
  const meta = S.db.trainee_meta[S.selectedTraineeId] || {};

  let rows = "";
  PHASES.forEach(phase => {
    const goals = S.db.learning_goals.filter(g => g.phase === phase.id);
    if (!goals.length) return;

    const pct = Math.round(computePhaseProgress(phase.id));
    rows += `<tr style="background:#f0f4f3"><td colspan="7" style="font-weight:700;padding:8px">${escapeHtml(phase.label)} — ${pct}%</td></tr>`;

    // Group by machine
    const machineMap = {};
    goals.forEach(g => {
      if (!machineMap[g.machine_id]) machineMap[g.machine_id] = [];
      machineMap[g.machine_id].push(g);
    });

    Object.entries(machineMap).forEach(([mid, mGoals]) => {
      rows += `<tr style="background:#f8faf9"><td colspan="7" style="font-weight:600;padding:6px 8px">${escapeHtml(machineLabel(mid))}</td></tr>`;
      mGoals.forEach(g => {
        const ev = S.evalMap[g.id];
        const score = ev ? ev.score : 0;
        rows += `<tr>
          <td style="padding:4px 8px">${escapeHtml(g.title)}</td>
          <td style="text-align:center;font-weight:700">${score}%</td>
          <td style="text-align:center">${ev?.error_rate || "-"}</td>
          <td>${escapeHtml(ev?.comment || "")}</td>
          <td>${escapeHtml(ev?.action || "")}</td>
          <td>${ev ? escapeHtml(userName(ev.evaluated_by)) : "-"}</td>
          <td>${ev ? formatDateShort(ev.evaluated_at) : "-"}</td>
        </tr>`;
      });
    });
  });

  const html = `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
    <title>Bewertungsbericht – ${escapeHtml(trainee?.display_name || "?")}</title>
    <style>
      body { font-family: "Inter","Segoe UI",sans-serif; margin: 2rem; color: #132421; font-size: 12px; }
      h1 { font-size: 18px; margin: 0 0 4px; }
      h2 { font-size: 14px; margin: 16px 0 6px; }
      .meta { color: #4e6762; margin-bottom: 12px; }
      table { width: 100%; border-collapse: collapse; margin: 8px 0; }
      th, td { border: 1px solid #d0d5dd; padding: 4px 8px; text-align: left; font-size: 11px; }
      th { background: #0d9488; color: #fff; }
      .footer { margin-top: 20px; border-top: 1px solid #ccc; padding-top: 10px; color: #4e6762; }
      @media print { body { margin: 1cm; } }
    </style></head><body>
    <h1>Bewertungsbericht: ${escapeHtml(trainee?.display_name || "?")}</h1>
    <div class="meta">
      Erstellt: ${formatDate(nowIso())} &middot; Gesamtfortschritt: ${overall.toFixed(1)}% &middot;
      ${S.db.learning_goals.length} Lernziele
    </div>

    <table>
      <thead><tr><th>Lernziel</th><th>Score</th><th>Fehler%</th><th>Kommentar</th><th>Maßnahme</th><th>Ausbilder</th><th>Datum</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>

    ${meta.general_feedback ? `<h2>Allgemeines Feedback</h2><p>${escapeHtml(meta.general_feedback)}</p>` : ""}
    ${meta.conclusion ? `<h2>Fazit</h2><p>${escapeHtml(meta.conclusion)}</p>` : ""}
    ${meta.next_steps ? `<h2>Weiteres Vorgehen</h2><p>${escapeHtml(meta.next_steps)}</p>` : ""}

    <div class="footer">SchulungsHub – Bewertungsbericht &middot; Generiert am ${formatDate(nowIso())}</div>
    <script>window.print()<\/script>
  </body></html>`;

  const w = window.open("", "_blank");
  if (w) { w.document.write(html); w.document.close(); }
}

/* ---------- 18. Refresh All ---------- */
function refreshAll() {
  if (!S.user) return;
  S.evalMap = S.selectedTraineeId ? buildEvalMap(S.selectedTraineeId) : {};
  renderContentPane();
  renderSidebar();
  updateDashboard();
}

/* ---------- 19. Init / Boot ---------- */
function initApp() {
  if (!S.user) return;

  // Determine selected trainee
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
  renderSidebar();
  renderContentPane();

  // Bind report button (if rendered)
  setTimeout(() => {
    const reportBtn = $("#btn-report");
    if (reportBtn) reportBtn.addEventListener("click", generateReport);
  }, 0);
}

function bindGlobalEvents() {
  // Login dialog
  const loginDialog = $("#login-dialog");
  if (loginDialog) loginDialog.addEventListener("cancel", e => e.preventDefault());
  const loginForm = $("#login-form");
  if (loginForm) loginForm.addEventListener("submit", handleLoginSubmit);

  // Login mode switch
  $$(".mode-btn").forEach(b => {
    b.addEventListener("click", () => switchLoginMode(b.dataset.mode));
  });

  // Logout
  const chip = $("#user-chip");
  if (chip) chip.addEventListener("click", () => { if (S.user) handleLogout(); });

  // Trainee select
  const sel = $("#trainee-select");
  if (sel) sel.addEventListener("change", () => {
    S.selectedTraineeId = parseInt(sel.value, 10);
    S.evalMap = buildEvalMap(S.selectedTraineeId);
    refreshAll();
  });

  // Theme toggle
  const themeBtn = $("#theme-toggle");
  if (themeBtn) themeBtn.addEventListener("click", toggleThemeWithReveal);

  // Font switcher
  $$(".font-switcher button").forEach(b => {
    b.addEventListener("click", () => applyFont(b.dataset.font));
  });

  // Sync indicator click => connect/disconnect
  const syncEl = $("#sync-indicator");
  if (syncEl) syncEl.addEventListener("click", () => {
    if (S.syncHandle) disconnectFile();
    else connectFile();
  });

  // Scroll to top
  const scrollBtn = $("#scroll-top");
  if (scrollBtn) {
    scrollBtn.addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));
    window.addEventListener("scroll", () => {
      scrollBtn.classList.toggle("visible", window.scrollY > 400);
    }, { passive: true });
  }

  // Admin form
  const adminForm = $("#admin-form");
  if (adminForm) adminForm.addEventListener("submit", handleCreateUser);

  // File input fallback
  const fileInput = $("#import-file-input");
  if (fileInput) fileInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      importJson(text);
    } catch (err) {
      UIkit.notification("Import fehlgeschlagen: " + err.message, { status: "danger" });
    }
  });
}

function boot() {
  // Load data
  S.db = loadDb();

  // Load preferences
  loadPrefs();
  applyTheme(S.prefs.theme);
  applyFont(S.prefs.font);

  // Restore session
  restoreSession();

  // Bind events
  bindGlobalEvents();

  if (S.user) {
    initApp();
  } else {
    // Remove loading spinner
    const spinner = $("#loading-spinner");
    if (spinner) spinner.remove();
    openLogin();
  }
}

boot();
