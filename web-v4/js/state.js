/* ================================================================
   SchulungsHub v4 – State & Data Access
   S-Objekt, reloadState(), User-Queries, Rollen-Checks
   Depends on: db-engine.js
   ================================================================ */
const State = (() => {
  const DEFAULT_PHASES = [
    { id: "P1", label: "P1 · Grundlagen" },
    { id: "P2", label: "P2 · Fortgeschritten" },
    { id: "P3", label: "P3 · Experte" },
    { id: "P4", label: "P4 · Spezialist" },
    { id: "Mes", label: "MES" },
  ];

  function getPhases() {
    try {
      const raw = S.db?.meta?.phase_order;
      if (raw) {
        const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (Array.isArray(arr) && arr.length) return arr;
      }
    } catch { /* fallback */ }
    return DEFAULT_PHASES;
  }

  function reloadState() {
    const meta = {};
    DbEngine.queryAll("SELECT * FROM meta").forEach(r => { meta[r.key] = r.value; });
    meta.schema_version = parseInt(meta.schema_version) || 3;

    const users = DbEngine.queryAll("SELECT * FROM users").map(u => ({
      ...u, active: u.active !== 0, must_change_password: !!u.must_change_password,
      has_training: !!u.has_training, motorik_level: u.motorik_level != null ? u.motorik_level : 2,
    }));

    const machines = DbEngine.queryAll("SELECT * FROM machines ORDER BY position");
    const learning_goals = DbEngine.queryAll("SELECT * FROM learning_goals ORDER BY position");
    const evaluations = DbEngine.queryAll("SELECT * FROM evaluations");

    const allSections = DbEngine.queryAll("SELECT * FROM content_sections ORDER BY position");
    function buildTree(parentId) {
      return allSections
        .filter(s => (s.parent_id || null) === parentId)
        .map(s => {
          const { parent_id, ...rest } = s;
          const kids = buildTree(String(s.id));
          if (kids.length) rest.children = kids;
          return rest;
        });
    }
    const content_sections = buildTree(null);

    const trainee_meta = {};
    DbEngine.queryAll("SELECT * FROM trainee_meta").forEach(r => {
      trainee_meta[r.trainee_id] = { feedback: r.feedback, conclusion: r.conclusion, next_steps: r.next_steps };
    });

    S.db = { meta, users, machines, content_sections, learning_goals, evaluations, trainee_meta };
  }

  function allUsers() { return (S.db?.users || []).filter(u => u.active !== false); }
  function allTrainees() { return allUsers().filter(u => u.role === "trainee").sort((a, b) => a.display_name.localeCompare(b.display_name, "de")); }
  function findUser(id) { return allUsers().find(u => u.id === id) || null; }
  function userName(id) { const u = findUser(id); return u ? u.display_name : "?"; }
  function canVerify() { return S.user && (S.user.role === "admin" || S.user.role === "trainer"); }
  function canAdmin() { return S.user && S.user.role === "admin"; }
  function canEdit() { return canAdmin(); }
  function machineLabel(id) { const m = (S.db?.machines || []).find(m => m.id === id); return m ? m.label : id; }

  return { DEFAULT_PHASES, getPhases, reloadState, allUsers, allTrainees, findUser, userName, canVerify, canAdmin, canEdit, machineLabel };
})();

/* Global state object */
const S = {
  db: null,
  user: null,
  trainees: [],
  selectedTraineeId: null,
  evalMap: {},
  prefs: { theme: "light", font: "M" },
  loginMode: "password",
  editingSection: null,
  sortMode: false,
  fieldTimers: {},
};

/* Global shortcuts */
const reloadState = State.reloadState;
const allUsers = State.allUsers;
const allTrainees = State.allTrainees;
const findUser = State.findUser;
const userName = State.userName;
const canVerify = State.canVerify;
const canAdmin = State.canAdmin;
const canEdit = State.canEdit;
const machineLabel = State.machineLabel;
const getPhases = State.getPhases;
const DEFAULT_PHASES = State.DEFAULT_PHASES;
