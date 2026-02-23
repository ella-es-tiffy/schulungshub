#!/usr/bin/env node
/**
 * update-toc.js – Replaces content_sections in data.db with the new TOC
 * Parses inhalt_links.txt and rebuilds the content_sections table.
 * Existing content_md is migrated where titles match.
 * Run: node update-toc.js
 */

const fs = require("fs");
const path = require("path");

async function main() {
  const initSqlJs = require("sql.js");
  const SQL = await initSqlJs();

  const dbPath = path.join(__dirname, "data.db");
  const db = new SQL.Database(fs.readFileSync(dbPath));

  // ── Read existing content_md for migration ──
  const oldRows = db.exec("SELECT id, title, content_md FROM content_sections");
  const oldContent = {};
  if (oldRows.length) {
    oldRows[0].values.forEach(r => {
      oldContent[r[1].trim().toLowerCase()] = r[2] || "";
    });
  }

  // ── Parse inhalt_links.txt ──
  const tocPath = path.join(__dirname, "inhalt_links.txt");
  const lines = fs.readFileSync(tocPath, "utf8")
    .split("\n")
    .map(l => l.replace(/\t/g, " ").trim())
    .filter(l => l && /^\d/.test(l));

  const sections = [];
  for (const line of lines) {
    // Parse: "6.5.1. Siebschablone ein- und ausbauen" or "1. Kurzbeschreibung..."
    const m = line.match(/^([\d.]+)\s+(.+)$/);
    if (!m) continue;

    let id = m[1].replace(/\.$/, ""); // remove trailing dot
    const title = m[2].trim();

    // Determine parent
    const parts = id.split(".");
    let parentId = null;
    if (parts.length === 2) parentId = parts[0];           // "6.5" → parent "6"
    if (parts.length === 3) parentId = parts[0] + "." + parts[1]; // "6.5.1" → parent "6.5"

    // Try to find existing content_md by title
    const contentMd = oldContent[title.toLowerCase()] || "";

    sections.push({
      id,
      title,
      position: sections.length + 1,
      content_md: contentMd,
      parent_id: parentId,
    });
  }

  // ── Replace content_sections table ──
  db.run("DELETE FROM content_sections");

  const stmt = db.prepare("INSERT INTO content_sections (id, title, position, content_md, parent_id) VALUES (?,?,?,?,?)");
  for (const s of sections) {
    stmt.run([s.id, s.title, s.position, s.content_md, s.parent_id]);
  }
  stmt.free();

  // ── Save ──
  const buffer = db.export();
  fs.writeFileSync(dbPath, Buffer.from(buffer));
  db.close();

  // ── Report ──
  const topLevel = sections.filter(s => !s.parent_id);
  const level2 = sections.filter(s => s.parent_id && !s.parent_id.includes("."));
  const level3 = sections.filter(s => s.parent_id && s.parent_id.includes("."));
  const migrated = sections.filter(s => s.content_md).length;

  console.log(`✓ ${sections.length} Sektionen eingefügt`);
  console.log(`  ${topLevel.length} Hauptkapitel`);
  console.log(`  ${level2.length} Unterkapitel (Level 2)`);
  console.log(`  ${level3.length} Unterkapitel (Level 3)`);
  console.log(`  ${migrated} Sektionen mit migriertem Inhalt`);

  // Show structure
  console.log("\nStruktur:");
  for (const s of sections) {
    const depth = s.parent_id ? (s.parent_id.includes(".") ? "    " : "  ") : "";
    const hasContent = s.content_md ? " ✓" : "";
    console.log(`${depth}${s.id} ${s.title}${hasContent}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
