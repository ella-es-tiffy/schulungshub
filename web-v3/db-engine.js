/* ================================================================
   SchulungsHub v3 – Database Engine
   sql.js (in-memory SQLite) + File System Access API

   - Liest/schreibt data.db direkt auf dem NAS
   - FileHandle wird in IndexedDB gespeichert (auto-reconnect)
   - localStorage als Fallback wenn kein File verbunden
   ================================================================ */

const DbEngine = (() => {
  const LS_KEY = "schulungsHub.sqlite.v3";
  const IDB_NAME = "schulungsHub_handles";
  const IDB_STORE = "handles";
  const IDB_HANDLE_KEY = "dbFile";

  let SQL = null;
  let db = null;
  let fileHandle = null;      // Active handle with granted permission
  let _pendingHandle = null;  // Stored handle, permission not yet granted
  let _onWriteFail = null;    // Callback when file write fails

  /* ── WASM loading ── */

  async function loadWasm() {
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
  `;

  /* ── Schema migration (add missing columns to existing DBs) ── */

  function migrateSchema() {
    // Ensure all tables exist
    exec(SCHEMA);
    // Add columns that might be missing in older databases
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
      try { exec(sql); } catch { /* column already exists */ }
    }
  }

  /* ── Seed decoder ── */

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
  function exec(sql) { db.exec(sql); }

  /* ── localStorage helpers ── */

  function uint8ToBase64(bytes) {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function base64ToUint8(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return raw ? base64ToUint8(raw) : null;
    } catch { return null; }
  }

  function saveToStorage(data) {
    try { localStorage.setItem(LS_KEY, uint8ToBase64(data)); } catch { /* quota */ }
  }

  /* ── IndexedDB for FileHandle persistence ── */

  function openIdb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function storeHandle(handle) {
    try {
      const idb = await openIdb();
      const tx = idb.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(handle, IDB_HANDLE_KEY);
      await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
      idb.close();
    } catch (e) { console.warn("Handle store failed:", e); }
  }

  async function loadStoredHandle() {
    try {
      const idb = await openIdb();
      return new Promise((resolve) => {
        const tx = idb.transaction(IDB_STORE, "readonly");
        const req = tx.objectStore(IDB_STORE).get(IDB_HANDLE_KEY);
        req.onsuccess = () => { idb.close(); resolve(req.result || null); };
        req.onerror = () => { idb.close(); resolve(null); };
      });
    } catch { return null; }
  }

  /* ── File I/O ── */

  async function readFile() {
    if (!fileHandle) return null;
    try {
      const file = await fileHandle.getFile();
      if (file.size < 100) return null; // Empty/invalid
      return new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      console.warn("File read failed:", e);
      return null;
    }
  }

  async function writeFile(data) {
    if (!fileHandle) return;
    const writable = await fileHandle.createWritable();
    await writable.write(data);
    await writable.close();
    console.info("✓ data.db geschrieben:", (data.length / 1024).toFixed(1), "KB");
  }

  /* ── toJson / fromJson ── */

  function toJson() {
    const meta = {};
    queryAll("SELECT * FROM meta").forEach(r => { meta[r.key] = r.value; });
    meta.schema_version = parseInt(meta.schema_version) || 3;

    const users = queryAll("SELECT * FROM users").map(u => ({
      ...u, active: u.active !== 0, must_change_password: !!u.must_change_password,
    }));
    const machines = queryAll("SELECT * FROM machines");
    const learning_goals = queryAll("SELECT * FROM learning_goals");
    const evaluations = queryAll("SELECT * FROM evaluations");

    const allSections = queryAll("SELECT * FROM content_sections");
    function buildTree(parentId) {
      return allSections
        .filter(s => (s.parent_id || null) === parentId)
        .sort((a, b) => (a.position || 0) - (b.position || 0))
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

    return { meta, users, machines, content_sections, learning_goals, evaluations, trainee_meta };
  }

  function toJsonFrom(binary) {
    const tempDb = new SQL.Database(binary);
    const oldDb = db;
    db = tempDb;
    migrateSchema(); // Ensure remote DB has all columns
    const json = toJson();
    db = oldDb;
    tempDb.close();
    return json;
  }

  function fromJson(data) {
    exec("DELETE FROM meta; DELETE FROM users; DELETE FROM machines; DELETE FROM content_sections; DELETE FROM learning_goals; DELETE FROM evaluations; DELETE FROM trainee_meta");

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
  }

  /* ── Public API ── */

  return {
    /** Initialize: load WASM, open DB from file/localStorage/seed */
    async init() {
      if (db) return;
      await loadWasm();

      // 1. Try auto-reconnect to saved file handle
      const saved = await loadStoredHandle();
      if (saved) {
        try {
          const perm = await saved.queryPermission({ mode: "readwrite" });
          if (perm === "granted") {
            fileHandle = saved;
            const data = await readFile();
            if (data) {
              db = new SQL.Database(data);
              migrateSchema();
              saveToStorage(db.export()); // Re-export after migration
              console.info("DB loaded from file (auto-reconnect)");
              return;
            }
          } else {
            // Permission not auto-granted - store for later requestPermission()
            _pendingHandle = saved;
          }
        } catch (e) {
          console.warn("Auto-reconnect failed:", e);
        }
      }

      // 2. Try localStorage
      const stored = loadFromStorage();
      if (stored && stored.length > 100) {
        db = new SQL.Database(stored);
        migrateSchema();
        console.info("DB loaded from localStorage");
        return;
      }

      // 3. Migrate old JSON format
      const OLD_KEY = "schulungsHub.db.v3";
      const oldRaw = localStorage.getItem(OLD_KEY);
      if (oldRaw) {
        try {
          db = new SQL.Database();
          exec(SCHEMA);
          fromJson(JSON.parse(oldRaw));
          saveToStorage(db.export());
          localStorage.removeItem(OLD_KEY);
          console.info("Migrated old JSON → SQLite");
          return;
        } catch (e) { console.warn("Migration failed:", e); }
      }

      // 4. Seed
      db = new SQL.Database();
      exec(SCHEMA);
      const seed = decodeSeed();
      if (seed) {
        fromJson(seed);
        saveToStorage(db.export());
        console.info("DB created from seed");
      }
    },

    /** Pick a .db file on the NAS (one-time setup) */
    async connect() {
      if (!window.showOpenFilePicker) throw new Error("Browser unterstützt File System Access nicht");
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: "SQLite Datenbank", accept: { "application/octet-stream": [".db"] } }],
      });
      fileHandle = handle;
      await storeHandle(handle);

      // Read existing data from file
      const data = await readFile();
      if (data) {
        if (db) db.close();
        db = new SQL.Database(data);
        migrateSchema();
        saveToStorage(db.export());
        console.info("DB loaded from file");
      } else {
        // New/empty file: write current DB to it
        await writeFile(db.export());
        console.info("Current DB written to new file");
      }
    },

    /** Try to get permission for stored handle (after browser restart) */
    async requestPermission() {
      const handle = fileHandle || _pendingHandle;
      if (!handle) return false;
      try {
        const perm = await handle.requestPermission({ mode: "readwrite" });
        if (perm === "granted") {
          fileHandle = handle;
          _pendingHandle = null;
          const data = await readFile();
          if (data) {
            if (db) db.close();
            db = new SQL.Database(data);
            migrateSchema();
            saveToStorage(db.export());
          }
          return true;
        }
      } catch { /* */ }
      return false;
    },

    disconnect() {
      fileHandle = null;
      _pendingHandle = null;
    },

    /** Persist: write to file (if connected) + localStorage */
    persist() {
      const data = db.export();
      saveToStorage(data);
      if (fileHandle) {
        writeFile(data).catch(e => {
          console.warn("File write failed:", e);
          // SecurityError = Browser braucht User-Klick für Schreibzugriff
          fileHandle = null;
          _pendingHandle = null;
          if (_onWriteFail) _onWriteFail(e);
        });
      }
    },

    /** Read remote file and return as JSON (for sync/merge) */
    async readRemoteJson() {
      const data = await readFile();
      if (!data) return null;
      return toJsonFrom(data);
    },

    /** Reload DB from the file (after merge) */
    reloadFromFile(binary) {
      if (db) db.close();
      db = new SQL.Database(binary);
    },

    toJson,
    fromJson,
    exportBinary() { return db.export(); },
    queryAll,
    run,

    get connected() { return fileHandle !== null; },
    get hasStoredHandle() { return _pendingHandle !== null; },
    get ready() { return db !== null; },
    set onWriteFail(fn) { _onWriteFail = fn; },
  };
})();
