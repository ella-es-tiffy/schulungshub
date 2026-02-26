/* ================================================================
   SchulungsHub v4 – Render & Page Events
   Page rendering, HTML builders, event binding, print, sort
   Depends on: js/utils.js, js/state.js, js/eval.js, js/markdown.js,
               js/editor.js, js/scoring.js, js/sidebar.js
   ================================================================ */
const Render = (() => {
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
          <h1>Lernfortschritt: ${esc(trainee)} ${S.selectedTraineeId ? `<button class="tp-profile-btn" id="btn-open-profile" type="button"><span uk-icon="icon: user; ratio:0.7"></span> Profil</button>` : ""}</h1>
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
            <div class="value">${eta && eta.date.getFullYear() - new Date().getFullYear() < 15 ? formatDateKW(eta.date) : "-"}</div>
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
  const adminBtns = canAdmin()
    ? `<button class="section-admin-btn section-add-child-btn" data-section-id="${sec.id}" title="Unterpunkt hinzufügen"><span uk-icon="icon: plus; ratio:0.7"></span></button>
       <button class="section-admin-btn section-move-up-btn" data-section-id="${sec.id}" title="Nach oben"><span uk-icon="icon: chevron-up; ratio:0.7"></span></button>
       <button class="section-admin-btn section-move-down-btn" data-section-id="${sec.id}" title="Nach unten"><span uk-icon="icon: chevron-down; ratio:0.7"></span></button>
       <button class="section-admin-btn section-delete-btn" data-section-id="${sec.id}" title="Löschen"><span uk-icon="icon: trash; ratio:0.7"></span></button>`
    : "";

  const titleAttr = canAdmin() ? ` data-section-id="${sec.id}" title="Doppelklick zum Umbenennen"` : "";
  return `<div class="doc-section" id="sec-${sec.id}">
    <h2><span class="section-title"${titleAttr}>${esc(sec.title)}</span> ${editBtn} ${printBtn} ${adminBtns}</h2>
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

  // Trainee profile button
  const profileBtn = $("#btn-open-profile");
  if (profileBtn) profileBtn.addEventListener("click", () => openTraineeProfile());

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

  // Section admin buttons (add child, move, delete)
  $$(".section-add-child-btn").forEach(btn => {
    btn.addEventListener("click", () => handleAddSection(btn.dataset.sectionId));
  });
  $$(".section-delete-btn").forEach(btn => {
    btn.addEventListener("click", () => handleDeleteSection(btn.dataset.sectionId));
  });
  $$(".section-move-up-btn").forEach(btn => {
    btn.addEventListener("click", () => handleMoveSection(btn.dataset.sectionId, "up"));
  });
  $$(".section-move-down-btn").forEach(btn => {
    btn.addEventListener("click", () => handleMoveSection(btn.dataset.sectionId, "down"));
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

/* ── Scoring → js/scoring.js ── */

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

  return {
    setupScrollSpy, setupFadeObserver, toggleSortMode, savePhaseOrder,
    movePhase, moveMachine, moveGoal, reassignGoal, renderPage,
    canDeleteExams, buildDashboardHtml, buildContentSectionHtml,
    buildPhaseHtml, buildGoalCard, buildHistoryHtml, buildDatenHtml,
    bindPageEvents, printSection,
  };
})();

/* Global shortcuts */
const setupScrollSpy = Render.setupScrollSpy;
const setupFadeObserver = Render.setupFadeObserver;
const toggleSortMode = Render.toggleSortMode;
const renderPage = Render.renderPage;
const canDeleteExams = Render.canDeleteExams;
const buildDashboardHtml = Render.buildDashboardHtml;
const buildContentSectionHtml = Render.buildContentSectionHtml;
const buildPhaseHtml = Render.buildPhaseHtml;
const buildGoalCard = Render.buildGoalCard;
const buildHistoryHtml = Render.buildHistoryHtml;
const buildDatenHtml = Render.buildDatenHtml;
const bindPageEvents = Render.bindPageEvents;
const printSection = Render.printSection;
const movePhase = Render.movePhase;
const moveMachine = Render.moveMachine;
const moveGoal = Render.moveGoal;
const reassignGoal = Render.reassignGoal;
const savePhaseOrder = Render.savePhaseOrder;
