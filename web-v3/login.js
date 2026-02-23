/* ================================================================
   SchulungsHub v3 – Login Page Logic
   Auth via sql.js + IndexedDB (DbEngine)
   ================================================================ */

const SESSION_KEY = "schulungsHub.session";
const DATA_KEY    = "SchulungsHub-Siebdruck-2026";

/* ── Helpers ── */
const $ = s => document.querySelector(s);

/* ── Crypto ── */
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

async function sha256Hex(text) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
}

async function hmacSign(message) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(DATA_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(sig));
}

/* ── Data (loaded from DbEngine – sql.js + IndexedDB) ── */

async function loadUsers() {
  await DbEngine.init();
  const data = DbEngine.toJson();
  return (data.users || [])
    .map(u => ({ ...u, active: u.active !== undefined ? u.active : true }))
    .filter(u => u.active !== false);
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
  return timingSafeEqual(expected, sig);
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

/* ── Boot ── */
async function boot() {
  // Already logged in? Go to main app
  if (await hasValidSession()) {
    window.location.href = "index.html";
    return;
  }

  initTheme();
  users = await loadUsers();
  populateSelect();

  $("#login-form").addEventListener("submit", handleSubmit);
  $("#theme-btn").addEventListener("click", toggleTheme);

  const rfid = $("#rfid-input");
  if (rfid) rfid.addEventListener("input", handleRfidInput);
  startRfidListener();
}

boot();
