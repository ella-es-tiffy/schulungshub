/* ================================================================
   SchulungsHub v4 – Application Logic
   NAS = Single Source of Truth, Direct SQL, Debounced Persist
   Depends on: js/utils.js, js/crypto.js, js/markdown.js, js/state.js, js/eval.js, js/prefs.js, js/auth.js, db-engine.js
   ================================================================ */

/* ── 1. Config ── */
const APP_VERSION = "0.1.7";
const DATA_KEY    = Crypto.DATA_KEY;

/* ── Modules → js/state.js, js/eval.js, js/markdown.js, js/auth.js, js/prefs.js ── */

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

/* ── Modules → js/search.js, js/sidebar.js, js/render.js, js/editor.js, js/scoring.js ── */

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
