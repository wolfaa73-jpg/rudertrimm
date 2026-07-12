# Plausibilitätsprüfung: App vs. FISA-Rigging-Survey WM 2017 (Sarasota)

**Quelle:** `2017RiggingSurveyJune272018_Neutral.xlsx` (FISA/World Rowing, veröffentlicht via r/Rowing),
sitzgenaue Vermessung der Boote bei der Ruder-WM 2017. **Auswertung:** Median / P10–P90 je Bootsklasse,
nur plausible Wertebereiche (Ausreißer/Leerzellen gefiltert). Stand: 10.7.2026.

## 1. Hebelmaße — unsere Nolte-Presets vs. Weltklasse-Realität

| Klasse | App-Preset DA / IH / L | WM-2017-Median DA / IH / L | Abweichung |
|---|---|---|---|
| 1x (M) | 159 / 88 / 288 | 160,0 / 88,5 / 288,5 | ≤ 1 cm ✅ |
| 2x (M) | 159 / 88 / 288 | 159,0 / 88,5 / 289,0 | ≤ 1 cm ✅ |
| 4x (M) | 158 / 87 / 289 | 159,0 / 88,0 / 289,5 | ~1 cm ✅ |
| 2- (M) | 85 / 115 / 374 | 86,0 / 116,0 / 375,5 | ~1–1,5 cm ✅ |
| 4- (M) | 84 / 114 / 375 | 85,0 / 115,0 / 376,0 | ~1 cm ✅ |
| 8+ (M) | 83 / 113,5 / 375 | 83,5 / 113,8 / 377,0 | ≤ 2 cm ✅ |

**Fazit:** Die Nolte-/Lingelsheim-Tabellen aus dem DRV-Handbuch treffen die Weltspitze 2017 auf
±1–2 cm. Frauenboote fahren ~2–4 cm kürzere Ruder bei ähnlichem Innenhebel (z. B. W8+ L 373 statt 377).

## 2. Kreuz-Validierung des Übergriffs (Ü)

Aus den Survey-Medianen berechnet (mit d = 2 cm):

| Klasse | Ü aus Survey | DRV-Ampelband | |
|---|---|---|---|
| M1x | 2·(88,5+2) − 160 = **21,0 cm** | 18–23 | ✅ Mitte |
| W1x | 2·(88+2) − 159,6 = **20,4 cm** | 18–23 | ✅ |
| M8+ | 113,8+2 − 83,5 = **32,3 cm** | 30–34 | ✅ Mitte |
| W8+ | 114+2 − 84 = **32,0 cm** | 30–34 | ✅ |

Die DRV-Übergriffsbänder decken die Weltklasse exakt ab — starke Bestätigung der Ampel-Logik.

## 3. Weitere Prüfgrößen

| Größe | WM 2017 | App | Bewertung |
|---|---|---|---|
| Pitch/Anlage | Median 4,0–5,0°, P10–P90 ≈ 3–6° | Norm 4°, grün 3–5° | ✅ bestätigt |
| Stemmbrettwinkel | Median 42°, P10–P90 40–44° | Default war 44° | 🔧 **Default → 42°** (bleibt im DRV-Band 45° −3) |
| Sitz über Ferse | 15–19 cm (M8+ 18,8 · W1x 15) | fix 18 cm (DRV-Norm) | ✅ plausibel; später evtl. Regler |
| Dollenhöhe über Sitz | 16–19,5 cm (Skull) | a-Regler 11–21, Default 15/17 | ✅ Bereich deckt ab. Unsere Ampel prüft Höhe **über Wasser** (22–26), Survey misst über Sitz — kein direkter Konflikt |
| Blattlänge Skull | 46 cm (nahezu einheitlich) | 46 cm | ✅ exakt |
| Blattlänge Riemen | 53,5 cm | war 55 cm | 🔧 **→ 54 cm** |
| Blattform | fast ausschließlich „SM2P" (Concept2 Smoothie2) | Big-Blade/Macon | ℹ️ Elite fährt Smoothie; unsere Big-Blade-Silhouette bleibt als Schema |

## 4. Nicht direkt abbildbar (Definitionsunterschiede)

- **„Distance Through Work"** (Median 13–17 cm): Rollsitz fährt im Einfang ~15 cm über die
  Arbeitslinie (Dollenebene) hinaus — passt qualitativ zu unserem Modell (Hüfte im Einfang nahe
  der Dollenebene), ist aber anders definiert als unser Fa.
- **„Line of Work – Toes"** (Median 32–40 cm): bezieht sich auf die **Zehen/Schuhspitze**, unser
  Fa auf die **Ferse** — ohne Kenntnis von Schuhlage/Brettwinkel-Definition nicht 1:1 umrechenbar.
  Fa bleibt daher unser (per Solver auf Knie ≈ 165° kalibrierter) eigener Parameter.

## 5. Umsetzung in der App (10.7.2026)

1. **Neue Preset-Gruppe „WM 2017 Survey (Elite)"** mit Median-Werten je Klasse, getrennt
   **Männer/Frauen** (1x, 2x, 4x, 2-, 4-, 8+) — die DRV/Nolte-Norm-Presets bleiben unverändert
   als eigene Gruppe erhalten.
2. Stemmbrettwinkel-Default 44° → **42°**.
3. Riemen-Blattlänge 55 → **54 cm**.
