/* ================================================================
   SchulungsHub v4 – Admin & User Management
   User CRUD, Password management, RFID, User UI
   Depends on: js/utils.js, js/crypto.js, js/state.js, js/eval.js,
               js/sidebar.js, js/render.js, db-engine.js
   ================================================================ */
const Admin = (() => {
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
        ${u.role === "trainee" ? `<button class="btn-icon umgmt-edit" data-user-id="${u.id}" title="Prognose-Daten"><span uk-icon="icon: file-edit; ratio:0.75"></span></button>` : ""}
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

  // Bind trainee edit buttons
  list.querySelectorAll(".umgmt-edit").forEach(btn => {
    btn.addEventListener("click", () => {
      openTraineeEdit(parseInt(btn.dataset.userId, 10));
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

/* ── Trainee Forecast Edit ── */
function openTraineeEdit(userId) {
  if (!canVerify()) return;
  const user = S.db.users.find(u => u.id === userId);
  if (!user) return;

  const dlg = $("#trainee-edit-dialog");
  if (!dlg) return;

  $("#trainee-edit-name").innerHTML = `<strong>${esc(user.display_name)}</strong>`;

  const fBirth = $("#trainee-birthdate");
  const fLang = $("#trainee-language");
  const fTraining = $("#trainee-training");
  const fStart = $("#trainee-measure-start");

  fBirth.value = user.birthdate ? user.birthdate.slice(0, 10) : "";
  fLang.value = user.language_level != null ? user.language_level : 3;
  fTraining.checked = !!user.has_training;
  fStart.value = user.measure_start ? user.measure_start.slice(0, 10) : "";

  // Clone buttons to remove old listeners
  const saveBtn = $("#trainee-edit-save");
  const newSave = saveBtn.cloneNode(true);
  saveBtn.replaceWith(newSave);
  const cancelBtn = $("#trainee-edit-cancel");
  const newCancel = cancelBtn.cloneNode(true);
  cancelBtn.replaceWith(newCancel);

  newSave.addEventListener("click", async () => {
    const birthdate = fBirth.value || null;
    const languageLevel = parseInt(fLang.value) || 3;
    const hasTraining = fTraining.checked ? 1 : 0;
    const measureStart = fStart.value ? new Date(fStart.value).toISOString() : null;

    DbEngine.runBatch(
      "UPDATE users SET birthdate=?, language_level=?, has_training=?, measure_start=? WHERE id=?",
      [birthdate, languageLevel, hasTraining, measureStart, userId]
    );
    await DbEngine.persistNow();
    reloadState();
    dlg.close();
    renderUserManagementDialog();
    notify(`Daten von ${user.display_name} aktualisiert.`, "success");
  });

  newCancel.addEventListener("click", () => dlg.close());
  dlg.addEventListener("click", e => { if (e.target === dlg) dlg.close(); }, { once: true });
  dlg.showModal();
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
    "INSERT INTO users (id,username,display_name,initials,role,active,password_hash,rfid_hash,created_at,created_by,must_change_password,theme,birthdate,language_level,has_training,measure_start) VALUES (?,?,?,?,?,1,?,?,?,?,1,NULL,NULL,3,0,?)",
    [newId, uname, displayName, initials, role, passwordHash, rfidHash, now, S.user.id, now]
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

  return {
    updateUserUi, updateTraineeSelect, openChangePassword,
    handleChangePassword, openUserManagement, renderUserManagementDialog,
    handleResetPassword, openRfidAssign, openTraineeEdit, handleDeleteUser, handleCreateUser,
  };
})();

/* Global shortcuts */
const updateUserUi = Admin.updateUserUi;
const updateTraineeSelect = Admin.updateTraineeSelect;
const openChangePassword = Admin.openChangePassword;
const handleChangePassword = Admin.handleChangePassword;
const openUserManagement = Admin.openUserManagement;
const renderUserManagementDialog = Admin.renderUserManagementDialog;
const handleDeleteUser = Admin.handleDeleteUser;
const handleCreateUser = Admin.handleCreateUser;
const openRfidAssign = Admin.openRfidAssign;
const handleResetPassword = Admin.handleResetPassword;
const openTraineeEdit = Admin.openTraineeEdit;
