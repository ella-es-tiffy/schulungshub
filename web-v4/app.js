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
