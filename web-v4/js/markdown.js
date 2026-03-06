/* ================================================================
   SchulungsHub v4 – Markdown Rendering
   Custom alert blocks, slideshow blocks
   Depends on: vendor/marked.min.js
   ================================================================ */
const Markdown = (() => {
  const ALERT_TYPES = {
    TIP:       { cls: "alert-tip",       icon: "◈", label: "Tipp" },
    NOTE:      { cls: "alert-note",      icon: "⊡", label: "Hinweis" },
    WARNING:   { cls: "alert-warning",   icon: "!", label: "Warnung" },
    IMPORTANT: { cls: "alert-important", icon: "★", label: "Achtung" },
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
            <span class="alert-title">${val.label}</span>
          </div>
          <div class="alert-content"><p>${content.trim()}</p></div>
        </div>`
      );
    });

    // :::gelb / :::orange / :::rot → Störungsanzeigen
    const STOERUNG_COLORS = { gelb: '#ffd600', orange: '#ff9100', rot: '#ff1744' };
    Object.entries(STOERUNG_COLORS).forEach(([key, bg]) => {
      const re = new RegExp(`:::${key}\\s*([\\s\\S]*?):::`, 'gi');
      html = html.replace(re, (_, inner) => {
        const text = inner.replace(/<br\s*\/?>/gi, '\n').replace(/<\/?p>/g, '').trim();
        const lines = text.split('\n').map(l => `<p style="margin:0">${l}</p>`).join('');
        return `<div class="stoerung" style="background:${bg}">${lines}</div>`;
      });
    });

    // :::slideshow blocks → custom slideshow (no UIkit)
    html = html.replace(/:::slideshow\s*([\s\S]*?):::/g, (_, content) => {
      const images = content.replace(/<br\s*\/?>/gi, '\n').trim().split('\n')
        .map(l => l.replace(/<\/?p>/g, '').trim())
        .filter(l => l !== '');
      const slides = images.map((src, i) =>
        `<div class="cs-slide${i === 0 ? ' cs-active' : ''}"><img src="${src}" alt="Slide"></div>`
      ).join('');
      const dots = images.map((_, i) =>
        `<span class="cs-dot${i === 0 ? ' cs-active' : ''}" data-idx="${i}"></span>`
      ).join('');
      return `
        <div class="custom-slideshow" data-interval="10000">
          <div class="cs-track">${slides}</div>
          <button class="cs-arrow cs-prev" type="button">&#10094;</button>
          <button class="cs-arrow cs-next" type="button">&#10095;</button>
          <div class="cs-dots">${dots}</div>
        </div>`;
    });

    return html;
  }

  /* Activate all custom slideshows in the DOM */
  function initSlideshows(root) {
    (root || document).querySelectorAll('.custom-slideshow').forEach(el => {
      if (el._csInit) return;
      el._csInit = true;

      const track  = el.querySelector('.cs-track');
      const slides = el.querySelectorAll('.cs-slide');
      const dots   = el.querySelectorAll('.cs-dot');
      if (slides.length < 2) return;

      let cur = 0;
      const ms = parseInt(el.dataset.interval) || 4000;

      // Wait for all images to load, then fix track height to tallest image
      const imgs = el.querySelectorAll('.cs-slide img');
      let loaded = 0;
      function lockHeight() {
        // Briefly show all slides to measure natural height
        slides.forEach(s => { s.style.display = 'flex'; s.style.visibility = 'hidden'; });
        let maxH = 0;
        imgs.forEach(img => { if (img.offsetHeight > maxH) maxH = img.offsetHeight; });
        // Restore: hide all, show only active
        slides.forEach(s => { s.style.display = ''; s.style.visibility = ''; });
        if (maxH > 0) track.style.height = maxH + 'px';
      }
      imgs.forEach(img => {
        if (img.complete) { loaded++; } else {
          img.addEventListener('load', () => { loaded++; if (loaded === imgs.length) lockHeight(); });
          img.addEventListener('error', () => { loaded++; if (loaded === imgs.length) lockHeight(); });
        }
      });
      if (loaded === imgs.length) lockHeight();

      let animating = false;
      function show(idx) {
        const next = ((idx % slides.length) + slides.length) % slides.length;
        if (next === cur || animating) return;
        animating = true;
        const dir = next > cur || (cur === slides.length - 1 && next === 0) ? 1 : -1;
        const oldSlide = slides[cur];
        const newSlide = slides[next];

        // Position new slide off-screen in swipe direction
        newSlide.style.transform = `translateX(${dir * 100}%)`;
        newSlide.style.opacity = '1';
        newSlide.classList.add('cs-active');

        // Force reflow then animate both
        newSlide.offsetWidth;
        oldSlide.classList.add('cs-animating');
        newSlide.classList.add('cs-animating');
        oldSlide.style.transform = `translateX(${-dir * 100}%)`;
        oldSlide.style.opacity = '0';
        newSlide.style.transform = 'translateX(0)';

        dots[cur]?.classList.remove('cs-active');
        dots[next]?.classList.add('cs-active');

        newSlide.addEventListener('transitionend', function done(e) {
          if (e.propertyName !== 'transform') return;
          newSlide.removeEventListener('transitionend', done);
          oldSlide.classList.remove('cs-active', 'cs-animating');
          oldSlide.style.transform = '';
          oldSlide.style.opacity = '';
          newSlide.classList.remove('cs-animating');
          newSlide.style.transform = '';
          newSlide.style.opacity = '';
          animating = false;
        }, { once: false });

        cur = next;
      }

      el.querySelector('.cs-prev')?.addEventListener('click', () => { show(cur - 1); reset(); });
      el.querySelector('.cs-next')?.addEventListener('click', () => { show(cur + 1); reset(); });
      dots.forEach(d => d.addEventListener('click', () => { show(parseInt(d.dataset.idx)); reset(); }));

      let timer = setInterval(() => show(cur + 1), ms);
      function reset() { clearInterval(timer); timer = setInterval(() => show(cur + 1), ms); }
    });
  }

  return { ALERT_TYPES, renderMarkdown, initSlideshows };
})();

/* Global shortcuts */
const ALERT_TYPES = Markdown.ALERT_TYPES;
const renderMarkdown = Markdown.renderMarkdown;
const initSlideshows = Markdown.initSlideshows;
