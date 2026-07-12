# Lastenheft — Ruderpositions-Visualisierer

**Stand:** 10. Juli 2026 · **Datei:** `index.html` (Single-File-App, kein Build, keine Abhängigkeiten)
**Fachliche Quelle:** DRV-Trimmhandbuch, Kap. 5 „Das Trimmen der Boote" (Ellerbrake/Filter · Nolte · v. Lingelsheim · Piesik)

Legende: ✅ umgesetzt · 🔧 Umbau nötig · 🆕 neu angefordert · ❓ offen

**Fortschritt:** Abschnitte 1–5 stehen (Körpermodell + Blätter am 10.7. fertig, verifiziert). Abschnitt 6 (Ruderer-Sektion,
Zwei-Ruderer-Vergleich, Datenbank) ist die nächste Ausbaustufe. Veröffentlichung (jetzt Abschnitt 7) kann als **v1.0 vor**
Abschnitt 6 erfolgen oder gebündelt als **v1.1 danach** — Reihenfolge offen (siehe Abschnitt 9).

---

## 1. Ziel & Rahmen

Browser-Werkzeug zum Visualisieren und Prüfen der Ruderplatz-Einstellung (Trimm) nach DRV-Richtwerten,
bedienbar über Schieberegler. Zielgruppe: Trainer, Bootswarte, Ruderer. **Weitergabe geplant** →
Veröffentlichung als gehostete PWA (Abschnitt 7). Eine einzige HTML-Datei bleibt die Quelle der Wahrheit
für alle Vertriebswege.

## 2. Fachliche Grundlage & Richtwerte (Ampel-Basis)

| Größe | Sollwert | Quelle |
|---|---|---|
| Übergriff Ü Skull | 18–23 cm (Ü = 2·(IH+d) − DA) | S. 155/156 |
| Übergriff Ü Riemen | 30–34 cm (Ü = IH + d − DA) | S. 155/156 |
| Auslagewinkel (zur Orthogonalen) | Weltklasse Skull 65–75° | S. 156 |
| Schlagweite | 110° Skull / 90° Riemen, ~60 % vor Orthogonale | S. 152 (Abb. 5) |
| Dollenhöhe über Wasser | 22–26 cm (Maß d, Abb. 2) | S. 152 |
| Dollen-Neigung (Anlage) | Norm 4° zum Heck, ±4°; Big-Blades eher weniger | S. 149/151 |
| Außenneigung Dollenstift | bis ~2° | S. 151 |
| Innenhebel-Faustformel | Riemen = DA + 30 cm · Skull = DA/2 + 8 cm | S. 161 |
| Stemmbrett-Kriterium | 90°-Ruderstellung bei 75 % Rollweg → Kniewinkel ~165° | S. 152 (Abb. 5) |
| Arme in der Auslage | ~6° zur Horizontalen (Blatt abgetaucht) | S. 151 (Abb. 4) |
| Stemmbrett-Neigung | Norm 45° zum Kiel, Variabilität −3° | S. 149 |
| Rollbahn | Länge ~75 cm; Verlängerung ~5 cm heckwärts über Dollenanlage | S. 149/151 |
| Eintauchtiefe | 1 kg Mannschaftsgewicht ≙ 1 mm | S. 150 |
| Presets | Nolte-/Lingelsheim-Tabellen je Bootsklasse | S. 159/161 |

## 3. Ist-Stand ✅

- **Riggerung:** Skull/Riemen umschaltbar; Presets 1x, 2x, 4x, 2-, 4-, 8+, Gig-Skull, Gig-Riemen; Blatttyp Big-Blade/Macon (wirkt auf Ruderlänge der Presets).
- **Eingaben (Slider):** DA, IH, L, d (Stift→Klemmring), Schulterbreite, Auslage-/Rücklagewinkel, Durchzug-%, Dollenhöhe über Rollsitz (a), Rollsitz über WL (c), Anlage, Außenneigung, Gewichtsdifferenz, Stemmbrett-Neigung, Rollbahnlänge, Rollbahn-Überstand.
- **Abgeleitet (bewusst NICHT direkt einstellbar):** Übergriff, Außenhebel, Hebelverhältnis, Schlagweite, 60/40-Anteil, Dollenhöhe über Wasser.
- **Ampel:** 6 Statuskarten (Ü, φA, Schlagweite, Dollenhöhe ü. W., Anlage, IH) + Chips (60/40, Außenneigung, Rollbahn-Überstand, Stemmbrettwinkel).
- **Ansichten:** Draufsicht (Schlagbogen, Griffweg, Auslage-Keil, Zugbereich, Ü-Maß, Legende; Außenhebel verkürzt dargestellt, Winkel maßstabsgetreu) · Querschnitt (Maße a/c/d, DA, Wasserlinie mit Gewichtseffekt, Außenneigung 4× überhöht) · Seitenansicht (Rollbahn, Stemmbrett, Dolle mit Anlage 4× überhöht, Körperdaten-Tabelle).
- **Dynamik:** Durchzug-Slider, Play-Animation (Durchzug schneller als Vorrollen), Tempo 0,25–2×, 6 klickbare Phasen (Einfang, Vord. Zug, Zugmitte, Hinterer Zug, Ausheben, Rückführung; Rückführung = Blatt ausgehoben).
- **Persistenz:** Speichern/Laden (localStorage), Export (JSON inkl. abgeleiteter Größen), Zurücksetzen.

## 4. Körpermodell ✅ (umgesetzt 10.7.2026)

**Behobenes Kernproblem:** drei unabhängige „Marionetten" (eine je Ansicht), die sich widersprachen;
lineare Gleichzeitig-Interpolation aller Gelenke; Arme ohne Ellbogen (Teleskop-Effekt);
Kopf in der Draufsicht fix bugwärts; Torso ohne Hüftbezug; Kniewinkel verletzte das 165°-Kriterium.

**Lösung:** `solveBody` (Rumpf/Beine, Constraint-Solver, Sequenz Beine→Rumpf→Arme) + `solveArms`
(Arme EINMAL in 3D: x=längs, y=Höhe, z=quer; Ellbogen-Swivel früh unten → Endzug hinten-außen am
Körper vorbei). Alle drei Ansichten projizieren dieselben Gelenkpunkte. Emergente Checks: Stemmbrett
(Knie bei 90° ≈ 165°, Fa-Default rig-abhängig Skull 42 / Riemen 38 cm), Arme in Auslage ~6°.

**Umgesetzte Anforderungen:**

1. **EIN kinematisches Körpermodell**, alle drei Ansichten sind reine Projektionen davon.
2. Gelenkkette **Fuß – Knie – Hüfte – Schulter – Ellbogen – Hand**; Hand ans Griffende gekoppelt (Position kommt aus der Rigg-Geometrie); Fuß am Stemmbrett; Sitz auf der Rollbahn.
3. **Bewegungssequenz** statt Linear-Lerp: Durchzug Beine → Rumpf → Arme; Vorrollen Arme → Rumpf → Beine.
4. **Ellbogen** über Zweigelenk-IK (Ober-/Unterarm), Reichweitengrenzen strikt eingehalten; im Endzug treten die Ellbogen seitlich aus (Draufsicht!).
5. **Kopf folgt Rumpfwinkel:** Vorlage → heckseitig der Schultern, Rücklage → bugseitig; Versatz in cm, nicht in Pixeln.
6. 🆕 **Körpergrößen-Einstellung:** Körpergröße als Eingabe (~150–210 cm), Segmentlängen (Ober-/Unterschenkel, Rumpf, Ober-/Unterarm) anthropometrisch daraus abgeleitet; **zusätzlich Feinjustage Beinlänge und Rumpflänge als eigene Regler** (Handbuch S. 151: Längseinstellung hängt an Bein- UND Rumpflänge). *(Entschieden 9.7.2026)*
7. 🆕 **Riemen-Griffhaltung: beide Hände ca. 2 Handbreit auseinander** am Innenhebel; Außenhand am Griffende, Innenhand dollenwärts versetzt. **Abstand einstellbar 14–22 cm (Slider, Default 18 cm).** Betrifft Zeichnung in allen Ansichten (zwei getrennte Handpunkte, zwei Arme mit unterschiedlicher Reichweite). Rigg-Rechnung (Ü, Hebel) bleibt auf Griffende bezogen. *(Entschieden 9.7.2026)*
8. **Riemen-Schulterrotation:** Außenschulter kommt in der Auslage vor („Hinausbeugen", S. 152) — Rotations-Freiheitsgrad der Schulterlinie in der Draufsicht.
9. **Stemmbrett-Längsposition als neuer Parameter** + neuer Ampel-Check: Kniewinkel bei 90°-Stellung/75 % Rollweg ≈ 165° muss sich **emergent** aus dem Modell ergeben.
10. **6°-Armlinie konsistent:** gezeichneter Arm und Ziellinie dürfen sich nicht widersprechen.
11. **Kraftvektor:** entweder klar „schematisch" gelabelt ohne Fake-Newton oder physikalisch hergeleitet (Richtung ⊥ Schaft, Betrag qualitativ); keine unbelegten Zahlen.

## 5. Blätter: Form & Auf-/Abdrehen ✅ (umgesetzt 10.7.2026)

1. **Echte Blattformen** nach Referenzfoto: Big-Blade = Beil (Schaftachse an gerader Oberkante, ~70 % Fläche einseitig, gerade Abschlusskante); Macon = Tulpe mit breit gerundeter Spitze, max. Breite bei ~60–70 %.
2. **Auf-/Abdrehen im Schlagzyklus:** Durchzug aufgedreht (Blattfläche senkrecht), nach Ausheben abgedreht (flach), vor Auslage wieder aufdrehen; Übergänge in Ausheben/Einfang.
3. **3D-projizierte Blattzeichnung** (`drawBlade` mit getrennten Längs-/Breitenachsen): kein Fake-Rotieren; aufgedreht bleibt in der Seitenansicht hochkant, verkürzt nur mit sin θ. Draufsicht gespiegelt korrekt (Beilfläche zur richtigen Seite). Querschnitt schlaggekoppelt.
4. **„Plattform" = Blattfläche in den Ansichten** — kein separates Detail-Inset. *(Entschieden 9.7.2026)*

## 6. Ruderer-Sektion, Zwei-Ruderer-Vergleich & Datenbank 🆕→✅ *(Grundausbau umgesetzt 10.7.2026)*

Ziel: aus dem Trimm-Rechner ein Mannschafts-Werkzeug machen — Körpermaße als eigene Sektion, zwei
Ruderer im Boot vergleichen, Profile verwalten. Bezug Handbuch 4.1/4.2 „zwei Ruderer / Mannschaften – ein Boot".

**Umgesetzt:** Ruderer-Profile als Datenobjekte (`mkRower`, `state.crew.s1/s2`), `solveBody`/`solveArms`/`SEG`
nehmen den Ruderer als Parameter. Eigene Sektion „Ruderer & Mannschaft" mit Vitruv-Figur (skaliert mit
Körpergröße/Segmenten), Sitz-Tabs (Schlagmann/Ruderer 2), Namensfeld, Ruderer-Slidern (Größe, Bein/Rumpf/Arm,
Schulterbreite, Gewicht, Fa). Zwei Ruderer im Tandem in Drauf- und Seitenansicht (Schlagmann weiß, Ruderer 2
blau, je eigenes Ruder, ox=−128 cm; 1x = ein Ruderer). Datenbank in localStorage + JSON-Export/Import,
Profil in Sitz laden, „◀ ▶"-Durchschalten von Ruderer 2. Seitenansicht auf volle Breite, Querschnitt zeigt
den bearbeiteten Ruderer. Vergleichsdiffs (Knie, Reichweite) in der Seiten-Infobox.

**Nachgezogen (10.7.):** Riemen-Zweier auf Gegenseiten mit BB/StB-Wahl für den Schlagmann (Frage 12 ✅);
Querschnitt zeigt den bearbeiteten Ruderer auf seiner Seite (Frage 10 ✅). **Platzweises Rigg (Frage 11 ✅,
erweitert):** ALLE Rigg-Größen (DA, IH, L, d, Handabstand, Dollenhöhe, Anlage, Außenneigung, Stemmbrett,
Rollbahn) gelten pro Platz — die vorhandenen Regler wirken auf den gewählten Sitz-Tab (keine Regler-Dopplung,
Wolfs Vorgabe). Bootsweit bleiben Schlagbogen (Handbuch 4.1: gleiche Ruderwinkel), Wasserlinie, Gewicht.
Personen-Profile (Datenbank) tragen Körper + Fa; Platz-Rigg bleibt beim Sitz. Presets setzen beide Plätze.
**Noch offen:** interaktives Ziehen der Vitruv-Segmente (aktuell Slider); Sitzabstand fein (Frage 9).

### 6E · Werkstatt-Modus & Boots-Datenbank ✅ *(12.7.2026, nach 1. Real-World-Test)*
1. **Messkontext-Umschalter „Werkstatt (Böcke)" / „Wasser (Steg)"**, Werkstatt = Start-Standard.
   Am Bock existiert keine Wasserlinie → Haupt-Ampel dort: **Dollenhöhe über Rollsitz** (Handbuch-Maß a,
   Norm 15/17 ±2); „über Wasser" (22–26) nur noch als berechneter Info-Chip bzw. im Wasser-Modus.
2. **Referenz umschaltbar:** Rollsitz-Tiefpunkt (Latte-über-Dollborde-Methode, Handbuch) ↔
   Schienenoberkante (Vereins-Messgerät mit Tastfinger), verbunden über Offset „Sitz-Tiefpunkt über
   Schiene" (Default 5 cm, einstellbar).
3. **BB/StB-Vergleich** (Hauptzweck des Messgeräts): Skull = Δ-Regler pro Platz (Ziel +0,5–1 cm BB höher);
   Riemen = Ampel-Chip über die Dollenhöhen der beiden Plätze (Ziel 0).
4. **Ansichten im Werkstatt-Modus:** Boot auf Böcken, kein Wasser, Kraftpfeil aus, Dollenhöhen-Bemaßung
   ab gewählter Referenz; Hinweis „Bewegung simuliert".
5. **Boots-Datenbank** (Wolfs Nachforderung): benannte Boote mit ALLEN Einstellungen (Rigg beider Plätze,
   Bootsklasse, Blatt, Seite, Schlagbogen, c, Sitz-Offset) — lokal + JSON-Export/Import; Körper/Fa bleiben
   bei den Personen. Damit: Boot einmal erfassen, am Bock aufrufen, nachmessen.
6. Später: Messlatten-Assistent (zwei Zollstockmaße → a).

### 6A · Eigene Ruderer-Sektion mit Vitruv-Editor *(Da-Vinci-Bild = interaktiver Editor)*
1. Ruderer-Eingaben (Körpergröße, Bein-, Rumpf-, Armlänge, Schulterbreite, Handabstand, Gewicht) wandern aus dem allgemeinen Slider-Block in eine **eigene Sektion/Panel**.
2. Herzstück: **interaktive vitruvianische Figur** (Mensch in Kreis + Quadrat).
   - Körpergröße skaliert Quadrat (Seite ≈ Körperhöhe/Spannweite) und Kreis (um den Nabel) — Da-Vinci-Proportionen.
   - Segmente per **Ziehen oder Regler** einstellbar (Ober-/Unterschenkel, Rumpf, Ober-/Unterarm, Kopf); Standard-Anthropometrie als Startpunkt, Feinjustage Bein/Rumpf(/Arm).
   - Werte speisen **direkt** `solveBody`/`solveArms` und damit alle Boot-Ansichten.
3. Dezenter Plausibilitäts-Hinweis, wenn Segmentproportionen unüblich sind (optional).

### 6B · Zwei Ruderer im Boot — Tandem, natürliche Position *(Entschieden 10.7.2026)*
1. In **allen Booten außer 1x** werden **zwei Ruderer hintereinander** in natürlicher Sitzposition gezeigt (Schlagmann + zweiter Sitz) — „man sieht immer einen Zweier". **1x = nur ein Ruderer.**
2. Beide **synchron im selben Schlag-Timing** (Mannschaft im Gleichtakt), **gemeinsame Boot-Rigg-Einstellung**; Unterschied liegt in den **Körpermaßen** → sichtbar, wie unterschiedliche Körper zur selben Anlage passen.
3. **Seitenansicht = Leitansicht** (zwei Körper hintereinander entlang der Bootslängsachse, Sitzabstand realistisch). Draufsicht zeigt beide Sitze (Riemen-Zweier: Schlag/Bug auf Gegenseiten). Querschnitt: Referenz- oder aktiver Ruderer *(offen, 9.2)*.

### 6C · Platz 1 fix, Ruderer 2 durchschalten *(= „Position weiterschalten", entschieden 10.7.2026)*
1. **Platz 1 = Schlagmann**: einmal aus der Datenbank definiert, bleibt als **Referenz** stehen.
2. **Ruderer 2**: per Vor-/Zurück durch die Datenbank-Profile **weiterschalten** → jeder Kandidat direkt gegen den Schlagmann.
3. **Differenz-Anzeige** Ruderer 2 vs. Schlagmann: Reichweite, Auslage-Position, Kniewinkel, Sitzweg, Griffhöhe …
4. Ampel bewertet, ob Ruderer 2 mit der Schlagmann-Rigg zurechtkommt.
5. *(Der alternative Schlagphasen-Stepper wurde NICHT gewählt; Phasen bleiben wie bisher klickbar.)*

### 6D · Ruderer-Datenbank (lokal + Datei-Export) *(Entschieden 10.7.2026)*
1. Benannte **Profile**: Name, Körpergröße, Bein-/Rumpf-/Armlänge (bzw. Feinjustage), Schulterbreite, Gewicht, Notiz.
2. **Speichern/Laden im Browser** (localStorage); Liste verwalten (anlegen, bearbeiten, löschen).
3. **Export/Import als JSON-Datei** zum Teilen zwischen Trainer-Geräten.
4. Profil einem Slot zuweisen: **Platz 1 (Schlagmann)** / **Ruderer 2**.
5. **Keine echten Personendaten ins veröffentlichte Repo** — Profile bleiben lokal beim Nutzer (Datenschutz).

## 7. Veröffentlichung

1. **PWA:** Web-App-Manifest (Name, Icon, Vollbild), Service Worker mit Komplett-Cache → offline nach Erstbesuch; Home-Bildschirm-Installation auf iPad/Android/Desktop.
2. **Hosting:** öffentliches GitHub-Repo + GitHub Pages (kostenlos, HTTPS); Weitergabe per Link/QR-Code.
3. **Privat bleibt:** Tailscale-/LAN-Server auf dem Mac mini als Entwicklungs-Spiegel (Port 8943).
4. Keine personenbezogenen Daten in Repo/App; Quellenangabe DRV-Trimmhandbuch im Footer.

## 8. Nicht-Ziele / bewusste Entscheidungen

- **Keine native App / kein Java:** Browser ist die Plattform; HTML-Datei bleibt einzige Quelle. Capacitor-Wrapper (App Store) nur bei späterem Bedarf, baut auf derselben HTML auf.
- Übergriff & Dollenhöhe ü. W. bleiben abgeleitete Größen (physikalische Konsistenz).
- Keine Mehrsprachigkeit vorerst (deutsch).
- Keine Simulation von Bootsdynamik/Hydrodynamik — Geometrie- und Technik-Visualisierung.

## 9. Offene Fragen ❓

**Erledigt:**
1. ~~„Plattform"~~ → Blattfläche in den Ansichten, kein Detail-Inset (5.4).
2. ~~Handabstand Riemen~~ → Slider 14–22 cm, Default 18 cm (4.7).
3. ~~Körpergröße~~ → Körpergröße + Bein-/Rumpf-Feinjustage (4.6).
4. ~~Vitruv-Bild~~ → interaktiver Körper-Editor (6A).
5. ~~2-Ruderer-Darstellung~~ → Tandem im Boot, natürliche Position, immer „Zweier" außer 1x (6B).
6. ~~Datenbank~~ → lokal + Datei-Export (6D).
7. ~~„Position weiterschalten"~~ → Ruderer 2 durchschalten, Schlagmann fix (6C).

**Noch offen (für Abschnitt 6):**
8. **Reihenfolge:** Aktuellen Stand als **v1.0 zuerst veröffentlichen** (Abschnitt 7), dann Abschnitt 6 als v1.1 — oder Abschnitt 6 erst bauen und **gebündelt veröffentlichen**?
9. **Sitzabstand** der zwei Ruderer im Tandem: fester realistischer Wert (~1,2–1,4 m Riggerabstand) oder einstellbar?
10. **Querschnitt bei zwei Ruderern:** Schlagmann (Referenz) zeigen, aktiven Ruderer 2, oder beide überlagert?
11. **Abweichende Ruder für Ruderer 2?** Handbuch 4.1: bei großen Unterschieden kürzere Ruder/kleinerer Hebel für den Schwächeren. Zunächst identische Boot-Rigg wie Schlagmann, oder pro Ruderer Ruderlänge/IH variierbar?
12. **Riemen-Zweier-Anordnung** in der Draufsicht: Schlag Backbord, Bug Steuerbord (o. umgekehrt) — Standard festlegen/umschaltbar?
13. Nice-to-have: Trimmprotokoll (Tabelle 3 des Handbuchs) als ausfüllbares Formular mit Export.
