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
