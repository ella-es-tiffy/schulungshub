/* ================================================================
   SchulungsHub v4 – Search
   SQL-Volltextsuche, Overlay, Navigation
   Depends on: js/utils.js ($, esc), js/state.js (S), db-engine.js
   ================================================================ */
const Search = (() => {
  function performSearch(query) {
    const q = `%${query}%`;
    return DbEngine.queryAll(`
      SELECT 'section' AS type, id, title, NULL AS extra FROM content_sections
        WHERE title LIKE ?1 COLLATE NOCASE OR content_md LIKE ?1 COLLATE NOCASE
      UNION ALL
      SELECT 'goal' AS type, id, title, phase || ':' || machine_id AS extra FROM learning_goals
        WHERE title LIKE ?1 COLLATE NOCASE
      UNION ALL
      SELECT 'machine' AS type, id, label AS title, NULL AS extra FROM machines
        WHERE label LIKE ?1 COLLATE NOCASE
      LIMIT 20
    `, [q]);
  }

  function closeSearchOverlay(clearInput = true) {
    const ov = $("#search-overlay");
    if (ov) ov.remove();
    if (clearInput) {
      const inp = $("#header-search");
      if (inp) inp.value = "";
    }
  }

  function renderSearchResults(results, query) {
    let ov = $("#search-overlay");
    if (ov) ov.remove();

    ov = document.createElement("div");
    ov.id = "search-overlay";
    ov.className = "search-overlay";

    if (!results.length) {
      ov.innerHTML = `<div class="search-overlay-card"><h2>Suche: „${esc(query)}"</h2><p style="opacity:0.5;margin-top:12px">Keine Treffer.</p></div>`;
      document.body.appendChild(ov);
      ov.addEventListener("click", (e) => { if (e.target === ov) closeSearchOverlay(); });
      return;
    }

    const re = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    const hl = (s) => esc(s).replace(re, `<mark>$1</mark>`);

    const badges = { section: "Inhalt", goal: "Ziel", machine: "Maschine" };
    const cls = { section: "badge-section", goal: "badge-goal", machine: "badge-machine" };

    let html = `<div class="search-overlay-card">`;
    html += `<h2>Suche: „${esc(query)}" <span style="font-weight:400;font-size:0.7em;opacity:0.5">${results.length} Treffer</span></h2>`;
    html += `<div class="search-results-list">`;
    results.forEach(r => {
      const badge = `<span class="search-badge ${cls[r.type]}">${badges[r.type]}</span>`;
      let target = "";
      if (r.type === "section") {
        target = `sec-${r.id}`;
      } else if (r.type === "goal") {
        const [phase] = (r.extra || "").split(":");
        target = `sec-phase-${phase}`;
      } else if (r.type === "machine") {
        const g = S.db.learning_goals.find(g => g.machine_id === r.id);
        target = g ? `sec-phase-${g.phase}` : "";
      }
      const dataExtra = r.type === "goal" ? ` data-machine="${(r.extra || "").split(":")[1]}"` : "";
      html += `<a class="search-result-item" data-target="${target}"${dataExtra}>
        ${badge}<span class="search-result-title">${hl(r.title)}</span>
        <span class="search-result-arrow">&#8250;</span>
      </a>`;
    });
    html += `</div></div>`;

    ov.innerHTML = html;
    document.body.appendChild(ov);

    ov.addEventListener("click", (e) => { if (e.target === ov) closeSearchOverlay(); });

    ov.querySelectorAll(".search-result-item").forEach(item => {
      item.addEventListener("click", (e) => {
        e.preventDefault();
        const t = item.dataset.target;
        const mid = item.dataset.machine || null;
        closeSearchOverlay();
        if (t) navigateToResult(t, mid);
      });
    });
  }

  function navigateToResult(target, machineId) {
    const el = document.getElementById(target);
    if (!el) return;
    el.classList.add("visible");

    if (machineId) {
      const mg = el.querySelector(`.machine-group[data-machine="${machineId}"]`);
      if (mg) mg.open = true;
    }

    window.scrollTo({ top: el.offsetTop - 70, behavior: "instant" });
    history.replaceState(null, "", "#" + target);
    el.classList.remove("snap-bounce");
    void el.offsetWidth;
    el.classList.add("snap-bounce");
    el.addEventListener("animationend", () => el.classList.remove("snap-bounce"), { once: true });
  }

  return { performSearch, closeSearchOverlay, renderSearchResults, navigateToResult };
})();

/* Global shortcuts */
const performSearch = Search.performSearch;
const closeSearchOverlay = Search.closeSearchOverlay;
const renderSearchResults = Search.renderSearchResults;
const navigateToResult = Search.navigateToResult;
