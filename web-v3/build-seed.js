#!/usr/bin/env node
/**
 * build-seed.js – Generates data-seed.js from data.db
 * Reads SQLite DB → JSON → Base64 → JS file with global variable.
 * The browser loads data-seed.js via <script> tag (works on file:// protocol).
 * Run: node build-seed.js
 */

const fs = require("fs");
const path = require("path");

async function main() {
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();

  const dbPath = path.join(__dirname, "data.db");
  if (!fs.existsSync(dbPath)) {
    console.error("data.db not found. Run build-db.js first.");
    process.exit(1);
  }

  const db = new SQL.Database(fs.readFileSync(dbPath));

  function rowsToArray(table) {
    const res = db.exec(`SELECT * FROM ${table}`);
    if (!res.length) return [];
    const cols = res[0].columns;
    return res[0].values.map(row => {
      const obj = {};
      cols.forEach((c, i) => obj[c] = row[i]);
      return obj;
    });
  }

  // ── Meta ──
  const meta = {};
  rowsToArray("meta").forEach(r => meta[r.key] = r.value);
  meta.schema_version = parseInt(meta.schema_version) || 3;

  // ── Users (convert integer booleans) ──
  const users = rowsToArray("users").map(u => ({
    ...u,
    active: u.active !== 0,
    must_change_password: !!u.must_change_password,
  }));

  // ── Simple tables ──
  const machines = rowsToArray("machines");
  const learning_goals = rowsToArray("learning_goals");
  const evaluations = rowsToArray("evaluations");

  // ── Content sections (build nested tree) ──
  const allSections = rowsToArray("content_sections");
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

  // ── Trainee meta ──
  const trainee_meta = {};
  rowsToArray("trainee_meta").forEach(r => {
    trainee_meta[r.trainee_id] = {
      feedback: r.feedback,
      conclusion: r.conclusion,
      next_steps: r.next_steps,
    };
  });

  db.close();

  // ── Build seed (with version stamp for auto-refresh detection) ──
  meta.seed_version = new Date().toISOString();
  const seed = { meta, users, machines, content_sections, learning_goals, evaluations, trainee_meta };
  const json = JSON.stringify(seed);
  const base64 = Buffer.from(json).toString("base64");

  // ── Write data-seed.js ──
  const outPath = path.join(__dirname, "data-seed.js");
  fs.writeFileSync(outPath, `// Auto-generated from data.db – do not edit manually\n// Run: node build-seed.js\nwindow.__DB_SEED="${base64}";\n`);

  // ── Report ──
  const jsonKB = (json.length / 1024).toFixed(1);
  const b64KB = (base64.length / 1024).toFixed(1);
  console.log(`✓ data-seed.js generated`);
  console.log(`  JSON: ${jsonKB} KB → Base64: ${b64KB} KB`);
  console.log(`  ${users.length} users, ${machines.length} machines`);
  console.log(`  ${content_sections.length} top-level sections (${allSections.length} total)`);
  console.log(`  ${learning_goals.length} learning goals, ${evaluations.length} evaluations`);
}

main().catch(e => { console.error(e); process.exit(1); });
