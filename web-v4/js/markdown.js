/* ================================================================
   SchulungsHub v4 – Markdown Rendering
   Custom alert blocks, slideshow blocks
   Depends on: vendor/marked.min.js
   ================================================================ */
const Markdown = (() => {
  const ALERT_TYPES = {
    TIP:       { cls: "alert-tip",       icon: "◈" },
    NOTE:      { cls: "alert-note",      icon: "⊡" },
    WARNING:   { cls: "alert-warning",   icon: "!" },
    IMPORTANT: { cls: "alert-important", icon: "★" },
  };

  function renderMarkdown(md) {
    if (!md) return "";
    let html = marked.parse(md, { breaks: true });

    Object.entries(ALERT_TYPES).forEach(([type, val]) => {
      const re = new RegExp(`<blockquote>\\s*<p>\\s*\\[!${type}\\]([\\s\\S]*?)</p>\\s*</blockquote>`, "gi");
      html = html.replace(re, (_, content) =>
        `<div class="custom-alert ${val.cls}">
          <div class="alert-header">
            <span class="alert-icon">${val.icon}</span>
            <span class="alert-title">${type}</span>
          </div>
          <div class="alert-content"><p>${content.trim()}</p></div>
        </div>`
      );
    });

    // :::slideshow blocks → UIkit slideshow
    html = html.replace(/:::slideshow\s*([\s\S]*?):::/g, (_, content) => {
      const images = content.trim().split('\n')
        .map(l => l.replace(/<\/?p>/g, '').trim())
        .filter(l => l !== '');
      const slides = images.map(src =>
        `<li><img src="${src}" alt="Slide" uk-cover></li>`
      ).join('');
      return `
        <div class="uk-position-relative uk-visible-toggle uk-light custom-slideshow" tabindex="-1" uk-slideshow="animation: push; ratio: 16:9; autoplay: true; autoplay-interval: 4000">
          <ul class="uk-slideshow-items">${slides}</ul>
          <a class="uk-position-center-left uk-position-small uk-hidden-hover" href uk-slidenav-previous uk-slideshow-item="previous"></a>
          <a class="uk-position-center-right uk-position-small uk-hidden-hover" href uk-slidenav-next uk-slideshow-item="next"></a>
          <ul class="uk-slideshow-nav uk-dotnav uk-flex-center uk-margin"></ul>
        </div>`;
    });

    return html;
  }

  return { ALERT_TYPES, renderMarkdown };
})();

/* Global shortcuts */
const ALERT_TYPES = Markdown.ALERT_TYPES;
const renderMarkdown = Markdown.renderMarkdown;
