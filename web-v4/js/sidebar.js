/* ================================================================
   SchulungsHub v4 – Sidebar
   Navigation, TOC, Phase-Progress
   Depends on: js/utils.js ($, $$, esc), js/state.js (S, canEdit, canAdmin, getPhases),
               js/eval.js (phaseProgress)
   ================================================================ */
const Sidebar = (() => {
  function renderSidebar() {
    const sb = $("#sidebar");
    if (!sb) return;
    let h = "";

    h += `<div class="nav-header">Übersicht</div>`;
    h += `<a class="nav-link" data-target="sec-dashboard">Dashboard</a>`;

    h += `<div class="nav-header">Lerninhalte</div>`;
    (S.db.content_sections || []).forEach(sec => {
      h += `<a class="nav-link" data-target="sec-${sec.id}">${esc(sec.title)}</a>`;
      (sec.children || []).forEach(ch => {
        h += `<div class="nav-children">
          <a class="nav-link" data-target="sec-${ch.id}">${esc(ch.title)}</a>`;
        (ch.children || []).forEach(sub => {
          h += `<div class="nav-children nav-level-3">
            <a class="nav-link" data-target="sec-${sub.id}">${esc(sub.title)}</a>
          </div>`;
        });
        h += `</div>`;
      });
    });

    if (canEdit()) {
      h += `<button class="sidebar-btn" id="btn-add-section" type="button">
        <span uk-icon="icon: plus; ratio:0.7"></span> Neue Sektion
      </button>`;
    }

    if (!canVerify()) {
      h += `<div class="nav-header">Bewertung</div>`;
      getPhases().forEach(p => {
        const pct = Math.round(phaseProgress(p.id));
        h += `<a class="nav-link" data-target="sec-phase-${p.id}" data-phase="${p.id}">
          ${esc(p.label)} <span class="mono-label" style="margin-left:auto">${pct}%</span>
        </a>`;
      });
      h += `<a class="nav-link" data-target="sec-history">Letzte Bewertungen</a>`;
    }

    if (canAdmin()) {
      h += `<div class="nav-header">Daten</div>`;
      h += `<a class="nav-link" data-target="sec-daten">Datenverwaltung</a>`;
    }

    sb.innerHTML = h;
    bindSidebarEvents();
  }

  function bindSidebarEvents() {
    $$(".nav-link[data-target]").forEach(el => {
      el.addEventListener("click", e => {
        e.preventDefault();
        navigateToSection(el.dataset.target);
        closeMobileMenu();
      });
    });

    const addSec = $("#btn-add-section");
    if (addSec) addSec.addEventListener("click", () => handleAddSection());
  }

  return { renderSidebar, bindSidebarEvents };
})();

/* Global shortcuts */
const renderSidebar = Sidebar.renderSidebar;
const bindSidebarEvents = Sidebar.bindSidebarEvents;
