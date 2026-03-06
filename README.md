# SchulungsHub

Serverlose Schulungsplattform fuer die Einarbeitung in der Siebdruck-Produktion.
Laeuft komplett im Browser – kein Server, keine Installation, kein Internet noetig.

## Quickstart

1. Ordner `web-v4/` auf ein NAS-Share oder einen Webserver kopieren
2. `sample.db` in `data.db` umbenennen (oder eigene DB mit `build-db.js` erstellen)
3. `index.html` im Browser oeffnen
4. Login: `admin` / `admin123!`

## Architektur

```
Browser (Edge/Chrome)
  |
  |  file:// oder http://
  |
  v
+---------------------------------------------------+
|  index.html                                        |
|  +-----------------------------------------------+ |
|  |  UIkit 3 (CSS + JS)     vendor/uikit.min.*    | |
|  |  marked.js               vendor/marked.min.js | |
|  |  sql.js (WASM SQLite)    vendor/sql-wasm.*    | |
|  +-----------------------------------------------+ |
|                                                     |
|  db-engine.js          Persistence Layer            |
|    - sql.js in-memory DB                            |
|    - File System Access API (NAS-Modus)             |
|    - localStorage Fallback                          |
|                                                     |
|  js/app.js             Orchestrierung               |
|    +-- js/state.js     Globaler State, DB-Queries   |
|    +-- js/auth.js      Login, Session, Passwort     |
|    +-- js/crypto.js    PBKDF2-SHA256 Hashing        |
|    +-- js/render.js    Seitenaufbau, Events          |
|    +-- js/sidebar.js   Navigation, TOC              |
|    +-- js/editor.js    Markdown-Editor, CRUD        |
|    +-- js/markdown.js  Markdown + Custom Blocks     |
|    +-- js/scoring.js   Bewertungs-UI                |
|    +-- js/eval.js      Fortschritt, Prognose        |
|    +-- js/exam.js      Pruefungsmodus               |
|    +-- js/search.js    Volltextsuche                |
|    +-- js/admin.js     Benutzerverwaltung           |
|    +-- js/export.js    Backup, Import, DB-Export    |
|    +-- js/prefs.js     Theme, Einstellungen         |
|    +-- js/trainee-profile.js  Trainee-Detailansicht |
|    +-- js/utils.js     Hilfsfunktionen              |
|                                                     |
+---------------------------------------------------+
        |
        v
  +------------+
  |  data.db   |  SQLite-Datei auf NAS oder lokal
  +------------+
```

## Datenfluss

```
Erststart:
  data-seed.js (Base64) --> sql.js (RAM) --> localStorage
                                         --> data.db (NAS, optional)

Normaler Start:
  data.db (NAS) --> sql.js (RAM) --> Browser zeigt Inhalte
       ^                    |
       |                    v
       +--- persistDb() ---+  (Aenderungen zurueckschreiben)

Fallback (kein NAS):
  localStorage --> sql.js (RAM) --> localStorage
```

## Datenbankschema

```
users              Benutzer (Admin, Trainer, Trainee)
machines           Maschinen / Prozessgruppen
content_sections   Lerninhalte (Baumstruktur, Markdown)
learning_goals     Lernziele pro Phase und Maschine
evaluations        Bewertungen (append-only, 0-100)
trainee_meta       Feedback, Fazit, naechste Schritte
exam_questions     Pruefungsfragen mit Optionen
exam_results       Pruefungsergebnisse
```

## Projektstruktur

```
schulungshub/
|
+-- web-v4/                    Hauptanwendung
|   +-- index.html             Startseite (nach Login)
|   +-- login.html             Login-Seite
|   +-- login.js               Login-Logik
|   +-- style.css              Alle Styles
|   +-- db-engine.js           Persistence Layer
|   +-- sample.db              Demo-Datenbank
|   +-- data-seed.sample.js    Demo-Seed (Base64)
|   |
|   +-- js/                    Anwendungsmodule (17 Dateien)
|   |   +-- app.js             Einstiegspunkt
|   |   +-- state.js           State Management
|   |   +-- auth.js            Authentifizierung
|   |   +-- render.js          Seitenrendering
|   |   +-- editor.js          Content-Editor
|   |   +-- ...                (siehe Architektur oben)
|   |
|   +-- vendor/                Externe Bibliotheken (lokal)
|   |   +-- uikit.min.*       UIkit 3 Framework
|   |   +-- marked.min.js     Markdown Parser
|   |   +-- sql-wasm.*        SQLite im Browser (WASM)
|   |   +-- fonts/            Inter + JetBrains Mono
|   |
|   +-- it/                    IT-Dokumentation
|   |   +-- IT-Anforderungen.md          NAS-Variante
|   |   +-- IT-Anforderungen-Server.md   Server-Variante
|   |
|   +-- build-db.js            Node: data.js -> data.db
|   +-- build-seed.js          Node: data.db -> data-seed.js
|   +-- build-wasm-seed.js     Node: sql-wasm.wasm -> wasm-seed.js
|
+-- app/                       Server-Variante (optional)
|   +-- server.py              Minimaler Python-Server
|   +-- schema.sql             DB-Schema
|
+-- .gitignore
+-- README.md
```

## Script-Ladereihenfolge

Die Module muessen in exakt dieser Reihenfolge geladen werden:

```
 1. wasm-seed.js           WASM-Binary als Base64
 2. vendor/sql-wasm.js     sql.js Library
 3. data-seed.js           Datenbank als Base64
 4. db-engine.js           Persistence Layer
 5. js/utils.js            Hilfsfunktionen
 6. js/crypto.js           Passwort-Hashing
 7. js/markdown.js         Markdown Rendering
 8. js/state.js            State Management
 9. js/eval.js             Fortschrittsberechnung
10. js/prefs.js            Einstellungen
11. js/auth.js             Login/Session
12. js/search.js           Suche
13. js/sidebar.js          Navigation
14. js/editor.js           Content-Editor
15. js/scoring.js          Bewertungs-UI
16. js/render.js           Seitenaufbau
17. js/exam.js             Pruefungen
18. js/trainee-profile.js  Trainee-Profil
19. js/admin.js            Benutzerverwaltung
20. js/export.js           Backup/Import
21. js/app.js              Orchestrierung (init)
```

## Sicherheit

- Passwoerter: PBKDF2-SHA256 mit 100.000 Iterationen (Web Crypto API)
- Kein Netzwerk-Traffic im NAS-Modus
- Keine externen Abhaengigkeiten, kein CDN, kein Internet
- Alle Daten bleiben lokal auf dem NAS

## Demo-Zugaenge (sample.db)

| Benutzer    | Passwort      | Rolle   |
|-------------|---------------|---------|
| admin       | admin123!     | Admin   |
| trainer     | trainer123!   | Trainer |
| schueler-a  | lernen123!    | Trainee |

## Lizenz

Proprietaer – Alle Rechte vorbehalten.
