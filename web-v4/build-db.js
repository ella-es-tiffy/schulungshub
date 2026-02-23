#!/usr/bin/env node
/**
 * build-db.js – Converts decoded JSON data into data.db (SQLite)
 * Run: node build-db.js
 * Requires: sql.js (npm install sql.js)
 */

const fs = require("fs");
const path = require("path");

async function main() {
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();
  const db = new SQL.Database();

  // ── Load source data ──
  let data;
  const dataJsPath = path.join(__dirname, "data.js");
  const src = fs.readFileSync(dataJsPath, "utf8");

  // Try encoded format
  const match = src.match(/window\._ED\s*=\s*"([^"]+)"/);
  if (match) {
    const key = "SchulungsHub-Siebdruck-2026";
    const raw = Buffer.from(match[1], "base64");
    const keyBytes = Buffer.from(key);
    for (let i = 0; i < raw.length; i++) raw[i] = raw[i] ^ keyBytes[i % keyBytes.length];
    data = JSON.parse(raw.toString("utf8"));
  } else {
    // Try plain format
    const plain = src.match(/window\.FI_TEACH_DEFAULT_DATA\s*=\s*(\{[\s\S]+\});?\s*$/);
    if (plain) data = JSON.parse(plain[1]);
    else { console.error("Cannot parse data.js"); process.exit(1); }
  }

  // ── Create tables ──
  db.run(`CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  db.run(`CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    display_name TEXT NOT NULL,
    initials TEXT,
    role TEXT NOT NULL DEFAULT 'trainee',
    active INTEGER NOT NULL DEFAULT 1,
    password_hash TEXT,
    rfid_hash TEXT,
    created_at TEXT,
    created_by INTEGER,
    must_change_password INTEGER DEFAULT 0,
    theme TEXT
  )`);

  db.run(`CREATE TABLE machines (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    position INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE content_sections (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    position INTEGER DEFAULT 0,
    content_md TEXT,
    parent_id TEXT
  )`);

  db.run(`CREATE TABLE learning_goals (
    id TEXT PRIMARY KEY,
    machine_id TEXT,
    phase TEXT,
    title TEXT NOT NULL,
    weight REAL DEFAULT 1,
    position INTEGER DEFAULT 0
  )`);

  db.run(`CREATE TABLE evaluations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trainee_id INTEGER,
    goal_id TEXT,
    score INTEGER,
    error_rate REAL,
    comment TEXT,
    action TEXT,
    evaluator_id INTEGER,
    created_at TEXT
  )`);

  db.run(`CREATE TABLE trainee_meta (
    trainee_id INTEGER PRIMARY KEY,
    feedback TEXT,
    conclusion TEXT,
    next_steps TEXT
  )`);

  // ── Insert meta ──
  const meta = data.meta || {};
  db.run(`INSERT INTO meta VALUES (?, ?)`, ["schema_version", String(meta.schema_version || 3)]);
  db.run(`INSERT INTO meta VALUES (?, ?)`, ["app_name", meta.app_name || "SchulungsHub"]);
  db.run(`INSERT INTO meta VALUES (?, ?)`, ["updated_at", meta.updated_at || new Date().toISOString()]);

  // ── Insert users ──
  const stmtUser = db.prepare(`INSERT INTO users VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (const u of data.users || []) {
    stmtUser.run([u.id, u.username, u.display_name, u.initials || "", u.role,
      u.active !== false ? 1 : 0, u.password_hash || "", u.rfid_hash || "",
      u.created_at || "", u.created_by || null, u.must_change_password ? 1 : 0,
      u.theme || null]);
  }
  stmtUser.free();

  // ── Insert machines ──
  const stmtMachine = db.prepare(`INSERT INTO machines VALUES (?,?,?)`);
  for (const m of data.machines || []) {
    stmtMachine.run([String(m.id), m.label, m.position || 0]);
  }
  stmtMachine.free();

  // ── Insert content sections (flatten children) ──
  const stmtContent = db.prepare(`INSERT INTO content_sections VALUES (?,?,?,?,?)`);
  for (const s of data.content_sections || []) {
    stmtContent.run([String(s.id), s.title, s.position || 0, s.content_md || "", null]);
    if (s.children) {
      for (const c of s.children) {
        stmtContent.run([String(c.id), c.title, c.position || 0, c.content_md || "", String(s.id)]);
      }
    }
  }
  stmtContent.free();

  // ── Insert learning goals ──
  const stmtGoal = db.prepare(`INSERT INTO learning_goals VALUES (?,?,?,?,?,?)`);
  for (const g of data.learning_goals || []) {
    stmtGoal.run([String(g.id), String(g.machine_id || ""), g.phase || "", g.title, g.weight || 1, g.position || 0]);
  }
  stmtGoal.free();

  // ── Insert evaluations ──
  const stmtEval = db.prepare(`INSERT INTO evaluations (trainee_id, goal_id, score, error_rate, comment, action, evaluator_id, created_at) VALUES (?,?,?,?,?,?,?,?)`);
  for (const e of data.evaluations || []) {
    stmtEval.run([e.trainee_id, e.goal_id, e.score, e.error_rate || 0, e.comment || "", e.action || "", e.evaluator_id || null, e.created_at || ""]);
  }
  stmtEval.free();

  // ── Insert trainee_meta ──
  const stmtMeta = db.prepare(`INSERT INTO trainee_meta VALUES (?,?,?,?)`);
  for (const [tid, m] of Object.entries(data.trainee_meta || {})) {
    stmtMeta.run([parseInt(tid), m.feedback || "", m.conclusion || "", m.next_steps || ""]);
  }
  stmtMeta.free();

  // ── Write .db file ──
  const outPath = path.join(__dirname, "data.db");
  const buffer = db.export();
  fs.writeFileSync(outPath, Buffer.from(buffer));
  db.close();

  const size = fs.statSync(outPath).size;
  console.log(`✓ data.db erstellt (${(size / 1024).toFixed(1)} KB)`);
  console.log(`  ${(data.users || []).length} Users`);
  console.log(`  ${(data.machines || []).length} Machines`);

  // Count sections including children
  let secCount = 0;
  for (const s of data.content_sections || []) { secCount++; secCount += (s.children || []).length; }
  console.log(`  ${secCount} Content Sections`);
  console.log(`  ${(data.learning_goals || []).length} Learning Goals`);
  console.log(`  ${(data.evaluations || []).length} Evaluations`);
}

main().catch(e => { console.error(e); process.exit(1); });
