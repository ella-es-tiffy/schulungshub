/* ================================================================
   SchulungsHub v4 – Export, Import, Report
   DB-Export, JSON-Backup, Import, Bewertungsbericht
   Depends on: js/utils.js, js/state.js, js/eval.js, db-engine.js
   ================================================================ */
const Export = (() => {
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

  return { generateReport, exportSqliteDb, downloadBackup, handleImport, importJson };
})();

/* Global shortcuts */
const generateReport = Export.generateReport;
const exportSqliteDb = Export.exportSqliteDb;
const downloadBackup = Export.downloadBackup;
const handleImport = Export.handleImport;
const importJson = Export.importJson;
