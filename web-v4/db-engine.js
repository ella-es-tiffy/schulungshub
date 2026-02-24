/* ================================================================
   SchulungsHub v4 – Database Engine
   sql.js (in-memory SQLite) + File System Access API

   - NAS-Datei = EINZIGE Datenquelle (Single Source of Truth)
   - Kein localStorage für DB-Daten
   - Awaited Writes mit Fehler-Feedback
   - Debounced Persist für schnelle Änderungen
   ================================================================ */

const DbEngine = (() => {
  const IDB_NAME = "schulungsHub_v4";
  const IDB_STORE = "handles";
  const IDB_HANDLE_KEY = "dbFile";
  const IDB_DIR_KEY = "dbDir";
  const DEBOUNCE_MS = 1500;

  let SQL = null;
  let db = null;
  let fileHandle = null;
  let _pendingHandle = null;
  let _writeTimer = null;
  let _dirty = false;
  let _persistPromise = null;
  let _onSaveStatus = null;
  let _onConnectionLost = null;

  /* ── WASM ── */

  async function loadWasm() {
    if (SQL) return;
    if (!window.__WASM_SEED) throw new Error("wasm-seed.js nicht geladen");
    const bin = atob(window.__WASM_SEED);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    SQL = await initSqlJs({ wasmBinary: bytes.buffer });
  }

  /* ── Schema ── */

  const SCHEMA = `
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, username TEXT NOT NULL, display_name TEXT NOT NULL,
      initials TEXT, role TEXT NOT NULL DEFAULT 'trainee', active INTEGER NOT NULL DEFAULT 1,
      password_hash TEXT, rfid_hash TEXT, created_at TEXT, created_by INTEGER,
      must_change_password INTEGER DEFAULT 0, theme TEXT
    );
    CREATE TABLE IF NOT EXISTS machines (id TEXT PRIMARY KEY, label TEXT NOT NULL, position INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS content_sections (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, position INTEGER DEFAULT 0,
      content_md TEXT, parent_id TEXT, updated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS learning_goals (
      id TEXT PRIMARY KEY, machine_id TEXT, phase TEXT, title TEXT NOT NULL,
      weight REAL DEFAULT 1, position INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trainee_id INTEGER, goal_id TEXT,
      score INTEGER, error_rate REAL, comment TEXT, action TEXT,
      evaluated_by INTEGER, evaluated_at TEXT
    );
    CREATE TABLE IF NOT EXISTS trainee_meta (
      trainee_id INTEGER PRIMARY KEY, feedback TEXT, conclusion TEXT, next_steps TEXT
    );
    CREATE TABLE IF NOT EXISTS exam_questions (
      id TEXT PRIMARY KEY, section_id TEXT, machine_id TEXT, phase TEXT,
      type TEXT NOT NULL DEFAULT 'single', question TEXT NOT NULL,
      options TEXT NOT NULL, explanation TEXT,
      difficulty INTEGER DEFAULT 1, created_by INTEGER, created_at TEXT
    );
    CREATE TABLE IF NOT EXISTS exam_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT, trainee_id INTEGER,
      score INTEGER, total INTEGER, passed INTEGER,
      answers TEXT, started_at TEXT, finished_at TEXT
    );
  `;

  function migrateSchema() {
    db.exec(SCHEMA);
    const migrations = [
      "ALTER TABLE content_sections ADD COLUMN updated_at TEXT",
      "ALTER TABLE users ADD COLUMN must_change_password INTEGER DEFAULT 0",
      "ALTER TABLE users ADD COLUMN theme TEXT",
      "ALTER TABLE evaluations ADD COLUMN error_rate REAL DEFAULT 0",
      "ALTER TABLE evaluations ADD COLUMN comment TEXT",
      "ALTER TABLE evaluations ADD COLUMN action TEXT",
      "ALTER TABLE evaluations ADD COLUMN evaluated_by INTEGER",
      "ALTER TABLE evaluations ADD COLUMN evaluated_at TEXT",
    ];
    for (const sql of migrations) {
      try { db.exec(sql); } catch { /* exists */ }
    }
  }

  /* ── Seed ── */

  function decodeSeed() {
    if (!window.__DB_SEED) return null;
    try {
      const bin = atob(window.__DB_SEED);
      const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (e) {
      console.warn("Seed decode failed:", e);
      return null;
    }
  }

  function loadSeedData() {
    const seed = decodeSeed();
    if (seed) importJsonInternal(seed);
  }

  /* ── SQL helpers ── */

  function queryAll(sql, params) {
    const stmt = db.prepare(sql);
    if (params) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  function run(sql, params) { db.run(sql, params); }

  /* ── IndexedDB (Handles) ── */

  function openIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function storeItem(key, value) {
    try {
      const idb = await openIdb();
      const tx = idb.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
      idb.close();
    } catch (e) { console.warn("IDB store failed:", e); }
  }

  async function loadItem(key) {
    try {
      const idb = await openIdb();
      return new Promise((resolve) => {
        const tx = idb.transaction(IDB_STORE, "readonly");
        const req = tx.objectStore(IDB_STORE).get(key);
        req.onsuccess = () => { idb.close(); resolve(req.result || null); };
        req.onerror = () => { idb.close(); resolve(null); };
      });
    } catch { return null; }
  }

  // Convenience wrappers
  function storeHandle(h) { return storeItem(IDB_HANDLE_KEY, h); }
  function loadStoredHandle() { return loadItem(IDB_HANDLE_KEY); }
  function storeDirHandle(h) { return storeItem(IDB_DIR_KEY, h); }
  function loadStoredDirHandle() { return loadItem(IDB_DIR_KEY); }

  /* ── File I/O ── */

  async function readFile() {
    if (!fileHandle) return null;
    try {
      const file = await fileHandle.getFile();
      if (file.size < 100) return null;
      return new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      console.warn("File read failed:", e);
      return null;
    }
  }

  async function writeFile(data) {
    if (!fileHandle) throw new Error("Kein Datei-Handle");
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
  }

  /* ── Import (for seed + JSON import) ── */

  function importJsonInternal(data) {
    db.run("DELETE FROM meta; DELETE FROM users; DELETE FROM machines; DELETE FROM content_sections; DELETE FROM learning_goals; DELETE FROM evaluations; DELETE FROM trainee_meta; DELETE FROM exam_questions; DELETE FROM exam_results");

    for (const [k, v] of Object.entries(data.meta || {}))
      run("INSERT OR REPLACE INTO meta VALUES (?,?)", [k, String(v ?? "")]);

    for (const u of data.users || [])
      run("INSERT OR REPLACE INTO users VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [
        u.id, u.username, u.display_name, u.initials || "", u.role, u.active !== false ? 1 : 0,
        u.password_hash || "", u.rfid_hash || "", u.created_at || "", u.created_by || null,
        u.must_change_password ? 1 : 0, u.theme || null]);

    for (const m of data.machines || [])
      run("INSERT OR REPLACE INTO machines VALUES (?,?,?)", [String(m.id), m.label, m.position || 0]);

    function flattenSections(sections, parentId) {
      for (const s of sections || []) {
        run("INSERT OR REPLACE INTO content_sections VALUES (?,?,?,?,?,?)", [
          String(s.id), s.title, s.position || 0, s.content_md || "", parentId, s.updated_at || null]);
        if (s.children) flattenSections(s.children, String(s.id));
      }
    }
    flattenSections(data.content_sections || [], null);

    for (const g of data.learning_goals || [])
      run("INSERT OR REPLACE INTO learning_goals VALUES (?,?,?,?,?,?)", [
        String(g.id), String(g.machine_id || ""), g.phase || "", g.title, g.weight || 1, g.position || 0]);

    for (const e of data.evaluations || [])
      run("INSERT INTO evaluations (trainee_id,goal_id,score,error_rate,comment,action,evaluated_by,evaluated_at) VALUES (?,?,?,?,?,?,?,?)", [
        e.trainee_id, e.goal_id, e.score, e.error_rate || 0, e.comment || "", e.action || "",
        e.evaluated_by || e.evaluator_id || null, e.evaluated_at || e.created_at || ""]);

    for (const [tid, m] of Object.entries(data.trainee_meta || {}))
      run("INSERT OR REPLACE INTO trainee_meta VALUES (?,?,?,?)", [
        parseInt(tid), m.feedback || "", m.conclusion || "", m.next_steps || ""]);

    for (const q of data.exam_questions || [])
      run("INSERT OR REPLACE INTO exam_questions VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
        q.id, q.section_id || null, q.machine_id || null, q.phase || null,
        q.type || "single", q.question, q.options, q.explanation || "",
        q.difficulty || 1, q.created_by || null, q.created_at || ""]);

    for (const r of data.exam_results || [])
      run("INSERT INTO exam_results (trainee_id,score,total,passed,answers,started_at,finished_at) VALUES (?,?,?,?,?,?,?)", [
        r.trainee_id, r.score, r.total, r.passed ? 1 : 0, r.answers, r.started_at || "", r.finished_at || ""]);
  }

  /* ── toJson (nur für Export/Backup) ── */

  function toJson() {
    const meta = {};
    queryAll("SELECT * FROM meta").forEach(r => { meta[r.key] = r.value; });
    meta.schema_version = parseInt(meta.schema_version) || 3;

    const users = queryAll("SELECT * FROM users").map(u => ({
      ...u, active: u.active !== 0, must_change_password: !!u.must_change_password,
    }));
    const machines = queryAll("SELECT * FROM machines ORDER BY position");
    const learning_goals = queryAll("SELECT * FROM learning_goals ORDER BY position");
    const evaluations = queryAll("SELECT * FROM evaluations");

    const allSections = queryAll("SELECT * FROM content_sections ORDER BY position");
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
    queryAll("SELECT * FROM trainee_meta").forEach(r => {
      trainee_meta[r.trainee_id] = { feedback: r.feedback, conclusion: r.conclusion, next_steps: r.next_steps };
    });

    const exam_questions = queryAll("SELECT * FROM exam_questions");
    const exam_results = queryAll("SELECT * FROM exam_results");

    return { meta, users, machines, content_sections, learning_goals, evaluations, trainee_meta, exam_questions, exam_results };
  }

  /* ── Persistence ── */

  function schedulePersist() {
    _dirty = true;
    if (_onSaveStatus) _onSaveStatus("dirty");
    clearTimeout(_writeTimer);
    _writeTimer = setTimeout(() => { persistNow(); }, DEBOUNCE_MS);
  }

  async function persistNow() {
    clearTimeout(_writeTimer);
    if (!db) return false;

    if (!fileHandle) {
      _dirty = true;
      if (_onSaveStatus) _onSaveStatus("error");
      if (_onConnectionLost) _onConnectionLost(new Error("Keine Datei verbunden"));
      return false;
    }

    if (_persistPromise) await _persistPromise;

    if (_onSaveStatus) _onSaveStatus("saving");

    _persistPromise = (async () => {
      try {
        run("INSERT OR REPLACE INTO meta VALUES ('updated_at', ?)", [new Date().toISOString()]);
        const data = db.export();
        await writeFile(data);
        _dirty = false;
        if (_onSaveStatus) _onSaveStatus("saved");
        console.info("✓ data.db geschrieben:", (data.length / 1024).toFixed(1), "KB");
        return true;
      } catch (e) {
        console.error("Persist failed:", e);
        _dirty = true;
        if (_onSaveStatus) _onSaveStatus("error");
        if (_onConnectionLost) _onConnectionLost(e);
        return false;
      } finally {
        _persistPromise = null;
      }
    })();

    return _persistPromise;
  }

  /* ── Public API ── */

  return {

    /** Try reconnect to stored NAS handle.
     *  Always initializes DB (from file or seed).
     *  Returns: "connected" | "needs_permission" | "no_handle" */
    async tryReconnect() {
      await loadWasm();

      // Always init DB from seed first (instant, no file picker needed)
      if (!db) {
        db = new SQL.Database();
        migrateSchema();
        loadSeedData();
        console.info("DB initialized from seed");
      }

      const saved = await loadStoredHandle();
      if (!saved) return "no_handle";

      try {
        const perm = await saved.queryPermission({ mode: "readwrite" });
        if (perm === "granted") {
          fileHandle = saved;
          const data = await readFile();
          if (data && data.length > 100) {
            db.close();
            db = new SQL.Database(data);
            migrateSchema();
            console.info("DB loaded from NAS (auto-reconnect)");
            return "connected";
          }
        }
        _pendingHandle = saved;
        return "needs_permission";
      } catch (e) {
        console.warn("Auto-reconnect failed:", e);
        _pendingHandle = saved;
        return "needs_permission";
      }
    },

    /** Request permission for stored handle (user click required) */
    async requestPermission() {
      const handle = _pendingHandle || fileHandle;
      if (!handle) return false;
      const perm = await handle.requestPermission({ mode: "readwrite" });
      if (perm !== "granted") return false;

      fileHandle = handle;
      _pendingHandle = null;
      const data = await readFile();
      if (data && data.length > 100) {
        if (db) db.close();
        db = new SQL.Database(data);
        migrateSchema();
        console.info("DB loaded from NAS (permission granted)");
      }
      return true;
    },

    /** Connect via directory picker → auto-finds data.db in chosen folder.
     *  Stores dir handle so future pickers start in the right place. */
    async connect() {
      if (!window.showDirectoryPicker) throw new Error("File System Access API nicht verfügbar – Chrome/Edge nötig");

      // Use stored dir handle as startIn (so picker opens in last-used folder)
      const storedDir = await loadStoredDirHandle();
      const dirHandle = await window.showDirectoryPicker({
        id: "schulungshub",
        mode: "readwrite",
        ...(storedDir ? { startIn: storedDir } : {}),
      });
      await storeDirHandle(dirHandle);

      // Auto-get data.db from chosen directory (create if missing)
      fileHandle = await dirHandle.getFileHandle("data.db", { create: true });
      await storeHandle(fileHandle);

      const data = await readFile();
      if (data && data.length > 100) {
        if (db) db.close();
        db = new SQL.Database(data);
        migrateSchema();
        console.info("DB loaded from", dirHandle.name + "/data.db");
      } else {
        // Empty/new file → write current in-memory DB to it
        await persistNow();
        console.info("Seed DB written to", dirHandle.name + "/data.db");
      }
    },

    /** Pick a specific .db file (for "DB wechseln"). Starts in stored dir. */
    async connectFile() {
      const storedDir = await loadStoredDirHandle();
      const pickerOpts = {
        types: [{ description: "SQLite Datenbank", accept: { "application/octet-stream": [".db"] } }],
        ...(storedDir ? { startIn: storedDir } : {}),
      };

      let handle;
      if (window.showOpenFilePicker) {
        const [h] = await window.showOpenFilePicker(pickerOpts);
        handle = h;
      } else {
        throw new Error("File System Access API nicht verfügbar");
      }

      fileHandle = handle;
      await storeHandle(handle);

      const data = await readFile();
      if (data && data.length > 100) {
        if (db) db.close();
        db = new SQL.Database(data);
        migrateSchema();
        console.info("DB loaded from picked file");
      } else {
        await persistNow();
        console.info("Current DB written to new file");
      }
    },

    disconnect() {
      fileHandle = null;
      _pendingHandle = null;
    },

    /* ── SQL Access ── */

    queryAll(sql, params) { return queryAll(sql, params); },

    /** Write + auto-schedule debounced persist */
    run(sql, params) {
      run(sql, params);
      schedulePersist();
    },

    /** Write without auto-persist (for batch operations) */
    runBatch(sql, params) {
      run(sql, params);
    },

    exec(sql) { db.exec(sql); },

    /* ── Persistence ── */

    schedulePersist,
    persistNow,

    /* ── Bulk ── */

    async importJson(data) {
      db.exec("BEGIN TRANSACTION");
      try {
        importJsonInternal(data);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return persistNow();
    },

    toJson,
    exportBinary() { return db.export(); },

    /* ── Status ── */

    get connected() { return fileHandle !== null; },
    get hasPendingHandle() { return _pendingHandle !== null; },
    get dirty() { return _dirty; },
    get ready() { return db !== null; },

    set onSaveStatus(fn) { _onSaveStatus = fn; },
    set onConnectionLost(fn) { _onConnectionLost = fn; },
  };
})();
