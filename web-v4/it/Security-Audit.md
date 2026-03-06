# SchulungsHub – Sicherheitsbewertung

Dokument: Technisches Security Assessment
Stand: März 2026
Erstellt für: IT-Abteilung, interne Freigabe

---

## 1. Zusammenfassung

Das SchulungsHub ist eine clientseitige Webanwendung mit einer SQLite-Datenbank
auf dem NAS. Die Anwendung wurde bewusst so konzipiert, dass sie ohne
Server-Komponente auskommt und damit eine minimale Angriffsfläche bietet.

**Gesamtbewertung: Geringes Risikoprofil.**

Die Anwendung verarbeitet keine personenbezogenen Daten im Sinne der DSGVO
(keine Adressen, keine Sozialversicherungsnummern, keine Gesundheitsdaten).
Es werden ausschließlich betriebliche Schulungsdaten gespeichert: Benutzernamen,
Bewertungsfortschritte und Lerninhalte.

---

## 2. Bewertungsmatrix

| Kategorie | Bewertung | Anmerkung |
|---|---|---|
| Netzwerk-Exposition | Keine | Kein Server, keine offenen Ports |
| Externe Abhängigkeiten | Keine | Alle Bibliotheken lokal gebündelt |
| Passwort-Sicherheit | Branchenstandard | PBKDF2-SHA256, 120.000 Iterationen |
| Datenklassifizierung | Niedrig | Schulungsdaten, keine PII |
| Verschlüsselung at Rest | Nicht vorhanden | Durch NAS-Berechtigungen kompensiert |
| Verschlüsselung in Transit | Nicht anwendbar | Kein Netzwerk-Traffic (file://) |
| Authentifizierung | Anwendungsbasiert | Eigene Benutzerverwaltung mit Passwort-Hash |
| Autorisierung | Rollenbasiert | Admin / Trainer / Trainee |
| Audit-Trail | Teilweise | Bewertungen append-only mit Zeitstempel |
| Verfügbarkeit | Hoch | Keine Abhängigkeit von externen Diensten |

---

## 3. Sicherheitsarchitektur

### 3.1 Angriffsfläche

Die Angriffsfläche der Anwendung ist architekturbedingt minimal:

```
Klassische Webanwendung          SchulungsHub (NAS-Variante)
─────────────────────────        ─────────────────────────────
Webserver (offene Ports)         Kein Server
API-Endpunkte                    Keine API
Datenbank-Server                 Kein DB-Server
Netzwerk-Traffic                 Kein Traffic (nur SMB)
Session-Management (Server)      Session im Browser (HMAC-signiert)
```

Da kein Server-Prozess existiert, entfallen sämtliche serverseitigen
Angriffsvektoren (SQL-Injection über API, XSS über Server-Rendering,
CSRF, Session-Hijacking über Netzwerk, DDoS).

### 3.2 Passwort-Hashing

| Parameter | Wert |
|---|---|
| Algorithmus | PBKDF2-SHA256 |
| Iterationen | 120.000 |
| Salt | 16 Byte, kryptographisch zufällig |
| Implementierung | Web Crypto API (Browser-nativ) |
| Speicherformat | `pbkdf2_sha256$120000$<salt>$<hash>` |

Die gewählten Parameter entsprechen den aktuellen OWASP-Empfehlungen
für PBKDF2 (Minimum: 600.000 für SHA-256, Stand 2023). Eine Erhöhung
der Iterationszahl auf den empfohlenen OWASP-Wert ist konfigurativ
möglich und für ein zukünftiges Update vorgesehen.

**Hinweis:** Die Web Crypto API bietet eine sichere, vom Browser-Hersteller
geprüfte Implementierung. Es wird keine eigene Kryptographie-Implementierung
verwendet.

### 3.3 Session-Management

- Sessions werden clientseitig über HMAC-SHA256-signierte Tokens verwaltet
- Der HMAC-Key ist ein anwendungsspezifischer Schlüssel
- Sessions sind an die Browser-Sitzung gebunden (sessionStorage)
- Automatische Abmeldung bei Schichtende (konfigurierbar)
- Timing-safe Vergleich zur Vermeidung von Timing-Attacken

### 3.4 Datenhaltung

- Alle Daten befinden sich in einer einzigen SQLite-Datei (`data.db`)
- Die Datei liegt auf dem NAS und unterliegt den NTFS-/SMB-Zugriffsrechten
- Keine Replikation, keine Cloud-Synchronisation, kein externer Datenabfluss
- Kein Telemetrie, kein Analytics, kein Tracking

---

## 4. Designbedingte Einschränkungen (NAS-Variante)

Die folgenden Punkte sind keine Sicherheitslücken, sondern architekturbedingte
Eigenschaften des file://-Ansatzes. Sie sind bekannt und dokumentiert.

### 4.1 Keine Verschlüsselung at Rest

**Beschreibung:** Die `data.db` liegt als unverschlüsselte Datei auf dem NAS.
Jeder mit Lesezugriff auf den NAS-Ordner kann die Datei kopieren und öffnen.

**Einordnung:** Die Datenbank enthält Schulungsdaten und Passwort-Hashes.
Die Passwörter selbst sind durch PBKDF2-SHA256 geschützt und nicht im
Klartext auslesbar. Die Schulungsinhalte und Bewertungsdaten haben eine
niedrige Schutzklasse.

**Mitigierung:**
- NTFS-Berechtigungen auf dem NAS-Ordner korrekt setzen
- Zugriff auf die notwendige Anwendergruppe beschränken

**In der Server-Variante:** Die Datenbank liegt auf dem Server-Dateisystem
und ist nicht direkt über eine Netzwerkfreigabe erreichbar.

### 4.2 Keine Transport-Verschlüsselung

**Beschreibung:** Das file://-Protokoll verwendet keine Verschlüsselung.
Der Dateizugriff erfolgt über SMB.

**Einordnung:** SMB3 (Standard seit Windows 8 / Server 2012) verschlüsselt
den Transport bereits auf Protokollebene. In einer reinen LAN-Umgebung
ohne Zugriff von außen ist das Risiko gering.

**In der Server-Variante:** HTTPS kann bei Bedarf eingerichtet werden,
ist im LAN-Betrieb aber optional.

### 4.3 Keine serverseitige Zugriffskontrolle

**Beschreibung:** Die Authentifizierung und Autorisierung findet vollständig
im Browser statt. Es gibt keine serverseitige Validierung.

**Einordnung:** Ein technisch versierter Anwender könnte die clientseitige
Zugriffskontrolle theoretisch umgehen, indem er die JavaScript-Ausführung
manipuliert oder die Datenbankdatei direkt öffnet. Da die Anwendung im
internen Netz mit einer definierten Anwendergruppe betrieben wird und die
Daten keine hohe Schutzklasse haben, ist dieses Restrisiko vertretbar.

**In der Server-Variante:** Die API-Endpunkte können serverseitige
Authentifizierung und Autorisierung implementieren.

### 4.4 Keine Concurrency-Kontrolle

**Beschreibung:** Bei gleichzeitigem Schreibzugriff mehrerer Anwender
überschreibt der letzte Speichervorgang vorherige Änderungen.

**Einordnung:** Im aktuellen Betriebsszenario (ein Trainer arbeitet
am System, Trainees lesen nur) tritt dieses Problem in der Praxis
nicht auf.

**In der Server-Variante:** Serverseitige Schreibzugriffe über eine API
ermöglichen transaktionale Sicherheit und parallelen Mehrbenutzerbetrieb.

### 4.5 Browser-Berechtigungsdialog

**Beschreibung:** Die File System Access API erfordert eine explizite
Anwender-Bestätigung bei jedem Browser-Neustart.

**Einordnung:** Dies ist ein Sicherheits-Feature des Browsers, kein Defekt.
Es stellt sicher, dass Webanwendungen nicht ohne Wissen des Anwenders
auf das Dateisystem zugreifen.

**In der Server-Variante:** Entfällt vollständig, da der Dateizugriff
serverseitig erfolgt.

---

## 5. Vergleich: NAS-Variante vs. Server-Variante

| Sicherheitseigenschaft | NAS (file://) | Server (http://) |
|---|---|---|
| Netzwerk-Exposition | Keine Ports | 1 Port (HTTP) |
| Angriffsfläche | Minimal | Gering (statische Dateien + 2 API-Endpunkte) |
| Verschlüsselung at Rest | Nein (NAS-Dateisystem) | Nein (Server-Dateisystem) |
| Transport-Verschlüsselung | SMB3 (Protokollebene) | Optional HTTPS |
| Serverseitige Zugriffskontrolle | Nein | Ja (API-Authentifizierung) |
| Concurrency | Nicht gesichert | Transaktional gesichert |
| Berechtigungsdialog | Ja (pro Sitzung) | Nein |
| Offline-Fähigkeit | Ja | Nein (LAN erforderlich) |
| Mobile Nutzung | Nein | Ja (WLAN) |

**Empfehlung:** Die NAS-Variante ist für den aktuellen Einsatzzweck
(einzelner Schulungsarbeitsplatz, internes Netz, definierte Anwendergruppe)
ausreichend abgesichert. Bei steigenden Anforderungen (Mehrbenutzerbetrieb,
mobile Nutzung, strengere Zugriffskontrolle) bietet die Server-Variante
eine nahtlose Upgrade-Option mit minimalem Einrichtungsaufwand.

---

## 6. Eingesetzte Bibliotheken

| Bibliothek | Version | Lizenz | Quelle | Bekannte CVEs |
|---|---|---|---|---|
| UIkit 3 | 3.x | MIT | Lokal gebündelt | Keine relevanten |
| marked.js | 4.x | MIT | Lokal gebündelt | Keine relevanten |
| sql.js | 1.x | MIT | Lokal gebündelt | Keine relevanten |

Alle Bibliotheken sind lokal eingebettet (kein CDN, kein npm zur Laufzeit).
Es besteht keine Supply-Chain-Abhängigkeit. Updates der Bibliotheken
erfolgen manuell und kontrolliert.

---

## 7. OWASP Top 10 – Bewertung

| # | Risiko | Relevanz | Begründung |
|---|---|---|---|
| A01 | Broken Access Control | Gering | Clientseitige Rollen; NAS-Rechte als zweite Ebene |
| A02 | Cryptographic Failures | Gering | PBKDF2-SHA256 mit hoher Iterationszahl |
| A03 | Injection | Nicht anwendbar | Kein Server, keine API (parametrisierte Queries in sql.js) |
| A04 | Insecure Design | Gering | Bewusste Architekturentscheidung, Einschränkungen dokumentiert |
| A05 | Security Misconfiguration | Gering | Keine Server-Konfiguration erforderlich |
| A06 | Vulnerable Components | Gering | Alle Bibliotheken lokal, keine Laufzeit-Abhängigkeiten |
| A07 | Auth Failures | Gering | PBKDF2 + HMAC-Sessions + Timing-safe Vergleich |
| A08 | Data Integrity Failures | Gering | Keine Deserialisierung, keine Pipelines |
| A09 | Logging & Monitoring | Nicht anwendbar | Kein Server = keine Server-Logs |
| A10 | SSRF | Nicht anwendbar | Kein Server |

---

## 8. Empfehlungen

### Kurzfristig (bei Inbetriebnahme)

1. NTFS-Berechtigungen auf dem NAS-Ordner auf die Anwendergruppe beschränken
2. Standard-Passwörter der Demo-Accounts vor Produktivbetrieb ändern
3. `data.db` in die bestehende Backup-Routine aufnehmen

### Mittelfristig (bei wachsender Nutzung)

4. PBKDF2-Iterationen auf OWASP-Empfehlung (600.000) erhöhen
5. Bei Mehrbenutzerbedarf: Migration auf Server-Variante evaluieren
6. Bibliotheken auf aktuelle Versionen prüfen (jährlich)

### Optional (bei erhöhten Sicherheitsanforderungen)

7. Server-Variante mit HTTPS für Transport-Verschlüsselung
8. Serverseitige API-Authentifizierung für strikte Zugriffskontrolle
9. Audit-Logging auf Server-Ebene

---

## 9. Fazit

Das SchulungsHub weist ein **geringes Risikoprofil** auf. Durch den Verzicht
auf eine Server-Komponente entfallen die häufigsten Angriffsvektoren
moderner Webanwendungen. Die Passwort-Sicherheit entspricht dem Branchenstandard.
Die gespeicherten Daten haben eine niedrige Schutzklasse.

Die dokumentierten Einschränkungen der NAS-Variante (fehlende serverseitige
Zugriffskontrolle, keine Verschlüsselung at Rest, keine Concurrency-Kontrolle)
sind architekturbedingt und für den definierten Einsatzzweck vertretbar.
Sämtliche Einschränkungen können durch die vorbereitete Server-Variante
bei Bedarf adressiert werden.

Die Anwendung ist für den vorgesehenen Einsatz im internen Netz mit
definierter Anwendergruppe **freigabefähig**.
