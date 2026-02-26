/* ================================================================
   SchulungsHub v4 – Auth & Session
   Login, Session-Management, Shift-Logout
   Depends on: js/crypto.js (hmacSign, hmacVerify, verifyPassword),
               js/state.js (S, allUsers, findUser)
   ================================================================ */
const Auth = (() => {
  const SESSION_KEY = "schulungsHub.session";

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
  const SHIFT_TIMES = [6, 14, 22];
  const SHIFT_GRACE = 30;

  function getSessionStart() {
    return parseInt(sessionStorage.getItem(SESSION_KEY + ".time"), 10) || 0;
  }

  function getLogoutShift() {
    const loginTime = getSessionStart();
    if (!loginTime) return null;
    const login = new Date(loginTime);
    const now = new Date();

    for (let dayOffset = 0; dayOffset <= 1; dayOffset++) {
      for (const sh of SHIFT_TIMES) {
        const boundary = new Date(login);
        boundary.setDate(boundary.getDate() + dayOffset);
        boundary.setHours(sh, 0, 0, 0);
        if (boundary <= login) continue;
        if (boundary < now && !(boundary.getHours() === now.getHours() && now.getMinutes() <= 1)) continue;

        const minsBeforeBoundary = (boundary - login) / 60000;
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
      if (now.getHours() === target.hour && now.getMinutes() <= 1 && target.date <= now) {
        notify("Schichtwechsel – automatisch abgemeldet.", "warning");
        handleLogout();
      }
    }, 30000);
  }

  function redirectToLogin() {
    window.location.href = "login.html";
  }

  async function handleLogout() {
    await setSession(null);
    redirectToLogin();
  }

  return {
    SESSION_KEY, loginPassword, loginRfid, setSession, restoreSession,
    getSessionAge, setupShiftLogout, redirectToLogin, handleLogout,
    getShiftCountdown, updateSessionTimer,
  };
})();

/* Global shortcuts */
const SESSION_KEY = Auth.SESSION_KEY;
const loginPassword = Auth.loginPassword;
const loginRfid = Auth.loginRfid;
const setSession = Auth.setSession;
const restoreSession = Auth.restoreSession;
const getSessionAge = Auth.getSessionAge;
const setupShiftLogout = Auth.setupShiftLogout;
const redirectToLogin = Auth.redirectToLogin;
const handleLogout = Auth.handleLogout;
