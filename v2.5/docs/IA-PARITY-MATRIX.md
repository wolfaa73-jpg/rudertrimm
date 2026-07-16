# Rudertrimm V2 – umgesetzte Informationsarchitektur und V1-Parität

Stand: 16. Juli 2026  
Status: implementierter Vertrag für Kompakt, Details und den gemeinsamen Prüfstand

Releasebezug: **Rudertrimm V2 · 0.9.0-beta.1 · Build 2026-07-16 · shell-1f28bf1a5d5a322a**  
Shell-Revision: `sha256-1f28bf1a5d5a322a26dd19b5efdc3aff0addd97bdc29e48d0f5629732cbb0d96`.

## Ziel und Stopregel

Alex' dunkelgrüne Werkstatt-/Instrumentenästhetik, das funktionale Grün, die warmen
Ruder-/Bewegungsfarben und die komplette Fachsubstanz bleiben erhalten. Umgeordnet wird nur,
wenn der neue Fundort Orientierung, Scrollstrecke, Lesbarkeit, Zustandsfeedback oder mobile
Bedienung konkret verbessert. Fachgeometrie, Formeln, sechs Phasen und Choreografie werden
nicht verändert. Kein Framework, kein neues Designsystem und keine verschachtelte
Accordion-Landschaft.

## Inhalts- und Fundortmatrix

| V1-/V2-Inhalt | Aktueller eindeutiger Fundort | Paritätsvertrag |
|---|---|---|
| Logo, Name, Beta-/Prüfstatus | Kopf der linken Werkstattspalte | Identität unverändert sichtbar |
| Boot, Modus, realer Platz, Belegung, Speicher, Offline | sticky Kontext- und Sitzleiste | Bug = Platz 1, Schlag = Platz N; freie Plätze bleiben frei |
| Bootsklasse, Skull/Riemen, Blatt, Werkstatt/Wasser, Höhenreferenz | offene Gruppe **Grundsetup** in der Werkstattspalte | häufige Einstellungen ohne Offenlegungsschritt |
| DA, IH, L, d, Handabstand | Gruppe **Ruder & Rigg** | Kompakt: nur Innenhebel; vollständige Werte in Details |
| Dollenhöhe, Dollen-/Außenneigung, Δ BB−StB | einfache Gruppe **Höhe & Anlage**, standardmäßig kompakt | ein native-`details`, keine Unterebene; Zusammenfassung bleibt sichtbar |
| Fa, Stemmbrettwinkel, Rollbahnlänge, Überstand | Gruppe **Rollbahn & Stemmbrett** | Kompakt: nur Stemmbrett-Längsposition Fa; vollständige Werte in Details |
| Schlagbogen, Durchzug, Bootshöhe, Gewichtskorrektur | Gruppe **Schlagbogen & Boot** | Durchzug zusätzlich unmittelbar an der Visualisierung steuerbar |
| Bootsdatenbank, Arbeitsstand, Bericht, Import/Export | Bereich **Profile & Dateien** in der Werkstattspalte beziehungsweise Profilkarte | Datenbanken bleiben getrennt; alle vorhandenen Aktionen bleiben auffindbar |
| sieben Statuskarten | kompakte Prioritätsleiste direkt unter Zweck/Modellgrenze | alle sieben Werte bleiben im gemeinsamen DOM; **Kompakt** priorisiert Kernentscheidungen, **Details** zeigt die Vollsicht |
| ergänzende Status-/Messchips | Kennzahlenzeile bei den Karten | kritische Hinweise bleiben in beiden Modi sichtbar; sekundäre Diagnosen sind in **Details** vollständig erreichbar |
| Ergebnis & Handlungsbedarf | operative Entscheidung vor dem Prüfstand | neutral bei fehlenden Daten; sonst höchstens drei Maßnahmen mit Ist/Ziel, Grund, Wirkung und Feldsprung |
| Draufsicht | aktive Standardansicht im großen **Trimm-Prüfstand** | Boot, Dollen, Ruder, Blätter, Winkel, Griff-/Zugbereich und Legende unverändert |
| Seitenansicht samt Phasenwertetabelle | zweiter Tab im selben Prüfstand | ein Klick/Pfeiltaste; Rollbahn, Stemmbrett, Körper-/Arm-/Beinmodell vollständig |
| Querschnitt | dritter Tab im selben Prüfstand | ein Klick/Pfeiltaste; Wasser/Böcke, Ausleger, Höhen und Referenzen vollständig |
| sechs Phasen | direkt unter der aktiven Visualisierung | alle sechs echte Buttons; aktuelle Phase klar markiert |
| Start/Stop und Tempo | Kopf/Fuß des Trimm-Prüfstands | kein Autostart; Reduced Motion stoppt Autoablauf, manuelle Phasen bleiben |
| Ruderer-/Körpermaßgrafik | Karte **Ruderer & Profile** nach dem Prüfstand | Vitruv in Details; Kompakt zeigt Belegung/aktive Profilzusammenfassung |
| Körpermaße und Profil-Datenbank | gemeinsame Profilkarte | **Kompakt** zeigt Auswahl, Kernzusammenfassung und Demos; **Details** zeigt Anthropometrie, Stepper und vollständige Datenpflege |
| Personen- und Bootsstammdaten | getrennte passive Listen in **Details** | explizites Laden/Zuordnen; Quick Edit ändert nur die Arbeitskopie und persistiert nicht automatisch |
| Änderungsverlauf / Alt–Neu | eigener Bereich in **Details** | Entitäts- und Revisionswahl, stabile Sitz-ID-Differenzen und sichtbarer Aufbewahrungs-Floor; keine Arbeitsdatenmutation |
| einmaliger eFa-CSV-Import | eigener Bereich in **Details** | explizites Mapping/Vorschau; nur unvollständige lokale Kandidaten, kein Sync/Writeback/Auto-Assignment |
| passive Personenlöschung | Personen-Stammdaten in **Details** | unzugeordnetes gespeichertes Profil ohne Sitzbindung löschbar; Workspace-/Bootsreferenzen blockieren fail-closed |
| Slider und präzise Zahleneingabe | gemeinsames Control je Fachwert | identische Einheit, Grenzen und Schrittweite; ein validierter Fachzustand statt doppelter Werte |
| Einsteigerführung | fünfstufiges `details` vor dem Prüfstand | Boot → Sitz → Profil → Ergebnis → Speichern; Ergebnis erst nach bewusster Prüfung erledigt |
| reale Mannschaftsbelegung | Sitzleiste und Zuordnungsbereich | alle realen Plätze sichtbar; Körpergrafik höchstens Referenz + aktiver Sitz, keine erfundene Vollcrew |
| Kraftvergleich | innerhalb derselben Profilkarte | nur bei zwei Plätzen sichtbar, Bedeutung unverändert |
| Fachmodellwarnung | kurze, immer sichtbare Hinweiszeile vor den Ergebnissen | Trainer-/Kalibrierungsgrenze niemals hinter Hilfe versteckt |
| erklärungsintensive Messbezüge | höchstens wenige native `details` direkt an der betroffenen Gruppe | Tastatur/Touch nativ; Einheiten, Werte und kritische Hinweise bleiben offen sichtbar |
| Richtwerte, Quellen und Methoden | bestehender beschrifteter Detailbereich am Ende | vollständiger Text erhalten, initial ruhig |

## Umgesetzte Reihenfolge

Desktop ab 1001 px:

1. sticky Kontext;
2. Werkstattspalte mit Grundsetup, kompakten Fachgruppen und Datenaktionen;
3. Zweck + kurze Modellgrenze;
4. kompakte Status-/Kennzahlenhierarchie;
5. großer Trimm-Prüfstand mit Ansichtsumschalter, Visualisierung und Motionsteuerung;
6. Ruderer & Profile;
7. Quellen/Methoden.

Mobil bis 390 px verwendet dieselbe Informationsreihenfolge in einer Spalte. Der aktive
Prüfstand kommt vor den langen Profil-/Fachgruppen; Tabs, Phasen und Primäraktion besitzen
mindestens 44 px Touchhöhe. Es gibt keinen horizontalen Seitenscroll und keine mobile
Funktionsreduktion.

## Accessibility- und Regressionsvertrag

- Ansichten als echtes ARIA-Tabmuster: Tab/Shift+Tab, Links/Rechts, Home/End, eindeutiges
  `aria-selected`, `aria-controls`, roving `tabindex` und Fokus ohne Layoutsprung.
- Genau eine Ansichtsfläche ist interaktiv sichtbar; alle drei werden über denselben
  Render-/Phasenstand aktualisiert, ohne eine zweite Zeichenimplementierung.
- Native `details` statt hover-only Tooltips; kritische Warnungen, Einheiten, aktuelle Werte
  und Hauptaktionen bleiben außerhalb.
- Reduced Motion, Forced Colors, Druck und sichtbarer Fokus bleiben wirksam.
- Statische Verträge prüfen alle bisherigen IDs, sieben Karten, drei SVG-Hosts, sechs Phasen,
  Start/Stop/Tempo, Testiel und die neuen Fundorte. Browser-Screenshots bleiben ein manuelles
  Gate, solange die freigegebene Browsersteuerung den laufenden Tab nicht erreicht.

## Darstellungsmodi ohne zweiten Zustand

- **Kompakt:** Pflichtsicht für Kontext, reale Belegung, Ergebnis, Warnungen, Kern-KPIs,
  Visualisierung, Phase/Animation, Innenhebel, Stemmbrett-Längsposition, Demos und Speichern.
- **Details:** dieselben DOM-Komponenten und derselbe Fachzustand plus vollständige Rigg-,
  Körper-, Diagnose-, Datenbank-, Import-/Export-, Berichts- und Quellenfunktionen.
- Der Wechsel verändert weder Werte noch Dirty-State, aktive Ansicht, Phase oder laufende
  Animation. Es gibt keine Rollenlogik und keine zweite Renderengine.
