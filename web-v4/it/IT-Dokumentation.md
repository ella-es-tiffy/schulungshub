# SchulungsHub – IT-Dokumentation

Stand: März 2026

---

## 1. Überblick

Das SchulungsHub ist eine browserbasierte Schulungsplattform für die Siebdruck-Produktion.
Die Anwendung dient der strukturierten Einarbeitung neuer Mitarbeiter und umfasst
Lerninhalte, Bewertungssysteme und einen Prüfungsmodus.

**Technische Eckdaten:**

- Clientseitige Single-Page-Webanwendung (HTML/CSS/JavaScript)
- Keine Server-Komponente erforderlich
- Keine Internetverbindung erforderlich
- Keine Client-Installation erforderlich
- Datenhaltung über eine einzelne SQLite-Datei auf dem NAS

---

## 2. Technische Architektur

### Systemübersicht

Die Anwendung besteht aus statischen Webdateien, die direkt vom NAS-Share
im Browser ausgeführt werden. Es wird kein Applikationsserver benötigt.

```
NAS-Share
  └── schulungshub/
        ├── index.html          Hauptanwendung
        ├── login.html          Authentifizierung
        ├── data.db             SQLite-Datenbank (~100 KB)
        ├── style.css           Stylesheets
        ├── db-engine.js        Datenbankschicht
        ├── js/                 Anwendungsmodule (17 Dateien)
        └── vendor/             Bibliotheken (lokal gebündelt)
```

### Funktionsweise

1. Der Browser lädt die statischen Dateien vom NAS (file://-Protokoll)
2. Die SQLite-Datenbank (`data.db`) wird über die File System Access API gelesen
3. sql.js (WebAssembly) verarbeitet die Datenbank im Arbeitsspeicher des Browsers
4. Änderungen werden direkt in die `data.db` auf dem NAS zurückgeschrieben

Es läuft kein Server-Prozess, kein Hintergrund-Dienst und kein Datenbank-Service.

### Eingesetzte Technologien

| Komponente | Technologie | Bereitstellung |
|---|---|---|
| Frontend-Framework | UIkit 3 | Lokal in `vendor/` |
| Markdown-Rendering | marked.js | Lokal in `vendor/` |
| Datenbank-Engine | sql.js (SQLite via WebAssembly) | Lokal in `vendor/` |
| Passwort-Hashing | PBKDF2-SHA256, 120.000 Iterationen | Web Crypto API (Browser-nativ) |
| Dateizugriff | File System Access API | Browser-nativ (Chromium 86+) |

Sämtliche Abhängigkeiten sind lokal gebündelt. Es werden keine externen
Ressourcen nachgeladen (kein CDN, kein externer Service).

---

## 3. Infrastruktur-Anforderungen

### Voraussetzungen

| Anforderung | Details |
|---|---|
| **NAS-Freigabe** | Ein Ordner mit Lese-/Schreibzugriff für die Anwendergruppe |
| **Browser** | Microsoft Edge oder Google Chrome (Version 86+) auf den Clients |

### Nicht erforderlich

Die Anwendung benötigt bewusst keine zusätzliche Infrastruktur:

- Kein Webserver (IIS, Apache, nginx)
- Kein Datenbank-Server (SQL Server, MySQL, PostgreSQL)
- Keine Software-Installation auf Clients
- Keine administrativen Rechte auf Clients
- Keine Firewall-Regeln oder Portfreigaben
- Keine DNS-Einträge
- Keine SSL-Zertifikate
- Keine Internetverbindung
- Keine Active-Directory-Integration oder GPO-Anpassungen
- Keine zusätzlichen Lizenzkosten

---

## 4. Einrichtung

### 4.1 NAS-Ordner anlegen

Einen neuen Ordner auf der bestehenden NAS-Freigabe anlegen, z.B.:

```
\\server\shares\schulungshub\
```

### 4.2 Anwendungsdateien bereitstellen

Den Inhalt des Installationspakets (`web-v4/`) in den NAS-Ordner kopieren.

**Erwartete Ordnerstruktur nach der Bereitstellung:**

```
schulungshub/
  ├── index.html
  ├── login.html
  ├── login.js
  ├── style.css
  ├── db-engine.js
  ├── data-seed.js
  ├── wasm-seed.js
  ├── sample.db
  ├── js/                  (ca. 17 Dateien)
  └── vendor/              (Bibliotheken + Fonts)
```

### 4.3 Datenbank initialisieren

Die mitgelieferte `sample.db` in `data.db` umbenennen:

```
sample.db  →  data.db
```

Diese Datei enthält die Demo-Konfiguration. Im laufenden Betrieb werden hier
alle Inhalte, Bewertungen und Benutzerdaten gespeichert.

### 4.4 Berechtigungen setzen

Die Anwender benötigen **Lese- und Schreibrechte** auf den gesamten Ordner,
insbesondere auf die Datei `data.db`. Der Browser muss diese Datei sowohl
lesen als auch beschreiben können.

### 4.5 Clientseitiger Zugriff (optional)

Desktop-Verknüpfung für die Anwender:

```
Ziel: "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" "\\server\shares\schulungshub\login.html"
```

Alternativ kann die URL als Browser-Favorit hinterlegt werden.

### 4.6 Funktionstest

1. `login.html` im Browser öffnen
2. Auf "Ordner wählen" oder "DB-Datei wählen" klicken
3. Den NAS-Ordner bzw. die `data.db` auswählen
4. Browser-Berechtigung bestätigen ("Erlauben")
5. Benutzer auswählen und mit dem eingerichteten Passwort anmelden

---

## 5. File System Access API – Berechtigungsdialog

### Hintergrund

Die Anwendung nutzt die File System Access API des Browsers, um die Datenbankdatei
auf dem NAS direkt zu lesen und zu schreiben. Diese API erfordert eine explizite
Zustimmung des Anwenders.

### Verhalten

- **Ersteinrichtung:** Der Anwender wählt den NAS-Ordner über einen Datei-Dialog aus.
  Der Browser speichert diese Berechtigung.
- **Folgende Sitzungen:** Bei jedem Browser-Neustart erscheint ein Hinweis
  "Zugriff erlauben" (ein Klick, kein erneuter Datei-Dialog).

### Konfigurierbarkeit

Dieser Dialog ist ein Sicherheits-Feature des Browsers und kann nicht über
Gruppenrichtlinien oder Registry-Einstellungen deaktiviert werden. Der Aufwand
für den Anwender beschränkt sich auf einen einzelnen Klick pro Browser-Sitzung.

---

## 6. Sicherheitskonzept

### Passwörter

- Passwörter werden ausschließlich als Hash gespeichert (kein Klartext)
- Algorithmus: PBKDF2-SHA256 mit 120.000 Iterationen
- Implementierung über die Web Crypto API (Browser-nativ, keine externe Bibliothek)

### Netzwerk

- Die Anwendung erzeugt keinen eigenen Netzwerk-Traffic
- Kein Server-Prozess, daher keine offenen Ports
- Die einzige Netzwerkaktivität ist der reguläre SMB-Zugriff auf die NAS-Datei

### Datenschutz

- Alle Daten verbleiben in der lokalen `data.db` auf dem NAS
- Keine Daten verlassen das lokale Netzwerk
- Keine Cloud-Anbindung, keine Telemetrie, keine externe Kommunikation

### Code-Ausführung

- Sämtlicher Code läuft ausschließlich in der Browser-Sandbox
- Kein serverseitiger Code (kein Node.js, kein Python, kein .NET)
- Alle Bibliotheken sind lokal gebündelt, kein dynamisches Nachladen

### Übersicht

```
Offene Ports:          0
Eigener Netzwerk-Traffic: 0 (nur SMB zum NAS)
Externe Verbindungen:  0
Installierte Software: 0
Laufende Dienste:      0
Angriffsfläche:        Minimal (Browser-Sandbox + NAS-Datei)
```

---

## 7. Betrieb und Wartung

### Updates

Anwendungsupdates durchlaufen einen definierten Freigabeprozess:

1. Die Fachabteilung stellt ein Update-Paket bereit (via USB-Stick oder GitHub-Repository)
2. Die IT prüft das Update-Paket (Dateien, Umfang, Changelog)
3. Die IT ersetzt alle Dateien im NAS-Ordner **außer `data.db`**
4. Die `data.db` enthält alle Nutz- und Bewertungsdaten und darf nicht überschrieben werden
5. Funktionstest nach Deployment (Login + Stichprobe)

**Wichtig:** Die Fachabteilung hat keinen direkten Schreibzugriff auf den
Produktiv-Ordner. Jedes Update wird vor der Bereitstellung durch die IT geprüft.

### Backup

- Empfohlen: `data.db` in die bestehende NAS-Backup-Routine aufnehmen
- Alle anderen Dateien können aus dem Installationspaket wiederhergestellt werden
- Die `data.db` ist eine eigenständige Datei ohne externe Abhängigkeiten

### Fehleranalyse

| Symptom | Mögliche Ursache | Maßnahme |
|---|---|---|
| Login schlägt fehl | Browser-Cache veraltet | Strg+Shift+Entf → Cache leeren |
| Leere Seite | Dateien auf NAS unvollständig | Dateien aus Installationspaket neu bereitstellen |
| "Zugriff verweigert" | Fehlende NTFS-Schreibrechte | Berechtigungen auf NAS-Ordner prüfen |
| Datenverlust | `data.db` gelöscht/überschrieben | Backup der `data.db` einspielen |
| Veraltete Darstellung | Gecachte Browser-Version | Strg+F5 (Hard Refresh) |

### Laufender Betrieb

Die Anwendung erfordert keine laufende Betreuung durch die IT:

- Keine Dienste zu überwachen oder neu zu starten
- Keine Log-Dateien zu prüfen
- Keine Datenbankwartung erforderlich (SQLite ist wartungsfrei)
- Keine Portfreigaben zu pflegen
- Benutzerverwaltung erfolgt durch den fachlichen Admin in der Anwendung selbst

---

## 8. Benutzerverwaltung

Die Benutzerverwaltung ist vollständig in die Anwendung integriert und wird
vom fachlichen Administrator durchgeführt. Eine Anbindung an Active Directory
oder andere Verzeichnisdienste ist nicht vorgesehen.

### Rollenkonzept

| Rolle | Berechtigungen |
|---|---|
| **Admin** | Vollzugriff: Inhalte, Benutzer, Bewertungen, Einstellungen, Backup |
| **Trainer** | Inhalte bearbeiten, Bewertungen vergeben, Trainees verwalten |
| **Trainee** | Inhalte lesen, eigene Bewertungen einsehen, Prüfungen ablegen |

### Benutzer anlegen

1. Als Admin in der Anwendung anmelden
2. Bereich "Datenverwaltung" → "Benutzerverwaltung" aufrufen
3. Neuen Benutzer mit Name, Rolle und Passwort anlegen

---

## 9. Technische Referenz

### Datenbankschema

| Tabelle | Inhalt | Erwartete Größe |
|---|---|---|
| `users` | Benutzerkonten (Name, Rolle, Passwort-Hash) | 3–20 Einträge |
| `machines` | Maschinen und Prozessgruppen | 13 Einträge |
| `content_sections` | Lerninhalte (Markdown, Baumstruktur) | 20–100 Einträge |
| `learning_goals` | Lernziele pro Phase und Maschine | 115 Einträge |
| `evaluations` | Bewertungshistorie (fortlaufend) | Wachsend |
| `trainee_meta` | Notizen und Feedback pro Trainee | 1 pro Trainee |
| `exam_questions` | Prüfungsfragen mit Antwortoptionen | 6–50 Einträge |
| `exam_results` | Prüfungsergebnisse | Wachsend |
| `attendance` | Anwesenheitsprotokoll | Wachsend |

Erwartete Datenbankgröße im laufenden Betrieb: 50–500 KB.

### Browser-Kompatibilität

| Browser | Unterstützt | Anmerkung |
|---|---|---|
| **Microsoft Edge** | Ja | Empfohlen (auf ThinClients verfügbar) |
| **Google Chrome** | Ja | Vollständig unterstützt |
| **Mozilla Firefox** | Nein | File System Access API nicht implementiert |
| **Safari** | Nein | File System Access API nicht implementiert |

Mindestversion: Chromium 86 (ab Oktober 2020).

### WebAssembly (WASM)

Die Datenbank-Engine sql.js nutzt WebAssembly zur Ausführung von SQLite im Browser.
WebAssembly ist ein offener W3C-Standard, der in allen modernen Browsern nativ
unterstützt wird. Es handelt sich nicht um ein Plugin oder eine Erweiterung.
Die Ausführung unterliegt denselben Sicherheitsbeschränkungen wie reguläres JavaScript
(Browser-Sandbox).

### File System Access API

Diese Browser-API ermöglicht den kontrollierten Zugriff auf lokale Dateien.
Die Berechtigung ist auf den vom Anwender ausgewählten Ordner beschränkt.
Ein Zugriff auf andere Verzeichnisse oder Systemdateien ist nicht möglich.

---

## 10. Häufige Fragen

**Wird eine Internetverbindung benötigt?**
Nein. Die Anwendung arbeitet vollständig offline. Es werden keine externen Ressourcen geladen.

**Wie ist die Anwendung abgesichert?**
Kein Server-Prozess, keine offenen Ports, keine externen Verbindungen.
Passwörter sind mit PBKDF2-SHA256 (120.000 Iterationen) gehasht.
Die Angriffsfläche beschränkt sich auf den regulären NAS-Dateizugriff.

**Was passiert bei gleichzeitigem Zugriff mehrerer Anwender?**
Im NAS-Modus (file://) gilt: Die letzte Speicherung überschreibt vorherige Änderungen.
In der Praxis arbeitet in der Regel ein Trainer am System. Für parallelen Mehrbenutzerbetrieb
steht eine optionale Server-Variante zur Verfügung (siehe IT-Anforderungen-Server.md).

**Wie sicher sind die gespeicherten Passwörter?**
Passwörter werden nicht im Klartext gespeichert. Das verwendete Hashing-Verfahren
(PBKDF2-SHA256, 120.000 Iterationen) entspricht den gängigen Empfehlungen für
Webanwendungen.

**Ist laufende Wartung durch die IT erforderlich?**
Im laufenden Betrieb nicht. Updates werden von der Fachabteilung vorbereitet und der IT
zur Prüfung übergeben (via USB-Stick oder GitHub-Repository). Nach Freigabe deployt
die IT das Update in den NAS-Ordner. Die Datensicherung erfolgt über die bestehende
NAS-Backup-Infrastruktur.

**Warum keine bestehende Plattform (SharePoint, Confluence o.ä.)?**
Das SchulungsHub ist ein spezialisiertes Schulungssystem mit phasenbasiertem
Bewertungssystem, Lernziel-Tracking, integriertem Prüfungsmodus und
Trainee-Profilen. Diese fachlichen Anforderungen gehen über die Möglichkeiten
allgemeiner Wiki- oder Dokumentationsplattformen hinaus.

**Ist eine spätere Migration auf einen Webserver möglich?**
Ja. Eine Server-Variante ist dokumentiert (siehe IT-Anforderungen-Server.md).
Diese beseitigt den Browser-Berechtigungsdialog und ermöglicht den Zugriff
von Mobilgeräten im WLAN. Einrichtungsaufwand: ca. 10–20 Minuten auf dem
vorhandenen Webserver.

**Wie wird ein Backup erstellt?**
Die Datei `data.db` kopieren. Diese enthält alle Anwendungsdaten und ist
eigenständig (keine externen Abhängigkeiten).

**Funktioniert die Anwendung auf Tablets und Smartphones?**
Im NAS-Modus (file://) nicht, da mobile Browser die File System Access API
nicht unterstützen. In der Server-Variante (http://) ja.

---

## 11. Ansprechpartner

| Thema | Zuständigkeit |
|---|---|
| NAS-Zugriff und Berechtigungen | IT-Abteilung |
| Inhalte, Bewertungen, Benutzerverwaltung | Fachlicher Admin / Trainer |
| Technische Fragen zur Anwendung | Anwendungsverantwortlicher |

---

## 12. Einrichtungs-Checkliste

- [ ] NAS-Ordner angelegt
- [ ] Lese-/Schreibrechte für die Anwendergruppe gesetzt
- [ ] Edge oder Chrome auf ThinClients verfügbar (Version 86+)
- [ ] Anwendungsdateien in NAS-Ordner bereitgestellt
- [ ] `sample.db` in `data.db` umbenannt
- [ ] Funktionstest (Login) erfolgreich durchgeführt
- [ ] Optional: Desktop-Verknüpfung für Anwender eingerichtet
- [ ] Optional: `data.db` in NAS-Backup-Routine aufgenommen

**Geschätzter Einrichtungsaufwand: ca. 30 Minuten.**
**Laufender Betriebsaufwand: keiner.**
