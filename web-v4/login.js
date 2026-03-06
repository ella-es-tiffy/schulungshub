/* ================================================================
   SchulungsHub v4 – Login Page Logic
   NAS = Single Source of Truth, direct sql.js queries
   Depends on: js/utils.js, js/crypto.js, db-engine.js
   ================================================================ */

const SESSION_KEY = "schulungsHub.session";

/* ── Data (loaded from DbEngine – sql.js + NAS) ── */

function loadUsers() {
  return DbEngine.queryAll("SELECT * FROM users WHERE active=1").map(u => ({
    ...u, active: true, must_change_password: !!u.must_change_password,
  }));
}

/* ── State ── */
let users = [];

/* ── Session ── */
async function setSession(user) {
  const payload = String(user.id);
  const sig = await hmacSign(payload);
  sessionStorage.setItem(SESSION_KEY, payload + "." + sig);
  sessionStorage.setItem(SESSION_KEY + ".time", String(Date.now()));
}

async function hasValidSession() {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw || !raw.includes(".")) return false;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return false;
  const expected = await hmacSign(payload);
  return Crypto.timingSafeEqual(expected, sig);
}

/* ── Auth ── */
async function loginPassword(username, password) {
  const u = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  return u && (await verifyPassword(password, u.password_hash)) ? u : null;
}

function loginRfid(tagHash) {
  const h = tagHash.trim().toLowerCase();
  return users.find(u => (u.rfid_hash || "").toLowerCase() === h) || null;
}

/* ── Populate User Select ── */
function populateSelect() {
  const sel = $("#login-user");
  const sorted = [...users].sort((a, b) => a.display_name.localeCompare(b.display_name, "de"));
  sorted.forEach(u => {
    const opt = document.createElement("option");
    opt.value = u.username;
    opt.textContent = u.display_name;
    sel.appendChild(opt);
  });
}

/* ── Login Success ── */
async function onLoginSuccess(user) {
  await setSession(user);
  window.location.href = "index.html";
}

/* ── Form Submit ── */
async function handleSubmit(e) {
  e.preventDefault();
  const err = $("#login-error");
  const btn = $("#login-btn");
  err.textContent = "";

  const uname = ($("#login-user")?.value || "").trim();
  const pass = $("#login-pass")?.value || "";

  if (!uname) { err.textContent = "Bitte Benutzer auswählen."; return; }
  if (!pass) { err.textContent = "Bitte Passwort eingeben."; return; }

  btn.classList.add("loading");
  btn.textContent = "Prüfe...";

  try {
    const user = await loginPassword(uname, pass);
    if (!user) { err.textContent = "Ungültiges Passwort."; return; }
    await onLoginSuccess(user);
  } catch {
    err.textContent = "Anmeldung fehlgeschlagen.";
  } finally {
    btn.classList.remove("loading");
    btn.textContent = "Einloggen";
  }
}

/* ── RFID ── */
let rfidTimer = null;

function startRfidListener() {
  const inp = $("#rfid-input");
  if (!inp) return;
  setInterval(() => {
    if (document.activeElement !== inp && document.activeElement?.tagName !== "SELECT" && document.activeElement?.type !== "password") {
      inp.focus();
    }
  }, 500);
}

function handleRfidInput() {
  clearTimeout(rfidTimer);
  rfidTimer = setTimeout(async () => {
    const inp = $("#rfid-input");
    const tag = (inp?.value || "").trim();
    inp.value = "";
    if (!tag || tag.length < 4) return;

    const err = $("#login-error");
    if (err) err.textContent = "";

    let user = loginRfid(tag);
    if (!user) user = loginRfid(await sha256Hex(tag));
    if (!user) {
      if (err) err.textContent = "RFID-Tag nicht erkannt.";
      return;
    }
    await onLoginSuccess(user);
  }, 300);
}

/* ── Theme ── */
function initTheme() {
  const saved = localStorage.getItem("schulungsHub.loginTheme") || "light";
  document.documentElement.setAttribute("data-theme", saved);
  updateThemeIcon(saved);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("schulungsHub.loginTheme", next);
  updateThemeIcon(next);
}

function updateThemeIcon(theme) {
  const icon = $("#theme-icon");
  if (icon) icon.innerHTML = theme === "dark" ? "&#9790;" : "&#9788;";
}

/* ── NAS Bar (non-blocking) ── */
function showNasBar(mode) {
  const overlay = $("#nas-overlay");
  if (!overlay) return;

  if (mode === "needs_permission") {
    overlay.innerHTML = `<span>⚠ NAS-Zugriff nötig</span>
      <button class="btn-login" id="btn-nas-permission" style="width:auto;padding:6px 16px;margin:0;font-size:12px">Zugriff erlauben</button>`;
    overlay.className = "nas-bar-login";
    document.getElementById("btn-nas-permission").addEventListener("click", async () => {
      try {
        const ok = await DbEngine.requestPermission();
        if (ok) {
          users = loadUsers();
          populateSelect();
          overlay.remove();
        }
      } catch (e) {
        const err = $("#login-error");
        if (err) err.textContent = "Fehler: " + e.message;
      }
    });
  } else {
    overlay.innerHTML = `<span>Speichern nicht aktiv</span>
      <button class="btn-login" id="btn-nas-connect" style="width:auto;padding:6px 16px;margin:0;font-size:12px">Ordner wählen</button>
      <button class="btn-login" id="btn-nas-file" style="width:auto;padding:6px 16px;margin:0;font-size:12px">DB-Datei wählen</button>`;
    overlay.className = "nas-bar-login";
    async function onConnected() {
      users = loadUsers();
      populateSelect();
      overlay.remove();
    }
    document.getElementById("btn-nas-connect").addEventListener("click", async () => {
      try { await DbEngine.connect(); await onConnected(); } catch (e) {
        if (e.name !== "AbortError") { const err = $("#login-error"); if (err) err.textContent = "Verbindung fehlgeschlagen: " + e.message; }
      }
    });
    document.getElementById("btn-nas-file").addEventListener("click", async () => {
      try { await DbEngine.connectFile(); await onConnected(); } catch (e) {
        if (e.name !== "AbortError") { const err = $("#login-error"); if (err) err.textContent = "Verbindung fehlgeschlagen: " + e.message; }
      }
    });
  }
}

/* ── Password Toggle ── */
function bindPwToggles() {
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

/* ── Boot ── */
async function boot() {
  initTheme();
  $("#theme-btn").addEventListener("click", toggleTheme);

  // DB is ALWAYS available after tryReconnect (from file or seed)
  const status = await DbEngine.tryReconnect();

  // Already logged in? Go to main app
  if (await hasValidSession()) {
    window.location.href = "index.html";
    return;
  }

  // Load users and show login form immediately
  users = loadUsers();
  populateSelect();

  $("#login-form").addEventListener("submit", handleSubmit);
  bindPwToggles();
  const rfid = $("#rfid-input");
  if (rfid) rfid.addEventListener("input", handleRfidInput);
  startRfidListener();

  // Show NAS bar if not connected (non-blocking)
  if (status !== "connected") {
    showNasBar(status);
  }
}

boot();
