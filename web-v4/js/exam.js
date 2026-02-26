/* ================================================================
   SchulungsHub v4 – Exam Mode
   Selbsttest, Exam Editor, Exam Analysis
   Depends on: js/utils.js, js/state.js, js/eval.js, js/render.js,
               js/editor.js, db-engine.js
   ================================================================ */
const Exam = (() => {
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

  return {
    EXAM_TOTAL, EXAM_PASS_PCT, fisherYates, startExam, renderExamOverlay,
    handleExamAnswer, renderExamResult, closeExam, openExamEditor,
    openExamAnalysis,
  };
})();

/* Global shortcuts */
const EXAM_TOTAL = Exam.EXAM_TOTAL;
const EXAM_PASS_PCT = Exam.EXAM_PASS_PCT;
const startExam = Exam.startExam;
const renderExamOverlay = Exam.renderExamOverlay;
const closeExam = Exam.closeExam;
const openExamEditor = Exam.openExamEditor;
const openExamAnalysis = Exam.openExamAnalysis;
