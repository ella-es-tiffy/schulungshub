# SchulungsHub – IT-Anforderungsprofil (Server-Variante)

## Zusammenfassung

Erweiterung des SchulungsHub um einen minimalen Webserver, der die Einschränkungen
des file://-Protokolls beseitigt. Die Anwendung läuft weiterhin vollständig im
Browser – der Server liefert nur Dateien aus und speichert die SQLite-Datenbank.

## Vergleich file:// vs. Server

file:// (aktuell):
- NAS-Ordner nötig
- Browser-Erlaubnis-Dialog bei jedem Neustart
- Mehrere Nutzer gleichzeitig problematisch (Dateisperren)
- Links nicht teilbar
- Nicht mobil nutzbar
- Kein IT-Aufwand

Server (Upgrade):
- Kein NAS-Ordner nötig
- Kein Erlaubnis-Dialog
- Mehrere Nutzer gleichzeitig kein Problem
- Links teilbar (http://schulungshub/...)
- Mobil / Tablet im WLAN nutzbar
- Minimaler einmaliger IT-Aufwand

## Architektur

- Typ: Statische Webanwendung + minimale API
- Webserver: Vorhandener Webserver (IIS, Apache, nginx)
- API-Backend: Kleines Skript (PHP, Python CGI, o.ä.) für DB-Zugriff
- Datenbank: SQLite – eine einzelne Datei, kein DB-Server
- Netzwerk: Nur lokales Netz (LAN/WLAN), kein Internet nötig
- Gesamtgröße: < 5 MB

Der Webserver macht nur zwei Dinge:
1. Statische Dateien ausliefern (HTML, CSS, JS) – Standardfunktion
2. Ein kleines API-Skript für Datenbank lesen/schreiben (2 Endpunkte)

## Anforderungen an die Infrastruktur

Benötigt:
- Vorhandener Webserver (IIS, Apache oder nginx – was bereits im Einsatz ist)
- Ein Verzeichnis auf dem Webserver für die App-Dateien
- Edge oder Chrome auf den ThinClients (bereits vorhanden)

Nicht benötigt:
- Kein zusätzlicher Webserver – nutzt den vorhandenen
- Kein Datenbank-Server (kein SQL Server, kein MySQL)
- Keine Installation auf Clients
- Keine Admin-Rechte auf Clients
- Kein Internet / keine externe Verbindung
- Keine Zertifikate (nur LAN, kein HTTPS nötig)
- Kein Domänen-Join oder AD-Integration

## Einmalige Einrichtung (IT)

Variante A – IIS (Windows Server):
1. Neues Verzeichnis unter inetpub anlegen (z.B. C:\inetpub\schulungshub)
2. App-Dateien hineinkopieren
3. Neue Website oder virtuelles Verzeichnis im IIS-Manager anlegen
4. Fertig – IIS liefert die statischen Dateien aus

Variante B – Apache:
1. Verzeichnis anlegen (z.B. /var/www/schulungshub)
2. App-Dateien hineinkopieren
3. VirtualHost oder Alias in Apache-Konfig eintragen
4. service apache2 reload

Variante C – nginx:
1. Verzeichnis anlegen (z.B. /var/www/schulungshub)
2. App-Dateien hineinkopieren
3. Server-Block in nginx-Konfig eintragen
4. nginx -s reload

Geschätzter Zeitaufwand: 10–20 Minuten, einmalig.
Nutzt den vorhandenen Webserver – keine neue Software nötig.

## Sicherheit

- Netzwerk: Nur LAN – nicht aus dem Internet erreichbar
- Angriffsfläche: Vorhandener Webserver, 2 API-Endpunkte
- Passwörter: PBKDF2-SHA256 gehasht (Web Crypto API, Standard)
- Externe Abhängigkeiten: Keine CDNs, kein Internet, alles lokal
- Daten: Bleiben auf dem Server, verlassen nie das LAN
- Code-Ausführung Client: Nur im Browser-Sandbox
- Code-Ausführung Server: Nur statische Dateien + SQLite lesen/schreiben

## Wartung und Betrieb

- Updates: Dateien im Webserver-Verzeichnis ersetzen
- Backup: Eine Datei (data.db) ins bestehende Backup
- Monitoring: Optional – prüfen ob Port erreichbar
- Logs: Minimal (Zugriffs-Log auf stdout)
- Benutzerverwaltung: In der App selbst (Admin-Rolle)

## Was sich für Anwender verbessert

- Kein "Zugriff erlauben"-Dialog mehr bei jedem Browser-Start
- Links auf Artikel teilbar (http://schulungshub/#sec-kartusche)
- Mehrere Trainer/Trainees können gleichzeitig arbeiten
- Zugriff von Tablets/Smartphones im WLAN möglich
- Stabilere Datenhaltung (kein Dateisperren-Problem auf NAS)

## Zusammenfassung

Einen Ordner im vorhandenen Webserver anlegen, Dateien reinkopieren – fertig.
10–20 Minuten Einrichtung, danach wartungsfrei.
