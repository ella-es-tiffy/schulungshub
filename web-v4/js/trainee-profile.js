/* ================================================================
   SchulungsHub v4 – Trainee Profile (Full-Page)
   Comprehensive trainee management: personal data, forecast breakdown,
   attendance calendar, learning curve, motivation index.
   Depends on: js/utils.js, js/state.js, js/eval.js, db-engine.js
   ================================================================ */
const TraineeProfile = (() => {

  function openProfile(traineeId) {
    const tid = traineeId || S.selectedTraineeId;
    if (!tid) return;
    const trainee = findUser(tid);
    if (!trainee) return;

    // Ensure evalMap is for this trainee
    const prevId = S.selectedTraineeId;
    S.selectedTraineeId = tid;
    S.evalMap = buildEvalMap(tid);

    let ov = $("#trainee-profile-overlay");
    if (ov) ov.remove();

    ov = document.createElement("div");
    ov.id = "trainee-profile-overlay";
    ov.className = "exam-overlay exam-result-page";

    const detail = computeEtaDetailed();
    const editable = canVerify();

    ov.innerHTML = `
      <div class="er-page tp-page">
        <div class="er-header tp-header">
          <span class="er-title">Profil: ${esc(trainee.display_name)}</span>
          <div class="er-header-actions">
            <button class="btn-primary btn-sm" id="tp-close">Schliessen</button>
          </div>
        </div>
        <div class="er-layout tp-layout">
          <aside class="er-sidebar tp-sidebar">
            ${buildPersonalSection(trainee, editable)}
            ${buildForecastSummary(detail)}
          </aside>
          <main class="er-main tp-main">
            ${buildFactorBreakdown(detail, trainee)}
            ${buildAttendanceCalendar(tid)}
            ${buildLearningCurveSection(detail)}
            ${buildMotivationSection(detail)}
            ${buildPhaseBreakdown()}
          </main>
        </div>
      </div>`;

    document.body.appendChild(ov);
    bindProfileEvents(ov, tid, trainee, prevId);
  }

  /* ── Tooltip Helper ── */
  function tip(text) {
    return ` <span class="tp-help" data-tip="${text}">?</span>`;
  }

  /* ── Personal Data Section ── */
  function buildPersonalSection(trainee, editable) {
    const roleLabel = trainee.role === "trainer" ? "Trainer" : trainee.role === "admin" ? "Admin" : "Schüler";
    const age = trainee.age != null ? trainee.age : null;
    const langLabels = ["Keine", "Grundkenntnisse", "Gut", "Muttersprachler"];
    const motorikLabels = ["Keine Erfahrung", "Wenig Erfahrung", "Durchschnittlich", "Sehr erfahren"];
    const startDate = trainee.measure_start
      ? new Intl.DateTimeFormat("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(trainee.measure_start))
      : "–";

    const editHint = editable ? ' <span class="tp-edit-hint">(klick zum Ändern)</span>' : "";

    return `
      <div class="tp-section">
        <div class="er-stat-block er-pass" style="text-align:center">
          <div class="tp-avatar">${esc(trainee.initials || trainee.display_name.slice(0, 2).toUpperCase())}</div>
          <div style="font-weight:700; font-size:15px; margin-top:8px">${esc(trainee.display_name)}</div>
          <div style="font-size:11px; opacity:0.6">${roleLabel} · ${esc(trainee.username)}</div>
        </div>
        <div class="er-stats tp-stats">
          <div class="er-stat">
            <span class="er-stat-label">Alter</span>
            <span class="er-stat-val ${editable ? 'tp-editable' : ''}" data-field="age">${age != null ? `${age} Jahre` : "–"}</span>
          </div>
          <div class="er-stat">
            <span class="er-stat-label">Sprache</span>
            <span class="er-stat-val ${editable ? 'tp-editable' : ''}" data-field="language">${langLabels[trainee.language_level != null ? trainee.language_level : 3]} (${trainee.language_level != null ? trainee.language_level : 3})</span>
          </div>
          <div class="er-stat">
            <span class="er-stat-label">Motorik/Praxis</span>
            <span class="er-stat-val ${editable ? 'tp-editable' : ''}" data-field="motorik">${motorikLabels[trainee.motorik_level != null ? trainee.motorik_level : 2]} (${trainee.motorik_level != null ? trainee.motorik_level : 2})</span>
          </div>
          <div class="er-stat">
            <span class="er-stat-label">Vorbildung</span>
            <span class="er-stat-val ${editable ? 'tp-editable' : ''}" data-field="training">${trainee.has_training ? "Ja" : "Nein"}</span>
          </div>
          <div class="er-stat">
            <span class="er-stat-label">Maßnahme-Start</span>
            <span class="er-stat-val ${editable ? 'tp-editable' : ''}" data-field="measure_start">${startDate}</span>
          </div>
        </div>
      </div>`;
  }

  /* ── Forecast Summary ── */
  function buildForecastSummary(detail) {
    if (!detail) {
      return `<div class="tp-section">
        <div class="er-stat-block" style="text-align:center">
          <div class="er-verdict">Prognose</div>
          <div style="font-size:14px; opacity:0.5; margin-top:8px">Nicht genug Daten</div>
        </div>
      </div>`;
    }

    const sane = detail.date.getFullYear() - new Date().getFullYear() < 15;
    const pct = Math.round(detail.overall);

    return `
      <div class="tp-section">
        <div class="er-stat-block ${pct >= 50 ? 'er-pass' : 'er-fail'}">
          <div class="er-verdict">Gesch. Ende</div>
          <div class="er-pct" style="font-size:20px">${sane ? formatDateKW(detail.date) : "–"}</div>
        </div>
        <div class="er-stats">
          <div class="er-stat"><span class="er-stat-label">Gesamtfortschritt${tip("Durchschnitt aller Lernziel-Scores (0-100%).")}</span><span class="er-stat-val">${pct}%</span></div>
          <div class="er-stat"><span class="er-stat-label">Abgeschlossen${tip("Lernziele mit Score 100%.")}</span><span class="er-stat-val er-val-ok">${detail.completedCount}</span></div>
          <div class="er-stat"><span class="er-stat-label">In Bearbeitung${tip("Lernziele mit Score 25-75%.")}</span><span class="er-stat-val">${detail.inProgressCount}</span></div>
          <div class="er-stat"><span class="er-stat-label">NIO${tip("Score 0% (nicht in Ordnung) – muss wiederholt werden.")}</span><span class="er-stat-val er-val-err">${detail.nioCount}</span></div>
          <div class="er-stat"><span class="er-stat-label">Nicht bewertet${tip("Lernziele ohne jegliche Bewertung.")}</span><span class="er-stat-val">${detail.unevaluated}</span></div>
          <div class="er-stat"><span class="er-stat-label">Velocity${tip("Abgeschlossene Lernziele pro Woche seit Massnahme-Start.")}</span><span class="er-stat-val">${detail.velocity.toFixed(2)} / Wo</span></div>
          <div class="er-stat"><span class="er-stat-label">Vergangene Wochen${tip("Wochen seit Massnahme-Start bis heute.")}</span><span class="er-stat-val">${detail.elapsedWeeks.toFixed(1)}</span></div>
          <div class="er-stat"><span class="er-stat-label">Gewichteter Rest${tip("Offene Arbeit gewichtet: kein Score/NIO = 1.0, Score 25 = 0.75, Score 50 = 0.50, Score 75 = 0.25.")}</span><span class="er-stat-val">${detail.weightedRemaining.toFixed(1)}</span></div>
        </div>
      </div>`;
  }

  /* ── Factor Breakdown ── */
  function buildFactorBreakdown(detail, trainee) {
    if (!detail) return `<h2>Prognose-Faktoren</h2><p style="opacity:0.5">Nicht genug Daten für Prognose.</p>`;

    const att = detail.attendance;
    const attDesc = att.hasData
      ? `${att.presentDays}/${att.expectedDays} Tage (${Math.round(att.rate * 100)}%)`
      : "Keine Daten";

    const rows = [
      { label: "Phasenfaktor", value: detail.phaseFactor.toFixed(2), desc: `Phase ${detail.currentPhase} (${Math.round(detail.overall)}% gesamt)`, bar: detail.phaseFactor / 1.2 * 100, tip: "Je nach Gesamtfortschritt: P1 (+20%), P2 (neutral), P3 (+10%), P4 (+5%). Anfangsphase ist langsamer." },
      { label: "Fehlerfaktor", value: detail.errorFactor.toFixed(3), desc: `${detail.nioCount} NIO × ${({ 1: "25%", 2: "12.5%", 3: "8.3%", 4: "0%" })[detail.currentPhase]}`, bar: Math.min(detail.errorFactor / 1.5 * 100, 100), tip: "NIO-Bewertungen erfordern Nacharbeit. Gewicht nimmt mit Fortschritt ab: P1=25%, P2=12.5%, P3=8.3%, P4=0%." },
      { label: "Vorbildung", value: detail.trainingFactor.toFixed(3), desc: trainee.has_training ? "Vorhanden → ×0.870" : "Keine → ×1.000", bar: detail.trainingFactor * 100, tip: "Berufliche Vorbildung beschleunigt das Lernen um ca. 13% (Faktor 0.87)." },
      { label: "Alter", value: detail.ageFactor.toFixed(3), desc: detail.age ? `${Math.round(detail.age)} Jahre` : "Unbekannt", bar: Math.min(detail.ageFactor / 1.4 * 100, 100), tip: "Ab 30 Jahren +1.5% pro Jahr (max. +37.5%). Unter 30 = neutral." },
      { label: "Sprache", value: detail.languageFactor.toFixed(3), desc: `Level ${detail.langLevel} / 3`, bar: Math.min(detail.languageFactor / 1.6 * 100, 100), tip: "Level 3 (Muttersprachler) = neutral. Pro Level darunter +20% laengere Ausbildung." },
      { label: "Motorik/Praxis", value: detail.motorikFactor.toFixed(3), desc: `Level ${detail.motorikLevel} / 3`, bar: Math.min(detail.motorikFactor / 1.3 * 100, 100), tip: "Praktische Vorerfahrung. Level 2 = neutral, weniger Erfahrung = langsamer (+15% pro Level)." },
      { label: "Individualfaktor", value: detail.individualFactor.toFixed(3), desc: "Produkt aller Personenfaktoren", bar: Math.min(detail.individualFactor / 1.5 * 100, 100), accent: true, tip: "Kombination aus Vorbildung, Alter, Sprache und Motorik (multipliziert)." },
      { label: "Lernkurve", value: detail.learningCurve.factor.toFixed(3), desc: trendLabel(detail.learningCurve.trend), bar: detail.learningCurve.factor / 1.3 * 100, tip: "Vergleicht Lerngeschwindigkeit der letzten 4 Wochen mit Gesamtdurchschnitt. Beschleunigung = kuerzere Prognose." },
      { label: "Motivation", value: detail.motivation.index.toFixed(3), desc: motivLabel(detail.motivation.trend), bar: detail.motivation.index / 1.3 * 100, tip: "Analysiert NIO-Muster und -Serien. Zunehmende Fehler deuten auf Motivationsverlust hin." },
      { label: "Anwesenheit", value: detail.attendanceFactor.toFixed(3), desc: attDesc, bar: Math.min(detail.attendanceFactor / 1.5 * 100, 100), tip: "Basiert auf der Anwesenheitsquote. Weniger Anwesenheit = proportional laengere Ausbildung." },
      { label: "Puffer", value: "1.100", desc: "Sicherheitszuschlag 10%", bar: 85, tip: "Pauschaler Sicherheitszuschlag fuer unvorhergesehene Verzoegerungen." },
    ];

    const projAbsent = detail.projectedAbsentWeeks > 0.1
      ? ` + ${detail.projectedAbsentWeeks.toFixed(1)} Wo Fehlzeiten`
      : "";

    let html = `<h2>Prognose-Faktoren${tip("Alle Faktoren werden multipliziert. Werte ueber 1.0 verlaengern die Prognose, unter 1.0 verkuerzen sie.")}</h2>
      <div class="tp-factor-summary">
        <span class="tp-factor-formula">Rest ${detail.weightedRemaining.toFixed(1)} ÷ ${detail.velocity.toFixed(2)}/Wo = ${detail.baseWeeks.toFixed(1)} Wo × Faktoren = ${detail.adjustedWeeks.toFixed(1)} Wo${projAbsent} = <strong>${detail.remainingWeeks.toFixed(1)} Wo</strong></span>
      </div>
      <div class="tp-factors">`;

    rows.forEach(r => {
      const barColor = r.accent ? "var(--accent)" : (parseFloat(r.value) > 1.05 ? "var(--error, #ef4444)" : "var(--success, #22c55e)");
      const helpIcon = r.tip ? tip(r.tip) : "";
      html += `<div class="tp-factor-row${r.accent ? " tp-factor-accent" : ""}">
        <span class="tp-factor-label">${r.label}${helpIcon}</span>
        <div class="tp-factor-bar-track">
          <div class="tp-factor-bar-fill" style="width:${Math.min(r.bar, 100)}%; background:${barColor}"></div>
        </div>
        <span class="tp-factor-val">${r.value}</span>
        <span class="tp-factor-desc">${r.desc}</span>
      </div>`;
    });

    html += `</div>`;
    return html;
  }

  function trendLabel(trend) {
    if (trend === "accelerating") return "Beschleunigend ↑";
    if (trend === "decelerating") return "Verlangsamend ↓";
    return "Stabil →";
  }

  function motivLabel(trend) {
    if (trend === "rising") return "Motiviert ↑";
    if (trend === "sinking") return "Sinkend ↓";
    return "Stabil →";
  }

  /* ── Attendance Calendar ── */
  function buildAttendanceCalendar(traineeId) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();

    const attendance = DbEngine.queryAll(
      "SELECT * FROM attendance WHERE trainee_id = ?", [traineeId]
    );
    const attendanceSet = new Set(attendance.map(a => a.date));

    // Total stats
    const totalDays = attendance.length;
    const totalHours = attendance.reduce((s, a) => s + (a.hours || 8), 0);

    return `
      <h2>Anwesenheit${tip("Anwesenheitstage beeinflussen die Prognose. Weniger Anwesenheit = laengere Ausbildungszeit.")}</h2>
      <div class="tp-attendance-stats">
        <span class="tp-att-stat">${totalDays} Tage</span>
        <span class="tp-att-stat">${totalHours.toFixed(0)} Stunden</span>
      </div>
      <div class="tp-calendar-nav">
        <button class="btn-icon tp-cal-prev" data-dir="-1" title="Vorheriger Monat">&#9664;</button>
        <span class="tp-cal-month" id="tp-cal-label">${monthLabel(month, year)}</span>
        <button class="btn-icon tp-cal-next" data-dir="1" title="Nächster Monat">&#9654;</button>
      </div>
      <div class="tp-calendar" id="tp-calendar" data-trainee="${traineeId}" data-year="${year}" data-month="${month}">
        ${buildCalendarGrid(year, month, attendanceSet)}
      </div>
      <p class="tp-cal-hint">${canVerify() ? "Klicke auf einen Tag um Anwesenheit zu markieren" : ""}</p>`;
  }

  function monthLabel(month, year) {
    const names = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
    return `${names[month]} ${year}`;
  }

  function buildCalendarGrid(year, month, attendanceSet) {
    const firstDay = new Date(year, month, 1).getDay();
    const offset = (firstDay + 6) % 7; // Monday = 0
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today = new Date().toISOString().slice(0, 10);

    let html = `<div class="tp-cal-header">
      <span>Mo</span><span>Di</span><span>Mi</span><span>Do</span><span>Fr</span><span>Sa</span><span>So</span>
    </div><div class="tp-cal-grid">`;

    // Empty cells before first day
    for (let i = 0; i < offset; i++) html += `<span class="tp-cal-empty"></span>`;

    for (let d = 1; d <= daysInMonth; d++) {
      const dateStr = `${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const isPresent = attendanceSet.has(dateStr);
      const isToday = dateStr === today;
      const isWeekend = new Date(year, month, d).getDay() === 0 || new Date(year, month, d).getDay() === 6;
      const classes = [
        "tp-cal-day",
        isPresent ? "tp-cal-present" : "",
        isToday ? "tp-cal-today" : "",
        isWeekend ? "tp-cal-weekend" : "",
      ].filter(Boolean).join(" ");

      html += `<button class="${classes}" data-date="${dateStr}" type="button">${d}</button>`;
    }

    html += `</div>`;
    return html;
  }

  /* ── Learning Curve Section ── */
  function buildLearningCurveSection(detail) {
    if (!detail) return "";

    const lc = detail.learningCurve;
    const trendIcon = lc.trend === "accelerating" ? "↑" : lc.trend === "decelerating" ? "↓" : "→";
    const trendColor = lc.trend === "accelerating" ? "er-val-ok" : lc.trend === "decelerating" ? "er-val-err" : "";

    // Build weekly completion chart (last 8 weeks)
    const evals = (S.db.evaluations || [])
      .filter(e => e.trainee_id === S.selectedTraineeId && e.score === 100 && e.evaluated_at)
      .sort((a, b) => new Date(a.evaluated_at) - new Date(b.evaluated_at));

    const weeks = [];
    const now = Date.now();
    for (let w = 7; w >= 0; w--) {
      const weekStart = now - (w + 1) * 7 * 86400000;
      const weekEnd = now - w * 7 * 86400000;
      const count = evals.filter(e => {
        const t = new Date(e.evaluated_at).getTime();
        return t >= weekStart && t < weekEnd;
      }).length;
      const kwDate = new Date(weekEnd);
      weeks.push({ kw: getCalendarWeek(kwDate), count });
    }

    const maxCount = Math.max(...weeks.map(w => w.count), 1);

    let barsHtml = "";
    weeks.forEach(w => {
      const pct = (w.count / maxCount) * 100;
      barsHtml += `<div class="tp-lc-bar-wrap">
        <div class="tp-lc-bar" style="height:${Math.max(pct, 4)}%"></div>
        <span class="tp-lc-bar-label">KW${w.kw}</span>
        <span class="tp-lc-bar-val">${w.count}</span>
      </div>`;
    });

    return `
      <h2>Lernkurve${tip("Misst, ob der Teilnehmer schneller oder langsamer lernt als im Durchschnitt.")}</h2>
      <div class="tp-lc-stats">
        <span>Gesamt-Velocity:${tip("Durchschnittliche Abschluesse pro Woche seit Beginn.")} <strong>${lc.overallVelocity.toFixed(2)}/Wo</strong></span>
        <span>Letzte 4 Wochen:${tip("Abschluesse pro Woche in den letzten 4 Wochen.")} <strong>${lc.recentVelocity.toFixed(2)}/Wo</strong></span>
        <span>Trend:${tip("Vergleich aktuell vs. gesamt. Beschleunigung = gut, Verlangsamung = Aufmerksamkeit noetig.")} <strong class="${trendColor}">${trendLabel(lc.trend)} ${trendIcon}</strong></span>
        <span>Faktor:${tip("0.7 = 30% schneller, 1.0 = neutral, 1.3 = 30% langsamer.")} <strong>${lc.factor.toFixed(3)}</strong></span>
      </div>
      <div class="tp-lc-chart">${barsHtml}</div>`;
  }

  /* ── Motivation Section ── */
  function buildMotivationSection(detail) {
    if (!detail) return "";

    const m = detail.motivation;
    const trendIcon = m.trend === "rising" ? "↑" : m.trend === "sinking" ? "↓" : "→";
    const trendColor = m.trend === "rising" ? "er-val-ok" : m.trend === "sinking" ? "er-val-err" : "";

    return `
      <h2>Motivation${tip("Erkennt Motivationsmuster anhand von NIO-Haeufigkeit und -Serien.")}</h2>
      <div class="tp-motiv-stats">
        <span>NIO-Quote gesamt:${tip("Anteil aller NIO-Bewertungen an der Gesamtzahl.")} <strong>${(m.nioRate * 100).toFixed(1)}%</strong></span>
        <span>NIO-Quote letzt. 4 Wo:${tip("NIO-Anteil nur in den letzten 4 Wochen. Steigt er, sinkt die Motivation.")} <strong class="${m.recentNioRate > m.nioRate ? 'er-val-err' : 'er-val-ok'}">${(m.recentNioRate * 100).toFixed(1)}%</strong></span>
        ${m.streak ? `<span>NIO-Serie:${tip("Aufeinanderfolgende NIO-Bewertungen. Ab 3 gibt es einen Zuschlag auf die Prognose.")} <strong class="er-val-err">${m.streak}×</strong></span>` : ""}
        <span>Trend:${tip("Steigend = motiviert (kuerzere Prognose), sinkend = demotiviert (laengere Prognose).")} <strong class="${trendColor}">${motivLabel(m.trend)} ${trendIcon}</strong></span>
        <span>Index:${tip("0.85 = motiviert (+15% schneller), 1.0 = neutral, 1.3 = demotiviert (+30% langsamer).")} <strong>${m.index.toFixed(3)}</strong></span>
      </div>`;
  }

  /* ── Phase Breakdown ── */
  function buildPhaseBreakdown() {
    let html = `<h2>Fortschritt nach Phase</h2><div class="tp-phase-list">`;

    getPhases().forEach(p => {
      const goals = S.db.learning_goals.filter(g => g.phase === p.id);
      if (!goals.length) return;
      const pct = Math.round(phaseProgress(p.id));
      const done = goals.filter(g => goalScore(g.id) >= 100).length;
      const nio = goals.filter(g => {
        const ev = S.evalMap[g.id];
        return ev && ev.score === 0 && ev.evaluated_at;
      }).length;

      html += `<div class="tp-phase-row">
        <span class="tp-phase-label">${esc(p.label)}</span>
        <div class="tp-phase-bar-track">
          <div class="tp-phase-bar-fill" style="width:${pct}%"></div>
        </div>
        <span class="tp-phase-stats">${done}/${goals.length} ${nio ? `<span class="er-val-err">(${nio} NIO)</span>` : ""}</span>
        <span class="tp-phase-pct">${pct}%</span>
      </div>`;
    });

    html += `</div>`;
    return html;
  }

  /* ── Event Binding ── */
  function bindProfileEvents(ov, tid, trainee, prevId) {
    // Close
    ov.querySelector("#tp-close").addEventListener("click", () => {
      ov.remove();
      // Restore previous selection
      S.selectedTraineeId = prevId;
      S.evalMap = prevId ? buildEvalMap(prevId) : {};
    });

    // Editable fields (inline editing)
    if (canVerify()) {
      ov.querySelectorAll(".tp-editable").forEach(el => {
        el.style.cursor = "pointer";
        el.addEventListener("click", () => startInlineEdit(ov, el, tid, trainee));
      });
    }

    // Calendar navigation
    ov.querySelectorAll(".tp-cal-prev, .tp-cal-next").forEach(btn => {
      btn.addEventListener("click", () => navigateCalendar(ov, parseInt(btn.dataset.dir), tid));
    });

    // Calendar day clicks
    if (canVerify()) {
      bindCalendarDays(ov, tid);
    }
  }

  /* ── Inline Editing ── */
  function startInlineEdit(ov, el, tid, trainee) {
    const field = el.dataset.field;
    const rect = el.getBoundingClientRect();

    // Remove existing editors
    ov.querySelectorAll(".tp-inline-editor").forEach(e => e.remove());

    const editor = document.createElement("div");
    editor.className = "tp-inline-editor";
    editor.style.position = "fixed";
    editor.style.left = rect.left + "px";
    editor.style.top = (rect.bottom + 4) + "px";
    editor.style.zIndex = "1300";

    let inputHtml = "";
    if (field === "age") {
      inputHtml = `<input type="number" class="tp-inline-input" id="tp-ie-val" min="14" max="70" value="${trainee.age != null ? trainee.age : ""}" placeholder="z.B. 25">`;
    } else if (field === "language") {
      inputHtml = `<select class="tp-inline-input" id="tp-ie-val">
        <option value="0" ${trainee.language_level === 0 ? "selected" : ""}>0 – Keine</option>
        <option value="1" ${trainee.language_level === 1 ? "selected" : ""}>1 – Grundkenntnisse</option>
        <option value="2" ${trainee.language_level === 2 ? "selected" : ""}>2 – Gut</option>
        <option value="3" ${trainee.language_level === 3 || trainee.language_level == null ? "selected" : ""}>3 – Muttersprachler</option>
      </select>`;
    } else if (field === "motorik") {
      inputHtml = `<select class="tp-inline-input" id="tp-ie-val">
        <option value="0" ${trainee.motorik_level === 0 ? "selected" : ""}>0 – Keine Erfahrung</option>
        <option value="1" ${trainee.motorik_level === 1 ? "selected" : ""}>1 – Wenig</option>
        <option value="2" ${trainee.motorik_level === 2 || trainee.motorik_level == null ? "selected" : ""}>2 – Durchschnittlich</option>
        <option value="3" ${trainee.motorik_level === 3 ? "selected" : ""}>3 – Sehr erfahren</option>
      </select>`;
    } else if (field === "training") {
      inputHtml = `<select class="tp-inline-input" id="tp-ie-val">
        <option value="0" ${!trainee.has_training ? "selected" : ""}>Nein</option>
        <option value="1" ${trainee.has_training ? "selected" : ""}>Ja</option>
      </select>`;
    } else if (field === "measure_start") {
      const val = trainee.measure_start ? trainee.measure_start.slice(0, 10) : "";
      inputHtml = `<input type="date" class="tp-inline-input" id="tp-ie-val" value="${val}">`;
    }

    editor.innerHTML = `${inputHtml}
      <div class="tp-inline-actions">
        <button class="btn-primary btn-xs" id="tp-ie-save">OK</button>
        <button class="btn-secondary btn-xs" id="tp-ie-cancel">×</button>
      </div>`;

    document.body.appendChild(editor);

    const input = editor.querySelector("#tp-ie-val");
    if (input) input.focus();

    editor.querySelector("#tp-ie-cancel").addEventListener("click", () => editor.remove());
    editor.querySelector("#tp-ie-save").addEventListener("click", async () => {
      const val = input.value;
      await saveInlineEdit(field, val, tid);
      editor.remove();
      reloadState();
      S.evalMap = buildEvalMap(tid);
      openProfile(tid); // Refresh
    });

    // Close on outside click
    setTimeout(() => {
      document.addEventListener("click", function handler(e) {
        if (!editor.contains(e.target) && !el.contains(e.target)) {
          editor.remove();
          document.removeEventListener("click", handler);
        }
      });
    }, 10);
  }

  async function saveInlineEdit(field, val, tid) {
    if (field === "age") {
      DbEngine.runBatch("UPDATE users SET age=? WHERE id=?", [val !== "" ? parseInt(val) : null, tid]);
    } else if (field === "language") {
      DbEngine.runBatch("UPDATE users SET language_level=? WHERE id=?", [parseInt(val), tid]);
    } else if (field === "motorik") {
      DbEngine.runBatch("UPDATE users SET motorik_level=? WHERE id=?", [parseInt(val), tid]);
    } else if (field === "training") {
      DbEngine.runBatch("UPDATE users SET has_training=? WHERE id=?", [parseInt(val), tid]);
    } else if (field === "measure_start") {
      const iso = val ? new Date(val).toISOString() : null;
      DbEngine.runBatch("UPDATE users SET measure_start=? WHERE id=?", [iso, tid]);
    }
    await DbEngine.persistNow();
  }

  /* ── Calendar Navigation ── */
  function navigateCalendar(ov, dir, tid) {
    const cal = ov.querySelector("#tp-calendar");
    if (!cal) return;

    let year = parseInt(cal.dataset.year);
    let month = parseInt(cal.dataset.month) + dir;
    if (month < 0) { month = 11; year--; }
    if (month > 11) { month = 0; year++; }

    cal.dataset.year = year;
    cal.dataset.month = month;

    const attendance = DbEngine.queryAll(
      "SELECT * FROM attendance WHERE trainee_id = ?", [tid]
    );
    const attendanceSet = new Set(attendance.map(a => a.date));

    cal.innerHTML = buildCalendarGrid(year, month, attendanceSet);
    ov.querySelector("#tp-cal-label").textContent = monthLabel(month, year);

    if (canVerify()) bindCalendarDays(ov, tid);
  }

  function bindCalendarDays(ov, tid) {
    ov.querySelectorAll(".tp-cal-day").forEach(btn => {
      btn.addEventListener("click", async () => {
        const date = btn.dataset.date;
        const existing = DbEngine.queryAll(
          "SELECT id FROM attendance WHERE trainee_id=? AND date=?", [tid, date]
        );

        if (existing.length) {
          DbEngine.run("DELETE FROM attendance WHERE trainee_id=? AND date=?", [tid, date]);
          btn.classList.remove("tp-cal-present");
        } else {
          DbEngine.run(
            "INSERT INTO attendance (trainee_id, machine_id, date, hours) VALUES (?,?,?,?)",
            [tid, null, date, 8]
          );
          btn.classList.add("tp-cal-present");
        }
      });
    });
  }

  return { openProfile };
})();

/* Global shortcuts */
const openTraineeProfile = TraineeProfile.openProfile;
