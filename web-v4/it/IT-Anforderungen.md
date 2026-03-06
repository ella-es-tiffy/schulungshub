# SchulungsHub – IT-Anforderungsprofil

## Zusammenfassung

Das SchulungsHub ist eine rein clientseitige Webanwendung ohne Server-Komponente.
Es besteht aus statischen Dateien (HTML, CSS, JavaScript), die direkt vom NAS-Share
im Browser geöffnet werden. Es entsteht kein IT-Aufwand.

## Architektur

- Typ: Statische Webanwendung (Single-Page)
- Server: Keiner – läuft als file:// direkt vom NAS
- Datenbank: SQLite als einzelne .db-Datei (~50 KB) auf NAS
- DB-Engine: sql.js (WebAssembly im Browser, keine Installation)
- Netzwerk: Kein Netzwerk-Traffic – alles lokal
- Internet: Nicht erforderlich
- Gesamtgröße: < 5 MB

## Anforderungen an die Infrastruktur

Benötigt:
- Ein Ordner auf dem bestehenden NAS-Share (Lese-/Schreibzugriff für Anwender)
- Edge oder Chrome auf den ThinClients (bereits vorhanden)

Nicht benötigt:
- Kein Webserver (kein IIS, kein Apache, kein nginx)
- Kein Datenbank-Server (kein SQL Server, kein MySQL)
- Keine Installation auf Clients
- Keine Admin-Rechte auf Clients
- Keine Firewall-Regeln oder Portfreigaben
- Keine DNS-Einträge oder Zertifikate
- Kein Internet / keine externe Verbindung

## Sicherheit

- Netzwerk: Kein Traffic – keine Angriffsfläche
- Passwörter: PBKDF2-SHA256 gehasht (Web Crypto API, Standard)
- Externe Abhängigkeiten: Keine – alle Bibliotheken lokal eingebettet
- Daten: Bleiben auf dem NAS, verlassen nie das Netzwerk
- Code-Ausführung: Nur im Browser-Sandbox (kein Node.js, kein Skript)

## Wartung und Betrieb

- Updates: Dateien auf NAS ersetzen – kein Rollout nötig
- Backup: Optional – NAS-Ordner ins bestehende Backup aufnehmen
- Monitoring: Nicht erforderlich (kein Service, kein Prozess)
- Logs: Keine (kein Server = keine Server-Logs)
- Benutzerverwaltung: In der App selbst (Admin-Rolle)

## Datenhaltung

- Alle Daten liegen in einer einzigen SQLite-Datei (data.db) auf dem NAS
- Der Browser liest/schreibt diese Datei über die File System Access API
- Kein separater Datenbank-Prozess – die DB ist einfach eine Datei
- Bei Browser-Neustart: einmalige Bestätigung ("Zugriff erlauben") für die Datei

## Zusammenfassung

Ein Ordner auf dem NAS, Browser öffnen, fertig – null IT-Aufwand.
