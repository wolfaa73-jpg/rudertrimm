# Rudertrimm V2 – technische Architektur

Releasebezug: **Rudertrimm V2 · 0.9.0-beta.1 · Build 2026-07-16 · shell-1f28bf1a5d5a322a**  
Shell-Revision: `sha256-1f28bf1a5d5a322a26dd19b5efdc3aff0addd97bdc29e48d0f5629732cbb0d96`; zentrale Quelle: `../version.js`.

Stand: 16. Juli 2026. Status: implementierter V2-Prototyp plus dokumentierte Zielgrenzen.

## 1. Aktueller Laufzeitaufbau

```text
index.html + css/ + version.js
        |
        v
js/app.bundle.js ----------------> SVG/DOM
        ^
        | deterministisch erzeugt
js/app.mjs
   |     |
   |     +--> noch DOM-nahe Kinematik und Statusableitungen
   |
   +--> js/core.mjs
   |      Presets, Wertebereiche, DTOs, Hebelgeometrie,
   |      Reichweiten- und 90°-Regeln
   |
   +--> js/import-adapter.mjs
   |      Vorschau, Alt-V2-Migration, Dubletten, ID-Konflikte
   |
   +--> js/legacy-v1.mjs
   |      begrenzte V1-Übernahme ohne DOM-/Storage-Seiteneffekt
   |
   +--> js/recommendations.mjs
   |      deterministische Ergebnispriorisierung und Snapshotdaten
   |
   +--> js/storage.mjs
   |      Ruderer-, Boots- und Workspace-Repositories
   |      IDs, Revisionen, History, Quarantäne, atomare Commits, Multitab-Sync
   |
   +--> js/ui-session.mjs
   |      Sitzgebundene Auswahl, beobachtete Workspace-Revision,
   |      wahrheitsgemäßer New/Available/Synced-Status und Workflowprojektion
   |
   +--> js/history.mjs
   |      begrenzte unveränderliche Snapshots und stabiler Alt/Neu-Vergleich
   |
   +--> js/efa-csv.mjs
          UTF-8/RFC4180-Parser, Mapping, Vorschau und Kandidatenklassifikation

sw.js --> ausschließlich allowlist-basierte statische Shell
```

Alle neun JavaScript-Module sind ES-Module ohne Produktivabhängigkeiten. `app.mjs`
orchestriert die Oberfläche; die acht übrigen Fach-/Datenmodule sind DOM-frei und direkt mit
Node testbar.

`scripts/build-classic-bundle.mjs` bündelt diese Source-of-Truth-Module mit exakt gepinntem
`esbuild@0.28.1` als externes IIFE. Das mitgelieferte `js/app.bundle.js` ist der einzige
Browser-Runtimepfad unter Doppelklick und HTTP; Empfänger benötigen keinen Build. Der
Staleness-Test verlangt Bytegleichheit, klassisches Parsen, keine statischen Imports/Exports,
kein `eval` und keine absoluten Buildpfade.

## 2. Datenverträge

Fachobjekte besitzen Domain-`schemaVersion: 4` und einen festen `kind`. Validatoren akzeptieren nur
exakt bekannte Felder, endliche Zahlen, dokumentierte Wertebereiche und sichere Namen.
Unbekannte Felder werden nicht still übernommen. Die Namensgrenze zählt Unicode-Codepoints;
UI-Kürzung kann daher kein Surrogatpaar teilen. Lone Surrogates und Unicode-Nichtzeichen sind
ungültig, damit Anzeige, JSON und spätere UTF-8-Übertragung denselben Text repräsentieren.

Lokale gespeicherte Sammlungen verwenden davon getrennt Envelope-Schema v3:

```text
rudertrimm.storage
  schemaVersion
  kind
  revision
  updatedAt
  records[]
    id
    revision
    updatedAt
    value
  history
    entries[]
      entityId
      revision
      changedAt
      reason
      snapshot
    floors[]
      entityId
      throughRevision
```

Dateiexporte verwenden weiterhin `rudertrimm.exchange` in Schema v2 und enthalten lokale
History nicht still. Der aktuelle Arbeitsstand liegt in einem separaten Workspace-Repository
und darf keine eingebetteten Boots- oder Rudererdatenbanken enthalten.

### 2.1 History- und Löschvertrag

- Create, Update, Import und Migration schreiben aktuellen Datensatz und Snapshot im selben
  Repository-Commit. Snapshots sind innerhalb des Aufbewahrungsfensters unveränderlich.
- Aufbewahrung ist bewusst begrenzt: höchstens 20 Revisionen je Entität, 500 Einträge und
  500 Floors insgesamt. `throughRevision` kennzeichnet entfernte ältere Fakten.
- Der interne Storage darf bis 2.621.440 Bytes wachsen; Exchange- und Legacy-v2-Eingaben
  bleiben bei 1 MiB. Bytebasierte Retention erhält den aktuellen Snapshot und die
  Editierbarkeit eines exakt 1 MiB großen Imports.
- `/seats` wird im Alt/Neu-Vergleich über stabile Sitz-ID statt Arrayindex projiziert.
- Privacy-Delete entfernt frühere personenbezogene Snapshots. Er behält nur einen
  datenarmen Delete-Tombstone/Floor und verhindert die Wiederverwendung derselben ID.

### 2.2 Boot-, Platz- und Zuordnungsvertrag

- Reale Ruderplätze besitzen stabile IDs: Platz 1 ist Bug, Platz N ist Schlag.
- 1x, 2x, 2−, 3x, 4x, 4−, 4+, 6x und 8+ erzeugen exakt ihre Ruderplatzanzahl; 3x/6x sind
  Vereinsklassen. Cox-Metadaten bei 4+/8+ sind kein Rudererprofil und kein Ruderplatz.
- Bootsgeometrie ist gemeinsam, Körpermaße sind profilbezogen, verstellbare Trimmwerte
  sitzplatzbezogen; Zuordnungen referenzieren beide Seiten über stabile IDs.
- Kapazitätswechsel remappen Bug/Schlag rollenbasiert und atomar, ohne Personen still zu
  vertauschen oder freie Plätze aufzufüllen.
- Die UI führt alle realen Zuordnungen; die Körpergrafik zeigt höchstens Referenz- und aktiven
  Sitz und behauptet keine Vollcrew-Simulation.

v2-/v3-Eingaben werden in ein neues v4-Objekt migriert. Adapter verändern weder Eingabeobjekt
noch Legacy-Rohbytes in-place; unbekannte Future-Schemas brechen fail-closed ab.

## 3. Schreib- und Konfliktregel

1. Eine menschliche Vorschau oder Bestätigung geschieht vollständig vor der Exklusivklammer.
2. Persistente Repository-Mutationen erhalten einen originweiten Web Lock pro Repository-Key.
3. Innerhalb des Locks wird der Storagewert frisch gelesen, validiert und die beobachtete
   Repository- sowie gegebenenfalls Datensatzrevision erneut verglichen.
4. Eingabe wird in ein explizites DTO kopiert; Fachvalidator und JSON-Sicherheitsprüfung laufen
   vor jeder Mutation.
5. Erst der vollständig serialisierte neue Envelope wird geschrieben.
6. Bei Quota-/Storage-Fehler bleibt der vorherige In-Memory- und Storagezustand erhalten.
7. Andere Tabs werden erst nach erfolgreichem Commit benachrichtigt.
8. Broadcast- und Storage-Signale werden über den exakt beobachteten Rohwert dedupliziert;
   `storage.clear()` wird als Wechsel auf einen leeren, gültigen Stand erkannt.
9. Ohne Web Locks ist persistentes `localStorage` für Repository-Schreibvorgänge gesperrt;
   tablokales `sessionStorage` beziehungsweise Memory bleibt nutzbar und wird sichtbar benannt.
10. Wird im frischen Read ein Storage-v2-Umschlag erkannt, wird dessen Migration nach v3
    innerhalb desselben Locks vor der angeforderten Mutation committed. Bestätigung oder
    Dialog liegen nie innerhalb dieser Klammer.

Ein fremder Tab darf daher keinen alten Formularstand still überschreiben. Konflikte verlangen
erneutes Laden, Speichern als Kopie oder eine spätere explizite Konfliktoberfläche.
Ein wartender Profil-Commit erfasst Sitz, Auswahl und Draftversion beim Auslösen; sein Abschluss
darf weder einen inzwischen anderen Sitz binden noch dessen neuen Dirty-Schutz löschen.

## 4. Import- und Migrationsregel

- Dateigröße maximal 1 MiB, maximal 250 Datensätze.
- Neues Exchangeformat und frühere V2-Core-Exports werden strikt geprüft.
- V1-Eingaben laufen ausschließlich durch `legacy-v1.mjs`; daraus entstehen neue DTOs, während
  die Legacy-Quellbytes erhalten bleiben.
- Noch vor der Bestätigung wird das deduplizierte Merge-Ergebnis gegen die konkrete
  Repository-Kapazität geprüft; ein übergroßes Ergebnis kann nicht bestätigt werden.
- Importvorschau zeigt Bestand, Eingang, neue Einträge, exakte Dubletten, ID-Konflikte und
  die maximale Kapazität.
- Exakt gleiche Fachobjekte werden übersprungen.
- Gleiche ID bei anderem Inhalt erhält eine neue stabile ID.
- Erst das vollständige zusammengeführte Ergebnis wird atomar übernommen.
- Ungültiger oder abgebrochener Import verändert nichts.
- Nach Nutzerbestätigung wird die Vorschau im Lock gegen den frischen Repositorystand erneut
  gebildet; jede Abweichung bricht atomar mit `import-preview-changed` ab.
- Kann ein korrupter Rohwert nicht sicher gelesen oder quarantänisiert werden, wechselt das
  Repository in `unsafe-recovery` und sperrt Folge-Schreibvorgänge, statt Bytes zu ersetzen.
- Der frühere Workspace-Browserkey bleibt als unveränderte Format-Rückfallquelle erhalten. Der
  neue Workspace wird separat validiert geschrieben; bei einem Einer entstehen keine
  versteckten Zweitplatzdaten. Das ist keine Zusage über sichere Löschung aus Backups.

### 4.1 Einmaliger eFa-CSV-Stagingimport

- Eingabe ist eine explizit gewählte UTF-8-/RFC4180-Datei mit fest gewähltem Komma,
  Semikolon oder Tab und bewusst bestätigtem Spaltenmapping.
- Vorschau geschieht ohne Mutation außerhalb des Locks. Im exklusiven Commit werden Datei-
  Fingerprint und Konfliktlage gegen den frischen Stand erneut geprüft.
- Persistiert werden nur klar unvollständige Personen-/Bootskandidaten mit optionaler
  externer ID, Provenienz und Digest. Raw-CSV, lokale Pfade und Credentials werden verworfen.
- Kandidaten sind keine vollständigen Profile/Boote, werden nicht zugeordnet und sind nicht
  berechnungsfähig. Es gibt keinen Live-Sync, kein Writeback und keinen direkten
  eFa-Datenbank-/Dateizugriff.

### 4.2 Passive Profillöschung

Ein unzugeordnetes gespeichertes Profil kann in Details ausgewählt werden, ohne es einem Sitz
zuzuweisen. Die Bestätigung geschieht vor den Locks. Danach werden in fester
Workspace→Boot→Person-Lockreihenfolge gespeicherter Arbeitsstand und Boote frisch auf
Referenzen geprüft; jede Verwendung bricht fail-closed ab. Workspace- und Bootsspeicherungen
prüfen innerhalb ihrer festen Lockreihenfolge zusätzlich, ob eine referenzierte Profil-ID
zwischenzeitlich gelöscht wurde. Erfolgreiche Löschung folgt dem Privacy-History-Vertrag.

## 5. Browser-Speicherklassen

1. `localStorage` nach Schreib-/Löschprobe: persistente V2-Vorschau mit Multitab-Hooks.
2. Falls blockiert: `sessionStorage`, nur für den aktuellen Tab, ohne Multitab-Broadcast.
3. Falls ebenfalls blockiert: flüchtiger Memory-Adapter.

Unter `file://` wird persistentes `localStorage` bewusst nicht als browserübergreifend
verlässlich behauptet; die App verwendet sichtbar Session- oder Memory-Fallback. Unter HTTP
bleibt die Web-Locks-/Mehrtab-Prüfung maßgeblich.

Die Kontextleiste und Save-Meldung nennen die aktive Klasse. Bei Tab-/Memory-Speicher warnt
`beforeunload` auch nach einem scheinbar sauberen Save. Für eine Kaufapp ist dies keine
Endarchitektur; Ziel ist ein injiziertes `SyncRepository` mit serverseitiger Autorisierung,
Revisionen, Löschung und Offline-Strategie.

Unabhängig davon unterscheidet der sichtbare Editor `new`, `available` und `synced`: Ein im
Repository vorhandener, aber noch nicht in die Formulare geladener Workspace wird niemals als
gespeicherter aktueller Formularstand ausgegeben.

## 6. Security-Grenzen

- Keine dynamischen HTML-Sinks für Namen oder Importdaten; Ausgabe über `textContent`,
  `value` und sichere DOM-Erzeugung.
- Self-only Script-CSP, kein `unsafe-eval`, keine Inline-Skripte; das externe Classic-Bundle
  erfüllt denselben Vertrag auch beim Doppelklick.
- Import-, Storage- und Workspace-Schemas sind deny-by-default.
- Service Worker cached nur gleiche Origin, eigenen Scope und eine feste Asset-Allowlist.
- Aktivierung löscht ausschließlich veraltete Caches des exakt eigenen Service-Worker-Scopes;
  Rudertrimm-Caches in Geschwister-Scopes derselben Origin bleiben unberührt.
- Beliebige HTML-Navigation ersetzt nie die Offline-Shell.
- Ein aktiver Worker bedient Navigation und Assets ausschließlich aus seinem unveränderlichen
  Releasecache. Fehlende Einträge scheitern mit 503, statt HTML N+1 mit Modulen N zu mischen.
- Precache-Antworten müssen die erwartete kanonische URL exakt treffen und dürfen nicht aus
  einem Redirect stammen.
- Shell-Cache enthält einen durch Tests verifizierten SHA-256 über alle Precache-Assets.

Die Meta-CSP ersetzt keine HTTP-Header. Verbindliche Produktionsheader stehen in
`PRODUCTION-READINESS.md`.

## 7. PWA-Updatevertrag

`sw.js` cached die statische Shell während `install`. Der Cache-Name kombiniert die
kollisionsfrei URL-codierte Origin+Scope-Pfad-Identität, Appversion und Shell-Hash. Ändert ein
Precache-Asset ohne aktualisierten Hash, schlägt der Test fehl. Eine neue
Version wartet kontrolliert; die UI meldet das Update, statt einen laufenden Zustand mitten in
der Sitzung auszutauschen.

Unter `file://` wird der Service Worker vor jedem API-Aufruf übersprungen und der Status
ehrlich angezeigt. Unter HTTP/HTTPS registriert die App ihn genau einmal – sofort nach bereits
erfolgtem `load` oder sonst über einen einmaligen `load`-Listener.

Das vorhandene Vereinsicon ist als normales Icon deklariert. Ein fachgerecht gepolstertes und
gestalterisch freigegebenes Maskable-/Store-Icon bleibt ein Release-Gate.

## 8. Kinematikgrenze und Natural-Catch-Vertrag

`deriveBodySegments` und `solveNaturalCatchAngle` liegen als DOM-freie, direkt getestete
Funktionen in `core.mjs`. Der Natural-Catch-Solver verwendet Zentimeter und Grad, berechnet die
modellierte Ist-Auslage aus Fa, Körpermaßen und Rig und bleibt unabhängig vom Rigg-Ziel. Er
prüft die vorhandene Sitz-/Rollbahnhülle, rastert deterministisch 20–88° in 0,5°-Schritten und
verfeinert nur lokal. Das ist bewusst keine falsche Behauptung von „2–3 Iterationen“.

`app.mjs` cached das Ergebnis pro vollständiger Fachkonfiguration; Phase und
Animationsfortschritt gehören nicht zum Cache-Key. Die stärkere V2-3D-Prüfung beider realen
Griffziele bleibt Sicherheitsnetz. So läuft weder Raster- noch Fallbacksuche pro Frame.
Ohne Vorzeichenwechsel oder ohne erreichbare 3D-Griffpose bleibt der finite Such-/Fallbackrand
nur eine stabile Prüfpose; `actualAngleDeg` und die entsprechenden Exportfelder sind `null`.

Folgende DOM-nahe/rendereingebundene Teile bleiben bis zu realen Golden-Daten in `app.mjs`:

- `solveBody`
- `solveArms`
- `bodyRefs`
- Statusableitungen des Körpermodells

Vor einer fachlichen oder kommerziellen Freigabe werden sie in ein reines
`kinematics.mjs`/Domainpaket verschoben. Der Zielvertrag:

- keine DOM-, Storage- oder globale-State-Abhängigkeit;
- vollständig explizite Ein- und Ausgabe;
- Golden-Datensätze aus realen Skull-, Riemen- und Grenzfallmessungen;
- Segmentlängen-, Reichweiten-, Symmetrie- und Monotonie-Invarianten;
- Trainerfreigabe von Definition, Messmethode und Toleranz.

Der 3D-Fallback sucht absteigend und verfeinert nur die lokale erreichbare Oberkante; er setzt
keine globale Monotonie voraus und verlangt beide realen Griffziele. Vollständige
Unerreichbarkeit bleibt endlich berechenbar, wird aber sichtbar als
„kein Winkel im Prüfbereich erreichbar“ statt als erreichbares 30°-Limit ausgegeben.

## 9. Plattform- und Commerce-Grenzen

Die Weboberfläche bleibt ein Adapter. Native Packaging kann später beispielsweise über
Capacitor erfolgen, ohne Fachlogik an Apple- oder Google-SDKs zu koppeln. Vorher werden diese
Ports implementiert:

- `AuthProvider`
- `EntitlementProvider`
- `SyncRepository`
- `TelemetryPort`

Billing, Restore, Refund, Serververifikation und Offline-Entitlements gehören nicht in
`app.mjs`. Der vollständige Vertrag steht in `STORE-COMMERCE-ARCHITECTURE.md`.

## 10. Verifikationsschichten

| Schicht | Automatisiert | Noch manuell |
|---|---|---|
| DTO/Fachkern | Unit- und Presetmatrix-Tests | Trainer-/Messreihenfreigabe |
| Storage/History/Import | Fehler-, Konflikt-, Quota-, Migration-, Retention- und CSV-Tests | echte eFa-Datei, Multitab/Fallback und Konflikt-UX |
| HTML/CSP/Manifest | statische Invariantentests | Screenreader und Browsermatrix |
| Service Worker | VM-Isolation und Shell-Hash | installierte Offline-PWA/Update auf Geräten |
| Responsive CSS | bisherige Browser-Geometriematrix + statische Hooks | finale 320–1600 px, Zoom, iOS/Android |
| Store/Commerce | Architekturspezifikation | Backend, Sandbox, Signing und Store Review |

Für diesen Stand ausgeführt: **13/13 JavaScript-Parseprüfungen**, **1/1 deterministische
Bundle-Stalenessprüfung**, **235/235 Node**, **3/3 Python**. Der Chrome-390-Kurzlauf war
positiv; offen bleiben frische reale Motion-Sichtprüfung, vollständige 320/390-Matrix auf
realen Geräten, Tastatur/Screenreader, Browser-Doppelklick,
installierte PWA, Trainer-Golden-Daten, realer eFa-Originalexport samt Version/
Spaltenmapping sowie Rechts-/Storeprüfung.
