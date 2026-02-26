/* ================================================================
   SchulungsHub v4 – Preferences
   Theme, Font, localStorage-Persistenz
   Depends on: js/utils.js ($, $$), js/state.js (S)
   ================================================================ */
const Prefs = (() => {
  const PREFS_KEY = "schulungsHub.prefs";

  function loadPrefs() {
    try { Object.assign(S.prefs, JSON.parse(localStorage.getItem(PREFS_KEY))); } catch { /* */ }
  }

  function savePrefs() { localStorage.setItem(PREFS_KEY, JSON.stringify(S.prefs)); }

  function applyTheme(theme) {
    S.prefs.theme = theme;
    document.documentElement.dataset.theme = theme;
    updateThemeIcon();
    savePrefs();

    if (S.user) {
      DbEngine.run("UPDATE users SET theme=? WHERE id=?", [theme, S.user.id]);
    }
  }

  function applyFont(size) {
    S.prefs.font = size;
    document.documentElement.className = `font-${size.toLowerCase()}`;
    $$(".font-switcher button").forEach(b => b.classList.toggle("active", b.dataset.font === size));
    savePrefs();
  }

  function updateThemeIcon() {
    const icon = $("#theme-icon");
    if (icon) icon.textContent = S.prefs.theme === "light" ? "☀" : "☽";
  }

  function toggleThemeReveal() {
    const newTheme = S.prefs.theme === "light" ? "dark" : "light";
    const overlay = $("#theme-reveal");

    if (!overlay) { applyTheme(newTheme); return; }

    overlay.style.backgroundColor = newTheme === "dark" ? "#121212" : "#ffffff";
    overlay.classList.add("revealing");

    setTimeout(() => {
      applyTheme(newTheme);
      setTimeout(() => overlay.classList.remove("revealing"), 600);
    }, 400);
  }

  return { PREFS_KEY, loadPrefs, savePrefs, applyTheme, applyFont, updateThemeIcon, toggleThemeReveal };
})();

/* Global shortcuts */
const PREFS_KEY = Prefs.PREFS_KEY;
const loadPrefs = Prefs.loadPrefs;
const savePrefs = Prefs.savePrefs;
const applyTheme = Prefs.applyTheme;
const applyFont = Prefs.applyFont;
const updateThemeIcon = Prefs.updateThemeIcon;
const toggleThemeReveal = Prefs.toggleThemeReveal;
