# Rudertrimm V2 Beta

**Rudertrimm V2 · 0.9.0-beta.1 · Build 2026-07-16 · shell-1f28bf1a5d5a322a**  
Shell-Revision:
`sha256-1f28bf1a5d5a322a26dd19b5efdc3aff0addd97bdc29e48d0f5629732cbb0d96`

Technischer V2-Prüfstand für Alex’ Rudertrimm-App. Diese Fassung erhält die V1-Kernidee,
Visualisierungen und Animation, trennt aber Fachlogik, Datenhaltung, Import, UI-Zustände und
PWA-Verträge deutlich belastbarer. Sie ist keine Trainer-, Produktions- oder Storefreigabe.

Die unveränderte V1-Referenz liegt in `../source/`.

## Lokal starten

### Doppelklick ohne Installation

Den Ordner vollständig entpacken und `index.html` doppelklicken. Die Kern-App,
Visualisierungen, Demos und Datenaktionen funktionieren direkt. `file://` bietet bewusst
keinen Service Worker/PWA-Cache und nutzt je nach Browser tabgebundenen oder flüchtigen
Speicher; die App kennzeichnet beides sichtbar.

### HTTP/PWA-Vollmodus

```bash
python3 -m http.server 8765 --bind 127.0.0.1
```

Dann <http://127.0.0.1:8765/> öffnen. Hier stehen – soweit unterstützt – persistenter
Mehrtab-Speicher und Service Worker/PWA-Cache bereit.

## Schnell ausprobieren

- **Testiel · Demo laden:** synthetischer 1x-Arbeitsstand mit
  185/90/95/188/40/80, ohne Autopersistenz oder Autostart.
- **Vergleichsdemo laden:** Testiel + Testiel 2 in 4x; zwei echte Zuordnungen bei vier
  realen Ruderplätzen, zwei Plätze bleiben ehrlich frei.
- **Kompakt:** Arbeitskontext, Belegung, Ergebnis/Warnungen, Visualisierung, Innenhebel,
  Stemmbrett-Längsposition und Speichern.
- **Details:** alle Feinparameter, Datenbank-, Import-/Export-, Bericht- und Quellenfunktionen.
- **Stammdaten in Details:** getrennte Personen-/Bootslisten mit bewusstem Laden/Zuordnen;
  Quick Edit ändert nur die Arbeitskopie und speichert nie automatisch.
- **Einsteigerführung:** fünf kurze Schritte verlinken Boot, Sitz, Profil, Ergebnis und
  Speichern. Ein Ergebnis wird erst nach bewusster Prüfung als erledigt markiert.
- **Änderungsverlauf in Details:** begrenzte Personen-/Bootsrevisionen und Alt/Neu-Vergleich
  mit stabiler Sitzzuordnung; Aufbewahrungsgrenzen werden sichtbar genannt.
- **Einmaliger eFa-CSV-Import in Details:** explizites Mapping und Vorschau erzeugen nur
  unvollständige lokale Kandidaten, keine automatische Belegung oder Synchronisation.
- Drauf-, Seiten- und Quersicht teilen sechs manuelle Phasen sowie Start/Stop/Tempo.

## Technischer Stand

- 0.9 ist ein ausdrücklich separat eingefrorener Kommentar-/Übergabemeilenstein ohne
  Runtime-, Schema- oder Migrationsänderung. Kritische Lock-, Privacy-, Cache-,
  Preview-/Commit- und asynchrone UI-Verträge sind direkt an den nativen Quellen erklärt.
- Strikte Domain-DTOs in Schema v4; der lokale Storage-Umschlag ist v3 und enthält begrenzte
  History/Floors, das Austauschformat bleibt v2 und enthält lokale History nicht still.
  Frisch gelesene Storage-v2-Basen werden im selben exklusiven Lock vor der Folgeaktion
  atomar nach v3 migriert. Legacy-Eingaben entstehen als neue Objekte, nicht per In-place-
  Umschreiben.
- Reale, stabil identifizierte Ruderplätze: Platz 1 ist Bug, Platz N ist Schlag. Unterstützt
  werden 1x, 2x, 2−, 3x, 4x, 4−, 4+, 6x und 8+; 3x/6x sind als Vereinsklassen markiert.
  Steuermannsdaten bei 4+/8+ sind Metadaten und niemals ein Rudererplatz.
- Fachkern für Presets, Bereiche, Momentarme, Übergriff, Reichweite und 90°-Prüfung.
- Kontrolliert portierter Natural-Catch-Solver: Fa, Körpermaße und Rigg bestimmen die
  modellierte Ist-Auslage; das Rigg-Ziel bleibt separat. Die Berechnung ist pro Konfiguration
  gecacht und bleibt als unkalibriertes 58°/16°-Prüfmodell kenntlich.
- Ohne Nullstelle im 20–88°-Prüfbereich oder ohne erreichbare 3D-Griffpose wird nur eine klar
  markierte Prüfpose gezeichnet; UI und Messbericht geben keinen erfundenen Ist-Wert aus.
- Neue Fa-Defaults 32,5 cm (Skull) / 50 cm (Riemen) gelten nur nach bewusster Neu-/Presetwahl;
  gespeicherte Profile und Arbeitsstände werden nicht still verändert.
- Getrennte Repositories für Ruderer, Boote und Arbeitsstand mit stabilen IDs, Revisionen,
  Quarantäne, Quota-Schutz und Multitab-Synchronisierung.
- Personen-/Bootsmutationen schreiben aktuellen Datensatz und begrenzten History-Snapshot
  atomar. Alt/Neu ordnet Sitze über stabile IDs; Datenschutzlöschung entfernt historische
  personenbezogene Fakten und sperrt gelöschte IDs per Tombstone/Floor.
- Striktes lokales UTF-8/RFC4180-eFa-CSV-Staging mit explizitem Trenner/Mapping, Vorschau,
  Freshness und Konfliktklassen. Es speichert nur unvollständige Kandidaten mit Provenienz,
  niemals Raw-CSV, Credentials, erfundene Fachwerte, Sync oder Writeback.
- Ein nicht zugeordnetes gespeichertes Profil kann in Details passiv gelöscht werden.
  Frische Workspace-/Bootsreferenzen blockieren verwendete Profile; feste
  Workspace→Boot→Person-Sperrfolge und Speicher-Guards schließen beide Race-Reihenfolgen.
- Persistente Mutationen als frisches Read→Compare→Write unter Web Locks; Dialoge bleiben
  außerhalb der exklusiven Klammer. Ohne sichere Koordination sichtbarer tablokaler Fallback.
- Atomarer Import mit Vorschau, Grenzmenge, Dubletten, ID-Kollisionen und Migration.
- Boot, reale Sitzplätze, Rudererprofile und Zuordnungen bleiben getrennt; ein Klassenwechsel
  ordnet Bug/Schlag rollenbasiert um und erfindet weder Personen noch Plätze.
- Ein sichtbar priorisierter Bereich **Ergebnis & Handlungsbedarf** liefert deterministisch
  höchstens drei Maßnahmen aus der vorhandenen KPI-/Warnlogik. Fehlende Daten bleiben neutral;
  JSON-/Druck-Snapshots können Namen vor der Ausgabe anonymisieren.
- Die Visualisierung zeigt bei einer Mannschaft höchstens Referenz- und aktiven Sitz; freie oder
  weitere belegte Plätze bleiben in der Belegungsanzeige ehrlich sichtbar und werden nicht als
  zusätzliche Figuren erfunden.
- Scope-/Origin-/Allowlist-isolierter Service Worker mit unveränderlichem Releasecache.
- CSP-konformes Classic-Bundle als gemeinsamer Doppelklick-/HTTP-Runtimepfad; native Module
  bleiben Source of Truth, Bundle-Staleness wird bytegenau geprüft.
- Eine `version.js` ist Source of Truth für SemVer, Builddatum, Build-ID und Shellrevision.
- Slider und numerische Fachfelder teilen Grenzen, Einheit, Schrittweite und einen
  validierten Zustandsweg; ungültige Eingaben verändern keine Berechnung.
- Unveränderte Ergebnislisten werden während der Animation nicht neu aufgebaut; Fokus bleibt
  erhalten und Feldsprünge respektieren Reduced Motion.
- Responsive/A11y-Basis: 44-px-Touchziele, Fokus, Skip-Link, Live-Status, Reduced Motion,
  Forced Colors, stabile Visualhüllen und beschriftete SVGs.
- Vollständige V1-Kernparität: KPIs/Status, Proportionsfigur, drei Ansichten, sechs Phasen,
  Start/Stop, Tempo und dynamische Riggreaktionen.

## Fachliche Grenze

World-Rowing-Presetmediane sind reproduzierbar. Natural-Catch, Körperkinematik, Armwinkel und
90°-Modell sind noch nicht durch reale Messreihen kalibriert und bleiben sichtbar als Prüfmodell
gekennzeichnet. Keine individuelle Trainerempfehlung daraus ableiten.

## Tests

Mit Node.js 20+:

```bash
npm ci
npm run verify
```

Einzelbefehle nach `npm ci`:

```bash
node --check version.js
node --check js/app.mjs
node --check js/app.bundle.js
node --check js/core.mjs
node --check js/storage.mjs
node --check js/import-adapter.mjs
node --check js/legacy-v1.mjs
node --check js/recommendations.mjs
node --check js/ui-session.mjs
node --check js/history.mjs
node --check js/efa-csv.mjs
node --check scripts/build-classic-bundle.mjs
node --check sw.js
node scripts/build-classic-bundle.mjs --check
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py' -v
```

Final ausgeführt: **13/13 JavaScript-Parseprüfungen**, **1/1 deterministische
Bundle-Stalenessprüfung**, **235/235 Node**, **3/3 Python**.

Ein unabhängiger Chrome-Dev-Direktstart bei 390×844 bootete ohne horizontalen Überlauf oder
Konsolenfehler und bestätigte im Kurzlauf Moduszustand, Vergleichsdemo, Ansichten, Phasen und
Dialogfokus. Das ersetzt keine Safari-/Firefox-, Geräte-, Screenreader- oder lange Motion-Abnahme.

Die offizielle World-Rowing-Arbeitsmappe kann separat reproduziert werden:

```bash
python3 scripts/analyze_world_rowing_2017.py /pfad/zur/2017RiggingSurveyJune272018_Neutral.xlsx
```

Nur bei akzeptierter Originaldatei und vollständiger Übereinstimmung endet das Skript mit
`VERIFIED`.

## Orientierung

- `version.js` – zentrale Release-Metadaten
- `index.html`, `css/` – Oberfläche, Responsive und A11y
- `js/core.mjs` – Fachkern und DTO-Verträge
- `js/storage.mjs` – lokale Repositories und Multitab
- `js/import-adapter.mjs` – Import/Migration/Vorschau
- `js/legacy-v1.mjs` – streng begrenzter, DOM-freier V1-Adapter
- `js/recommendations.mjs` – deterministische Priorisierung von höchstens drei Maßnahmen
- `js/ui-session.mjs` – Sitz-/Draft-/Workspace-Wächter
- `js/history.mjs` – begrenzte Revisionssnapshots und stabiler Alt/Neu-Vergleich
- `js/efa-csv.mjs` – striktes CSV-Parsing, Mapping und Kandidatenklassifikation
- `js/app.mjs` – UI, SVG, Animation und noch DOM-nahe Kinematik
- `js/app.bundle.js` – erzeugter Browser-Runtimepfad; nicht manuell bearbeiten
- `scripts/build-classic-bundle.mjs` – deterministischer Generator
- `sw.js` – Offline-Shell
- `tests/` – automatisierte Regressionen
- `docs/` – Architektur, Quellen, UX- und Produktionsgates

## Offene manuelle Gates

Siehe `../UEBERGABE-MANIFEST.md`: frische reale Sichtprüfung der gemeldeten Körper-/Schulterbewegung,
vollständige 320/390-Matrix, reale Geräte, Tastatur/Screenreader, Doppelklick in Safari/Firefox, installierte
PWA, Trainer-Golden-Daten, realer eFa-/efaLive-Originalexport samt Version,
Spalten/Encoding/IDs und echter Mapping-Journey sowie Recht/Store/Produktbetrieb.

## Datenschutz

Namen, Körpermaße, Gewicht und Bootszuteilung können personenbezogene Daten sein. V2 sendet
sie nicht an einen eigenen Server, speichert sie jedoch lokal und kann sie als JSON exportieren.
Gerätezugriff, Browserprofil, Backups und Exportdateien bleiben datenschutzrelevant.
