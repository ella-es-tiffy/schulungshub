# SchulungsHub (Serverlos, NAS-fähig)

Diese Version läuft **ohne Serverprozess** direkt im Browser als statische Anwendung:
- `index.html` öffnen
- keine externe Datenbank
- Daten in JSON (vergleichbar zu SQLite-Ansatz, aber serverlos)
- kompatibel mit Edge/Chrome (Windows 10+)

## Start

1. Ordner auf NAS oder lokal ablegen.
2. `web/index.html` in Edge/Chrome öffnen.
3. Einloggen:
   - `admin / admin123!`
   - `trainer / trainer123!`
   - `schueler-a / lernen123!`
4. Optional RFID-Demo-Hash für `schueler-a`:
   - `2a3db45e0bd03cf7cab0f7aed20890c930e753b6864d9b89acb301cb2b83ee28`

## Funktionen

- Linkes Inhaltsverzeichnis, rechts scrollender Content mit Lazy-Loading.
- Verifizierbare Ziele pro Schüler:
  - erreicht / nicht erreicht
  - Notiz/Nachweis
  - Prüfer + Zeitstempel
- Rollen:
  - `admin`: User anlegen, alles verifizieren
  - `trainer`: verifizieren
  - `trainee`: nur lesen (eigener Stand)
- Auswertung:
  - Zielerreichung in %
  - Abschnittsübersicht
  - geschätztes Ende (ETA)
  - Historie der Verifizierungen

## Datenspeicherung

- Primär: Browser `localStorage` (sofort nutzbar).
- Für NAS-Ablage/Sync:
  - `Daten laden` (JSON importieren)
  - `Daten speichern` (JSON auf Datei schreiben)
  - `Backup herunterladen`

Dateiformat: eine JSON-Datei mit `users`, `sections`, `progress`.

## Projektstruktur

- `web/index.html` UI-Struktur
- `web/styles.css` modernes, leichtes Design
- `web/default-data.js` Startdaten (Demo-User + Inhalte)
- `web/app.js` komplette Logik (Login, RFID, Ziele, Bewertung, Datei-Sync)

## Hinweis zur XLS-Analyse

Die bereitgestellte Datei `siebdruck_xls.xls` konnte in dieser Umgebung nicht automatisch eingelesen werden, da kein `.xls`-Parser verfügbar ist (offline, ohne Paket-Download).  
Sobald du die aktuelle Lerninhaltsliste als `CSV` oder `XLSX` gibst, binde ich sie direkt in das Datenmodell ein.
