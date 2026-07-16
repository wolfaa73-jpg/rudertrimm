# Rudertrimm V2 – UX-, Responsive- und Accessibility-Abnahme

Releasebezug: **Rudertrimm V2 · 0.9.0-beta.1 · Build 2026-07-16 · shell-1f28bf1a5d5a322a**  
Shell-Revision: `sha256-1f28bf1a5d5a322a26dd19b5efdc3aff0addd97bdc29e48d0f5629732cbb0d96`.

Stand: 16. Juli 2026  
Geltungsbereich: `rudertrimm-v2/index.html` mit `css/base.css` und nachgeschaltetem `css/v2.css`

**Status:** Verbindliche Abnahmespezifikation, nicht pauschal bestanden. Statische
Security-/Semantiktests, gemessene CSS-Kontraste und V1-Inhaltsparität sind im eingefrorenen
Stand automatisiert beziehungsweise quellbasiert belegt. Der echte V2-Vorher-Screenshot wurde
ausgewertet. Der reparierte Doppelklickvertrag ist automatisiert abgesichert; seine reale
Post-Fix-Sichtprüfung in Safari/Firefox/Chromium bleibt offen. Ebenso bleiben der
frische reale Sichtprüfung der gemeldeten Körper-/Schulterbewegung, der
Post-Patch-Browserlauf bei 390/1440/1600 px, VoiceOver/NVDA, reale Geräte, 200/400-%-Zoom,
installierte Offline-PWA und Store-Assets manuelle Release-Gates.

## 1. Verbindlicher Integrationsvertrag

`v2.css` muss **nach** `base.css` geladen werden:

```html
<link rel="stylesheet" href="css/base.css">
<link rel="stylesheet" href="css/v2.css">
```

Das Stylesheet behebt technische Darstellungsprobleme, kann aber keine Semantik erzeugen. Der zentrale HTML-/JavaScript-Pass muss zusätzlich:

1. alle Inputs, Selects und Slider mit echten Labels verbinden;
2. Toggle-Zustände über `aria-pressed` beziehungsweise `aria-selected` exponieren;
3. Phasen und Falt-Überschriften als echte Buttons ausgeben;
4. dem aktiven Platz, Statusmeldungen und Visualisierungen zugängliche Namen geben;
5. den inaktiven Stepper mit `hidden` statt nur `visibility:hidden` entfernen;
6. die `requestAnimationFrame`-Animation bei `prefers-reduced-motion: reduce` standardmäßig nicht starten;
7. Datenbankaktionen ohne Auswahl deaktivieren und Löschung/Überschreiben absichern.
8. unter `file://` die Kern-App über das externe Classic-Bundle starten, Service Worker
   überspringen und Direktstart/Speicherfallback sichtbar benennen;
9. unter HTTP/HTTPS den Service Worker unabhängig vom Zeitpunkt des `load`-Events genau einmal
   registrieren.
10. Slider und Zahleneingaben als zwei synchronisierte Ansichten desselben Fachwerts führen;
    ungültige Entwürfe dürfen weder Berechnung noch Dirty-State verändern;
11. Personen und Boote in Details getrennt auffindbar halten; Quick-Edit-Dialoge müssen
    Escape, Fokuswiederherstellung und stale Sitz-/Revisionsguards besitzen;
12. die fünfstufige Einsteigerführung nur aus vorhandenem Zustand ableiten, manuelles
    Schließen respektieren und Ergebnisprüfung erst nach einer Nutzeraktion abschließen;
13. Ergebnisaktionen bei unverändertem Befund nicht pro Animationsframe ersetzen;
14. JavaScript-Feldsprünge bei `prefers-reduced-motion` ohne weiches Scrollen ausführen.

Optionale, bereits gestylte Hooks:

- `.v2-context`: sticky Kontextleiste für Boot, Modus, aktiven Platz, Speicher- und Offlinestatus;
- `.v2-actions`: sticky mobile Primäraktionen;
- `.v2-grid`: responsive Auto-fit-Gruppe ohne feste min-content-Tracks;
- `.v2-grid--compact`, `.v2-grid--wide`, `.v2-grid--split`: Gridvarianten;
- `.v2-span-all`: Element über alle Gridspalten;
- `.v2-responsive-panel`: begrenzt beliebige neue Panels auf die Containerbreite;
- `.v2-motion-only`: optionale Bewegung, die bei reduzierter Bewegung ausgeblendet wird.

## 2. Release Gate

Eine Version ist nur freigabefähig, wenn:

- alle P0-Tests bestanden sind;
- kein automatisierter Accessibility-Test einen `critical`- oder `serious`-Treffer enthält;
- bei 320 CSS-Pixeln und bei 400 % Zoom kein Informations- oder Funktionsverlust auftritt;
- der vollständige Kernworkflow mit Tastatur sowie mindestens VoiceOver/Safari und NVDA/Chrome funktioniert;
- Speichern, Laden, Import, Überschreiben und Löschen keinen unbestätigten Datenverlust verursachen;
- ein vollständiger Online-Erstbesuch anschließend einen Offline-Neustart ermöglicht.

P1-Abweichungen benötigen einen dokumentierten Owner, ein Zieldatum und eine begründete Freigabeentscheidung. P2 ist Feinschliff.

## 3. Viewport- und Breakpoint-Matrix

Alle Prüfungen erfolgen mindestens in Chrome und Safari; die 320-/390-Tests zusätzlich auf einem realen oder emulierten iOS- und Android-Gerät.

| Prio | Breite / Referenzgerät | Erwartete Darstellung | Abnahmekriterium |
|---|---|---|---|
| P0 | 320 × 568 | Telefon, zwei Phasenspalten, einspaltige Ruderer-Regler, zweispaltige Statuskarten | Kein horizontaler Seiten-Scroll, kein Clip, kein Overlay; Namen mit 30 Zeichen umbrechen; Touchziele ≥44 × 44 px |
| P0 | 390 × 844 | Telefon, zwei Phasenspalten, sticky Kontext/Aktionen nach Integration | Seiteninfo liegt im Dokumentfluss; Formfelder ≥16 px; Safe Areas bleiben frei |
| P1 | 768 × 1024 | Tablet hoch, eine Appspalte, drei Phasenspalten | Kein unnötiger horizontaler Scroll; Kontext und Ergebnisse während der Messung erreichbar |
| P0 | 1024 × 768 | Tablet quer, 300-px-Steuerbereich plus flexibler Hauptbereich | Kein Überlauf im circa 688 px breiten Main; Ruderergrid und Visualisierungen bleiben vollständig sichtbar |
| P1 | 1440 × 900 | Desktop, volle Zweispaltenansicht | Keine überbreiten Tracks; Fokus, Kontext und Ergebnis bleiben beim Scrollen verständlich |
| P1 | 1600 × 900 | großer Desktop, vollständige V1-Visualfolge | Alle Statuskarten und drei Ansichten besitzen positive Abmessungen; keine leere Adminfläche |

### Exakte Grenztests

Jede Breite wird einzeln geladen und nicht nur durch Ziehen des Fensters erreicht:

| Breiten | Erwarteter Wechsel |
|---|---|
| 559 / 560 / 561 px | `#rowerControls` wechselt nach 560 px von einer auf zwei Spalten; Phasen wechseln von zwei auf drei Spalten |
| 819 / 820 / 821 px | Seiteninfo bleibt im Dokumentfluss; Ruderergrid, Phasenraster und Abstände wechseln auf die breitere Darstellung |
| 999 / 1000 / 1001 px | App wechselt nach 1000 px von einer auf zwei Hauptspalten; kein Sprung darf Inhalt verdecken oder Fokus verlieren |

Zusätzlich testen: 360, 412, 600, 834, 1280, 1600 px sowie Hoch-/Querformatwechsel ohne Reload.

## 4. Automatisierte Abnahme

### 4.1 CSS- und Dokumentqualität

- CSS-Parser beziehungsweise Stylelint: null Syntaxfehler.
- HTML-Validator: null neue strukturelle Fehler nach der Integration.
- Keine feste Inhaltsbreite darf `document.documentElement.scrollWidth` über `clientWidth` vergrößern.
- Ein Testelement mit 470 px intrinsischer Breite innerhalb von `.v2-grid` und `.v2-responsive-panel` muss bei 320/390 px vollständig reflowen; es darf weder Seite, SVG-Host noch Phasenraster verbreitern oder abgeschnitten werden.
- Screenshot-Diffs für alle Viewports und Grenzbreiten; Änderungsschwelle bewusst reviewen, nicht blind aktualisieren.

Empfohlene Assertions pro Viewport:

```js
expect(await page.evaluate(() =>
  document.documentElement.scrollWidth <=
  document.documentElement.clientWidth + 1
)).toBe(true);

const clipped = await page.locator(
  '.layout, main, aside, .card, .rowergrid, #rowerControls, .phases, .phase, #vTop, #vSide, #vCross'
).evaluateAll(nodes => nodes.filter(node => {
  const rect = node.getBoundingClientRect();
  return rect.left < -1 || rect.right > window.innerWidth + 1;
}).map(node => node.id || node.className));
expect(clipped).toEqual([]);
```

SVGs müssen zusätzlich eine positive Breite/Höhe besitzen und vollständig im jeweiligen Host liegen.

### 4.2 Automatisierte Accessibility-Prüfung

Mit axe-core oder gleichwertig auf Initialzustand und mindestens diesen Zuständen prüfen:

1. 1x / Skull / Werkstatt;
2. Mehrpersonenboot mit realen Bug-/Schlagplätzen, freien Plätzen und aktivem Platz N;
3. Riemen / Wasser / Steuerbord;
4. geöffnete und geschlossene Karten;
5. laufende und gestoppte Animation;
6. importierte Boots- und Rudererdatenbank;
7. Fehler-, Erfolg-, Offline- und Updatehinweis.

Gate: null `critical`, null `serious`; `moderate` nur mit dokumentierter Bewertung.

### 4.3 Kontrast

Automatisiert und stichprobenartig manuell messen:

- normaler Text mindestens 4,5:1;
- großer Text mindestens 3:1;
- aktive UI-Grenzen, Fokusindikator und wesentliche Icons mindestens 3:1;
- geprüft werden Default, Hover, Fokus, Aktiv, Deaktiviert, Warnung und Fehler.

Die in `v2.css` gesetzten Tokens sind Teil der Abnahme und dürfen nicht ungeprüft überschrieben werden.
Der statische Regressionstest misst aktuell mindestens 4,5:1 für kleine Sekundär-/Hilfstexte
und Disabled-Labels sowie mindestens 3:1 für aktive Control-Grenzen.

### 4.4 V1-Inhaltsparität

Vor jedem Freeze müssen mindestens vorhanden und auffindbar bleiben:

- sieben Statuskarten und ergänzende Mess-/Statuschips,
- Körpermaßgrafik,
- Draufsicht mit Boot, Dollen, Rudern, Bögen, Griff-/Zugbereich und Winkelbezug,
- Seitenansicht mit Rollbahn, Stemmbrett, Körper-/Arm-/Beinmodell und Maßbezügen,
- Querschnitt mit Höhenreferenz, Dollen, Rudern und Ruderer,
- sechs Phasen, direkte Phasenwahl, Start/Stop und Tempo.

Ein eigener V2-Falt-Key verhindert, dass alte V1-Präferenzen den ersten V2-Demostart leer
erscheinen lassen. Geschlossene Bereiche dürfen weiterhin bewusst gespeichert werden.

## 5. Manuelle Responsive-Abnahme

Für jede Matrixbreite:

1. Bootsklasse, Blatttyp, Rigg und Messkontext ändern.
2. Boot mit mindestens 30 Zeichen langem Namen anlegen.
3. Nicht-Einer wählen, reale Plätze Bug bis Schlag prüfen und alle Zuordnungen bedienen.
4. Rudererprofil mit langem Namen laden, BMI und Stepper prüfen.
5. Jede Phase wählen, Animation starten/stoppen und Tempo ändern.
6. Alle vier Karten ein-/ausklappen.
7. Seiteninfo, Tabellenwerte, Chips und Statuskarten auf Überlagerung prüfen.
8. Boot und Profile speichern, laden, exportieren, importieren und löschen.
9. Bildschirmtastatur öffnen; fokussiertes Feld und Kontext dürfen nicht verdeckt sein.
10. Hoch-/Querformat wechseln; Zustand und Fokus bleiben erhalten.

Pass bedeutet:

- keine abgeschnittenen Texte oder Controls;
- keine Überlagerung von Überschrift, Seiteninfo und SVG;
- kein horizontaler Seiten-Scroll;
- keine Aktion liegt unter Safe Area oder sticky Aktionsleiste;
- der aktive Platz ist bei jeder platzbezogenen Eingabe und Bewertung sichtbar;
- Touchziele primärer Aktionen sind mindestens 44 × 44 CSS-Pixel groß.

## 6. Tastaturabnahme

Test ohne Maus oder Touch:

1. Mit Tab und Shift+Tab sind alle Funktionen in sinnvoller visueller Reihenfolge erreichbar.
2. Fokus ist jederzeit deutlich sichtbar und wird nicht von sticky Elementen verdeckt.
3. Phasen, Faltkarten und Toggle-Gruppen reagieren auf Enter/Leertaste; Radiogruppen/Tabs zusätzlich auf erwartete Pfeiltasten.
4. Nach Sitzwechsel, Rendern, Speichern, Löschen, Falten und Phasenwechsel bleibt Fokus am ausgelösten oder logisch folgenden Element.
5. Escape schließt Dialoge, ohne eine destruktive Aktion auszulösen.
6. Beim Start/Stop der Animation entsteht keine Fokusverschiebung.
7. Es existiert ein direkter Sprung von Einstellungen zu Ergebnis und zurück.

Gate: 100 % der Funktionen sind ohne Zeigegerät erreichbar. Bezug: WCAG 2.1.1, 2.4.3 und 2.4.7/2.4.11.

## 7. Screenreader-Abnahme

Mindestens:

- VoiceOver mit Safari auf iOS oder macOS;
- NVDA mit Chrome oder Firefox auf Windows.

Prüfpunkte:

1. Seite, Hauptbereich, Einstellungen und Kontext besitzen verständliche Landmark-Namen.
2. Jedes Formfeld wird mit Name, aktuellem Wert, Einheit und relevantem Hinweis angesagt.
3. Skull/Riemen, Werkstatt/Wasser, Referenz, Seite und Sitz melden ihren Zustand.
4. Aktiver Platz und bewerteter Ruderer werden vor den Statuskarten angesagt.
5. Statuskarten und Chips vermitteln Zielkorridor/Warnung/Außerhalb ohne Farbe.
6. Speichern, Laden, Import, Fehler, Offline und Update werden genau einmal als Status gemeldet.
7. Tabellen besitzen Caption, Zeilenüberschriften und sinnvolle Lesereihenfolge.
8. Jede Visualisierung besitzt Namen, Beschreibung und eine gleichwertige HTML-Zusammenfassung.
9. Die laufende Animation erzeugt kein permanentes Live-Region-Dauerfeuer.

Gate: Keine unbenannten Controls, keine unbekannten Zustände und keine Kerninformation ausschließlich im SVG.

## 8. Zoom-, Text- und Kontrastabnahme

### Browserzoom

- Desktop bei 200 % und 400 % prüfen.
- Bei 400 % mit äquivalenter 320-CSS-Pixel-Breite gelten dieselben Reflow-Kriterien wie im Telefon-Test.
- Browserzoom darf weder Fokus noch aktuelle Eingabe verlieren.

### Textvergrößerung

- Nur Text auf 200 % vergrößern.
- Labels, Werte, Einheiten und Hinweise dürfen sich nicht überdecken oder abgeschnitten werden.
- Buttons dürfen mehrzeilig werden; ihre zugänglichen Namen bleiben vollständig.

### Systemeinstellungen

- `prefers-reduced-motion: reduce`: keine Autobewegung; laufender Durchzug stoppt und der
  Motion-Start wird ausgeblendet, die sechs manuellen Phasen bleiben vollständig bedienbar.
- Forced Colors/Windows High Contrast: Auswahl, Fokus, Status und Grenzen bleiben erkennbar.
- iOS „Größerer Text“ und Android Schriftgröße testen.

## 9. Daten- und Fehlbedienungsabnahme

P0-Testfälle:

1. Leere Boots-/Rudererauswahl plus Laden, Update oder Löschen verändert niemals Datensatz 1.
2. Update/Delete ist ohne explizite Auswahl deaktiviert.
3. Löschen nennt den Datensatz und bietet Bestätigung oder Undo.
4. Preset-, Rigg- oder Blattwechsel zeigt vorab alle überschriebenen Werte.
5. Globaler Arbeitsstand enthält keine versteckte Kopie kompletter Datenbanken.
6. Nach Laden sind Zustand, Select-Optionen und LocalStorage identisch.
7. Doppelte Namen werden verhindert oder eindeutig dargestellt.
8. Import zeigt Vorschau, ungültige Einträge und Konfliktstrategie.
9. Export benennt seinen Umfang: Messbericht, Boots- oder Rudererdatenbank.
10. Ein Reload während ungespeicherter Arbeit führt zu Warnung oder automatischer Entwurfswiederherstellung.

## 10. PWA- und Offline-Abnahme

1. App einmal vollständig online öffnen und auf aktivierten Service Worker warten.
2. App schließen, Netzwerk deaktivieren und aus Browser sowie installiertem Icon neu starten.
3. Alle Berechnungen, Ansichten, lokale Datensätze und JSON-Exporte müssen funktionieren.
4. Kein fehlgeschlagenes HTTP-Ergebnis darf als gültiger Offline-Stand gespeichert werden.
5. Bei verfügbarer neuer Version erscheint ein verständlicher Hinweis; Aktivierung erfolgt kontrolliert und konsistent.
6. Offline-/Onlinezustand und „offline bereit“ sind sichtbar, aber nicht störend.
7. Vor Store-/Installationsfreigabe ein gestalterisch freigegebenes Maskable Icon erstellen,
   deklarieren und auf kreisförmiger sowie abgerundeter Systemmaske prüfen. V2 deklariert
   derzeit bewusst kein Maskable Icon.
8. iOS Safe Areas und Android/Chrome Standalone-Modus in Hoch-/Querformat prüfen.

## 11. Druckabnahme

In A4 Hoch- und Querformat:

- Einstellungs- und Datenbankbedienung ist ausgeblendet;
- Kontext, Statuskarten und Visualisierungen werden gedruckt;
- gefaltete Karten sind im Ausdruck geöffnet;
- keine wichtige Karte wird über einen Seitenumbruch zerrissen;
- Text ist auf weißem Hintergrund lesbar;
- SVGs passen vollständig in die Druckbreite.

## 12. Deterministischer synthetischer End-to-End-Fall

Dieser Fall beginnt ausschließlich über die sichtbaren Aktionen **Testiel · Demo laden** oder
**Vergleichsdemo laden**. Es gibt keinen direkten Storage-Seed. Beide Demos respektieren den
Dirty-Guard, persistieren nicht automatisch und starten keine Animation.

| Entität / Wert | Referenz |
|---|---|
| Profilname | `Testiel` (synthetisch) |
| Boot / Rigg / Blatt | 1x / Skull / Big-Blade |
| Kontext / Höhenreferenz | Werkstatt (Böcke) / Rollsitz |
| Körpermaße | 185 cm gesamt; Beine 90 cm; Rumpf 95 cm; Spannweite 188 cm; Schulter 40 cm; Gewicht 80 kg |
| Vergleich | `Testiel 2`, 4x, zwei Profile bei vier Bootsplätzen |

Journey: Demo laden, Profil/Boot/Arbeitsstand bei Bedarf bewusst speichern und wieder laden;
mindestens zwei vollständige
Sechs-Phasen-Zyklen mit Drauf-, Seiten-, Quersicht, Phasenkarte, Phaseleiste und Durchzug
beobachten; stoppen und ein bis zwei Regler kontrolliert ändern; Desktop und 390 px ohne
verdeckte Hauptaktion oder horizontalen Layoutbruch prüfen; Export/Import nur über die echte UI
und nur bei belastbarem Dateidialog; abschließend Konsole und automatisierte Regressionen.

Aktueller Status: **teilweise belegt**. Der Nutzer bestätigte im realen Browser Appstart,
Kompakt/Details, alle drei Ansichten, die 4x-Vergleichsdemo und die nach Reparatur wieder
laufende Animation. Ein protokollierter kompletter Post-Freeze-Lauf über zwei Zyklen,
390 px, Tastatur, Konsole und echte Dateidialoge bleibt offen.

### 12.1 Natural-Catch-/Ziel-Ist-Abnahme

- Rigg-Ziel und modellierte Ist-Auslage sind gleichzeitig verständlich, aber nicht als zwei
  gleichartige Trainerempfehlungen dargestellt.
- Fa-Änderung reagiert in KPI und Geometrie; reine Änderung des Rigg-Ziels verändert den
  Natural-Catch-Istwert nicht.
- Ohne Natural-Catch-Nullstelle oder 3D-Reichweite steht in Karte, Kompaktzeile und Draufsicht
  „nicht bestimmbar“/„Prüfpose“; der Messbericht enthält keinen numerischen Ist-Wert.
- Skull 32,5 cm und Riemen 50 cm gelten nur für bewusst neue/Preset-Arbeitsstände; ein geladener
  Altbestand behält seinen expliziten Fa-Wert.
- Über sechs Phasen und mehrere Zyklen bleiben Körper, Sitz, Arme, Ruder, Bounds und Panelhöhe
  stetig; 58°/16° bleibt als unkalibriertes Prüfmodell sichtbar.

### 12.2 History-, Lösch- und eFa-Abnahme

- **History in Details:** per Tastatur erreichbar; Entität und Revision sind eindeutig,
  Alt/Neu nennt physische Sitze über stabile ID/Platz und ein Retention-Floor wird als
  begrenzte Aufbewahrung angekündigt. Auswahl verändert keine Arbeitsdaten.
- **Passive Profillöschung:** nur bei ausgewähltem gespeicherten Profil verfügbar;
  aktuelle/gespeicherte Bootsreferenzen blockieren, Bestätigung liegt außerhalb Locks und
  Fokus kehrt logisch zurück.
- **eFa-Staging:** Datei, Trenner und Mapping explizit wählen → Vorschau → atomarer Commit
  als sichtbar unvollständige Kandidaten → lokales Löschen. Kein Kandidat erscheint als
  vollständige Person/Boot, wird automatisch zugeordnet oder berechnet.
- **Live-Migration:** trifft zwischenzeitlich Storage v2 ein, müssen Migration und
  angeforderte Mutation in einem kohärenten Commit enden; kein Pending-Migration-Dead-End.
- Manuell offen bleiben echter Desktop-/390-Dateidialog, Tastatur/Screenreader, realer
  eFa-Originalexport, Multitab/Fallback/Quota und installierte PWA. Automatisierte Tests sind
  kein Ersatz für diese Browser-/Geräteabnahme.

## 13. Abnahmeprotokoll

Automatisierter Stand: **13/13 JavaScript-Parseprüfungen**, **1/1 deterministische
Bundle-Stalenessprüfung**, **235/235 Node**, **3/3 Python**. Diese Zahlen sind kein Ersatz für
die oben ausdrücklich offenen Browser-, Motion-, Geräte-, Tastatur- und Screenreadergates.

Für jeden Testlauf dokumentieren:

| Feld | Inhalt |
|---|---|
| Build/Commit | eindeutige Version |
| Datum / Tester | Name und Datum |
| Browser / OS / Gerät | inklusive Version und Eingabemethode |
| Viewport / Zoom | CSS-Pixel, Zoom, Hoch-/Querformat |
| Test-ID | Abschnitt und laufende Nummer |
| Ergebnis | Pass / Fail / Blocked |
| Evidenz | Screenshot, Video, Accessibility-Tree oder Konsolenlog |
| Befund | erwartetes und tatsächliches Verhalten |
| Priorität / Owner | P0/P1/P2 und Verantwortlicher |

Ein Befund gilt erst als geschlossen, wenn der ursprüngliche Repro und alle betroffenen Grenzbreiten erneut bestanden wurden.
