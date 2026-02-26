/* ================================================================
   SchulungsHub v4 – Content Editor
   Markdown-Editor, Toolbar, Section CRUD
   Depends on: js/utils.js ($, esc, nowIso, debounce),
               js/state.js (S, reloadState, canEdit),
               js/markdown.js (renderMarkdown),
               js/sidebar.js (renderSidebar),
               render.js (renderPage, buildContentSectionHtml) — loaded later, called at runtime
   ================================================================ */
const Editor = (() => {
  function openEditor(sectionId) {
    S.editingSection = sectionId;
    let sec = findSection(sectionId);
    if (!sec) return;

    const container = document.getElementById(`sec-${sectionId}`);
    if (!container) return;

    const currentMd = sec.content_md || "";

    container.innerHTML = `
      <h2>${esc(sec.title)}
        <button class="btn-icon editor-close-btn" title="Schliessen"><span uk-icon="icon: close; ratio:0.8"></span></button>
      </h2>
      <div class="editor-wrap">
        <div class="editor-toolbar">
          <button type="button" data-prefix="# " title="H1">H1</button>
          <button type="button" data-prefix="## " title="H2">H2</button>
          <button type="button" data-prefix="### " title="H3">H3</button>
          <button type="button" data-wrap="**" title="Fett">B</button>
          <button type="button" data-wrap="*" title="Kursiv">I</button>
          <button type="button" data-prefix="- " title="Liste">List</button>
          <button type="button" data-prefix="1. " title="Num. Liste">1.</button>
          <button type="button" data-action="code" title="Code (inline / Block)">Code</button>
          <button type="button" data-block="note" title="Note">Note</button>
          <button type="button" data-block="tip" title="Tip">Tip</button>
          <button type="button" data-block="warning" title="Warnung">Warn</button>
          <button type="button" data-block="important" title="Wichtig">Imp</button>
          <button type="button" data-action="slideshow" title="Slideshow">Slides</button>
        </div>
        <div class="editor-split">
          <div class="editor-input">
            <textarea id="editor-textarea" spellcheck="true">${esc(currentMd)}</textarea>
          </div>
          <div class="editor-preview md-content" id="editor-preview"></div>
        </div>
        <div class="editor-actions">
          <button class="btn-secondary btn-sm editor-cancel-btn">Abbrechen</button>
          <button class="btn-primary btn-sm editor-save-btn">Speichern</button>
        </div>
      </div>
    `;

    const textarea = $("#editor-textarea");
    const preview = $("#editor-preview");

    const updatePreview = () => { preview.innerHTML = renderMarkdown(textarea.value); };
    updatePreview();
    textarea.addEventListener("input", debounce(updatePreview, 200));

    container.querySelectorAll(".editor-toolbar button").forEach(btn => {
      btn.addEventListener("click", () => {
        if (btn.dataset.prefix) prefixSelection(textarea, btn.dataset.prefix);
        else if (btn.dataset.wrap) wrapSelection(textarea, btn.dataset.wrap);
        else if (btn.dataset.block) blockSelection(textarea, btn.dataset.block);
        else if (btn.dataset.action === "code") codeSelection(textarea);
        else if (btn.dataset.action === "slideshow") slideshowSelection(textarea);
        updatePreview();
      });
    });

    container.querySelector(".editor-save-btn").addEventListener("click", async () => {
      const now = nowIso();
      DbEngine.runBatch("UPDATE content_sections SET content_md=?, updated_at=? WHERE id=?",
        [textarea.value, now, sectionId]);
      const ok = await DbEngine.persistNow();
      if (!ok) { notify("Speichern fehlgeschlagen!", "danger"); return; }
      sec.content_md = textarea.value;
      sec.updated_at = now;
      notify("Gespeichert!", "success");
      const newHtml = buildContentSectionHtml(sec);
      container.outerHTML = newHtml;
      const newEl = document.getElementById(`sec-${sectionId}`);
      if (newEl) {
        newEl.classList.add("visible");
        const eb = newEl.querySelector(".section-edit-btn");
        if (eb) eb.addEventListener("click", () => openEditor(sectionId));
      }
      S.editingSection = null;
    });

    const closeEditor = () => {
      const newHtml = buildContentSectionHtml(sec);
      container.outerHTML = newHtml;
      const newEl = document.getElementById(`sec-${sectionId}`);
      if (newEl) {
        newEl.classList.add("visible");
        const eb = newEl.querySelector(".section-edit-btn");
        if (eb) eb.addEventListener("click", () => openEditor(sectionId));
      }
      S.editingSection = null;
    };

    container.querySelector(".editor-cancel-btn").addEventListener("click", closeEditor);
    container.querySelector(".editor-close-btn").addEventListener("click", closeEditor);
  }

  function prefixSelection(textarea, prefix) {
    const s = textarea.selectionStart, e = textarea.selectionEnd;
    const sel = textarea.value.slice(s, e);
    if (sel) {
      const prefixed = sel.split("\n").map(l => prefix + l).join("\n");
      textarea.value = textarea.value.slice(0, s) + prefixed + textarea.value.slice(e);
      textarea.selectionStart = s;
      textarea.selectionEnd = s + prefixed.length;
    } else {
      textarea.value = textarea.value.slice(0, s) + prefix + textarea.value.slice(e);
      textarea.selectionStart = textarea.selectionEnd = s + prefix.length;
    }
    textarea.focus();
  }

  function wrapSelection(textarea, w) {
    const s = textarea.selectionStart, e = textarea.selectionEnd;
    const sel = textarea.value.slice(s, e);
    if (sel) {
      textarea.value = textarea.value.slice(0, s) + w + sel + w + textarea.value.slice(e);
      textarea.selectionStart = s + w.length;
      textarea.selectionEnd = s + w.length + sel.length;
    } else {
      textarea.value = textarea.value.slice(0, s) + w + w + textarea.value.slice(e);
      textarea.selectionStart = textarea.selectionEnd = s + w.length;
    }
    textarea.focus();
  }

  function codeSelection(textarea) {
    const s = textarea.selectionStart, e = textarea.selectionEnd;
    const sel = textarea.value.slice(s, e);
    const multiline = sel.includes("\n");
    if (multiline || !sel) {
      const inner = sel || "Code hier...";
      const block = "\n```\n" + inner + "\n```\n";
      textarea.value = textarea.value.slice(0, s) + block + textarea.value.slice(e);
      textarea.selectionStart = s + 5;
      textarea.selectionEnd = s + 5 + inner.length;
    } else {
      textarea.value = textarea.value.slice(0, s) + "`" + sel + "`" + textarea.value.slice(e);
      textarea.selectionStart = s + 1;
      textarea.selectionEnd = s + 1 + sel.length;
    }
    textarea.focus();
  }

  function slideshowSelection(textarea) {
    const s = textarea.selectionStart, e = textarea.selectionEnd;
    const placeholder = "bild1.jpg\nbild2.jpg\nbild3.jpg";
    const block = "\n:::slideshow\n" + placeholder + "\n:::\n";
    textarea.value = textarea.value.slice(0, s) + block + textarea.value.slice(e);
    textarea.selectionStart = s + 14;
    textarea.selectionEnd = s + 14 + placeholder.length;
    textarea.focus();
  }

  function blockSelection(textarea, type) {
    const s = textarea.selectionStart, e = textarea.selectionEnd;
    const sel = textarea.value.slice(s, e) || "Text hier...";
    const quoted = sel.split("\n").map(l => "> " + l).join("\n");
    const block = "\n> [!" + type.toUpperCase() + "]\n" + quoted + "\n";
    textarea.value = textarea.value.slice(0, s) + block + textarea.value.slice(e);
    textarea.selectionStart = s;
    textarea.selectionEnd = s + block.length;
    textarea.focus();
  }

  function startInlineRename(el) {
    const secId = el.dataset.sectionId;
    const sec = findSection(secId);
    if (!sec) return;

    const oldTitle = sec.title;
    const input = document.createElement("input");
    input.type = "text";
    input.value = oldTitle;
    input.className = "inline-rename";
    input.style.cssText = "font:inherit;font-size:inherit;font-weight:inherit;letter-spacing:inherit;color:var(--heading);background:var(--bg);border:2px solid var(--accent);border-radius:6px;padding:2px 8px;width:100%;outline:none;";

    el.replaceWith(input);
    input.focus();
    input.select();

    function commit() {
      const newTitle = input.value.trim();
      if (newTitle && newTitle !== oldTitle) {
        sec.title = newTitle;
        DbEngine.run("UPDATE content_sections SET title=? WHERE id=?", [newTitle, secId]);
        renderSidebar();
      }
      const span = document.createElement("span");
      span.className = "section-title";
      span.dataset.sectionId = secId;
      span.title = "Doppelklick zum Umbenennen";
      span.textContent = sec.title;
      span.style.cursor = "pointer";
      span.addEventListener("dblclick", () => startInlineRename(span));
      input.replaceWith(span);
    }

    function cancel() {
      const span = document.createElement("span");
      span.className = "section-title";
      span.dataset.sectionId = secId;
      span.title = "Doppelklick zum Umbenennen";
      span.textContent = oldTitle;
      span.style.cursor = "pointer";
      span.addEventListener("dblclick", () => startInlineRename(span));
      input.replaceWith(span);
    }

    input.addEventListener("keydown", e => {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
    });
    input.addEventListener("blur", commit);
  }

  function findSection(id) {
    for (const s of (S.db.content_sections || [])) {
      if (s.id === id) return s;
      for (const ch of (s.children || [])) {
        if (ch.id === id) return ch;
        for (const sub of (ch.children || [])) { if (sub.id === id) return sub; }
      }
    }
    return null;
  }

  async function handleAddSection(parentId = null) {
    const label = parentId ? "Titel des Unterpunkts:" : "Titel der neuen Sektion:";
    const title = prompt(label);
    if (!title || !title.trim()) return;

    const id = title.trim().toLowerCase().replace(/[^a-z0-9äöüß]+/g, "-").replace(/^-|-$/g, "");
    const siblings = DbEngine.queryAll(
      parentId
        ? "SELECT position FROM content_sections WHERE parent_id = ? ORDER BY position DESC LIMIT 1"
        : "SELECT position FROM content_sections WHERE parent_id IS NULL ORDER BY position DESC LIMIT 1",
      parentId ? [parentId] : []
    );
    const maxPos = siblings.length ? (siblings[0].position || 0) : 0;

    const secId = id || `sec-${Date.now()}`;
    const now = nowIso();
    DbEngine.runBatch("INSERT INTO content_sections (id, title, position, content_md, parent_id, updated_at) VALUES (?,?,?,?,?,?)",
      [secId, title.trim(), maxPos + 1, "", parentId, now]);
    await DbEngine.persistNow();
    reloadState();
    renderSidebar();
    renderPage();
    notify(parentId ? "Unterpunkt erstellt!" : "Sektion erstellt!", "success");

    setTimeout(() => {
      const el = document.getElementById(`sec-${secId}`);
      if (el) { el.classList.add("visible"); window.scrollTo({ top: el.offsetTop - 70, behavior: "instant" }); }
    }, 100);
  }

  async function handleDeleteSection(secId) {
    const sec = findSection(secId);
    if (!sec) return;
    const childCount = (sec.children || []).reduce((n, ch) => n + 1 + (ch.children || []).length, 0);
    const msg = childCount
      ? `"${sec.title}" und ${childCount} Unterpunkt(e) wirklich löschen?`
      : `"${sec.title}" wirklich löschen?`;
    if (!confirm(msg)) return;

    const ids = [secId];
    (sec.children || []).forEach(ch => {
      ids.push(ch.id);
      (ch.children || []).forEach(sub => ids.push(sub.id));
    });
    ids.forEach(id => DbEngine.run("DELETE FROM content_sections WHERE id = ?", [id]));
    await DbEngine.persistNow();
    reloadState();
    renderSidebar();
    renderPage();
    notify("Gelöscht!", "success");
  }

  async function handleMoveSection(secId, direction) {
    const row = DbEngine.queryAll("SELECT id, parent_id, position FROM content_sections WHERE id = ?", [secId])[0];
    if (!row) return;
    const parentId = row.parent_id;
    const siblings = DbEngine.queryAll(
      parentId
        ? "SELECT id, position FROM content_sections WHERE parent_id = ? ORDER BY position"
        : "SELECT id, position FROM content_sections WHERE parent_id IS NULL ORDER BY position",
      parentId ? [parentId] : []
    );
    const idx = siblings.findIndex(s => s.id === secId);
    if (idx < 0) return;
    const swapIdx = direction === "up" ? idx - 1 : idx + 1;
    if (swapIdx < 0 || swapIdx >= siblings.length) return;

    const posA = siblings[idx].position;
    const posB = siblings[swapIdx].position;
    DbEngine.run("UPDATE content_sections SET position = ? WHERE id = ?", [posB, siblings[idx].id]);
    DbEngine.run("UPDATE content_sections SET position = ? WHERE id = ?", [posA, siblings[swapIdx].id]);
    await DbEngine.persistNow();
    reloadState();
    renderSidebar();
    renderPage();
  }

  return {
    openEditor, prefixSelection, wrapSelection, codeSelection, slideshowSelection,
    blockSelection, startInlineRename, findSection, handleAddSection,
    handleDeleteSection, handleMoveSection,
  };
})();

/* Global shortcuts */
const openEditor = Editor.openEditor;
const prefixSelection = Editor.prefixSelection;
const wrapSelection = Editor.wrapSelection;
const codeSelection = Editor.codeSelection;
const slideshowSelection = Editor.slideshowSelection;
const blockSelection = Editor.blockSelection;
const startInlineRename = Editor.startInlineRename;
const findSection = Editor.findSection;
const handleAddSection = Editor.handleAddSection;
const handleDeleteSection = Editor.handleDeleteSection;
const handleMoveSection = Editor.handleMoveSection;
