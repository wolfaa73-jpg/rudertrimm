# Reproduzierbare Prüfung der World-Rowing-Rigging-Daten 2017

Stand: 15. Juli 2026.

## Quelle und Integrität

- Primärseite: [World Rowing – 2017 Rigging Survey](https://worldrowing.com/document/2017-rigging-survey/)
- Datei: `2017RiggingSurveyJune272018_Neutral.xlsx`
- erwarteter SHA-256:
  `e0d494d42fd5e0868a2bc64a388713083fec26c84a11173bc8c329a07659024d`

Die Original-Arbeitsmappe wird nicht mitverteilt. Das dependency-freie Skript
`scripts/analyze_world_rowing_2017.py` verweigert jede Datei mit anderem Hash und reproduziert
ausschließlich drei Kennzahlen je Tabellenblatt:

1. Dollenabstand/Span pro Datenzeile aus dem ersten plausiblen Wert in der festen Reihenfolge Spalte N, dann O (höchstens ein Wert je Zeile),
2. Innenhebel aus Spalte T,
3. Ruderlänge aus Spalte S.

Es berechnet dafür den Median und gibt zusätzlich das **metrikspezifische N** aus. `numericRows`
ist nur die Zahl der Zeilen mit mindestens einem numerischen Wert nach den zwei Kopfzeilen und
darf nicht als Stichprobengröße jeder einzelnen Kennzahl interpretiert werden.

```bash
python3 scripts/analyze_world_rowing_2017.py /pfad/zur/2017RiggingSurveyJune272018_Neutral.xlsx
```

Die erwarteten Werte stehen in `data/world-rowing-2017-summary.json`. Bei vollständiger
Übereinstimmung endet das Skript mit `VERIFIED`.

## Reproduzierte Mediane

Alle Längen in Zentimetern. `N` steht in der Reihenfolge Dollenabstand/Innenhebel/Ruderlänge.

| Klasse | Dollenabstand | Innenhebel | Ruderlänge | N |
|---|---:|---:|---:|---:|
| M1x | 160,0 | 88,5 | 288,5 | 38 / 39 / 39 |
| W1x | 160,0 | 88,0 | 286,5 | 18 / 20 / 20 |
| M2x | 159,0 | 88,5 | 289,0 | 38 / 38 / 38 |
| W2x | 159,3 | 87,5 | 287,5 | 24 / 24 / 24 |
| LM2x | 159,5 | 88,0 | 288,0 | 46 / 44 / 44 |
| LW2x | 159,0 | 87,5 | 286,0 | 32 / 32 / 32 |
| M4x | 159,0 | 88,0 | 289,5 | 60 / 60 / 60 |
| W4x | 159,0 | 88,0 | 288,0 | 36 / 36 / 36 |
| M2- | 86,0 | 116,0 | 375,5 | 36 / 36 / 36 |
| W2- | 86,4 | 116,25 | 373,0 | 20 / 22 / 22 |
| M4- | 85,0 | 115,0 | 376,0 | 60 / 56 / 56 |
| W4- | 85,0 | 115,25 | 373,0 | 48 / 48 / 48 |
| M8+ | 83,5 | 113,75 | 377,0 | 88 / 88 / 88 |
| W8+ | 84,0 | 114,0 | 373,0 | 56 / 64 / 65 |

Die Zeilen repräsentieren Messdatensätze beziehungsweise Sitzpositionen und nicht zwingend
statistisch unabhängige Boote. Die Werte sind Elite-Referenzmediane, keine Norm und keine
individuelle Trainingsempfehlung.

## Vergleich der V2-Grundpresets

| Klasse | V2-Grundpreset DA / IH / L | World-Rowing-Median DA / IH / L | größte Differenz |
|---|---|---|---:|
| 1x Männer | 159 / 88 / 288 | 160 / 88,5 / 288,5 | 1,0 |
| 2x Männer | 159 / 88 / 288 | 159 / 88,5 / 289 | 1,0 |
| 4x Männer | 158 / 87 / 289 | 159 / 88 / 289,5 | 1,0 |
| 2- Männer | 85 / 115 / 374 | 86 / 116 / 375,5 | 1,5 |
| 4- Männer | 84 / 114 / 375 | 85 / 115 / 376 | 1,0 |
| 8+ Männer | 83 / 113,5 / 375 | 83,5 / 113,75 / 377 | 2,0 |

Damit liegen diese Ausgangspresets bei den drei geprüften Längen nahe an den gemessenen
Elite-Medianen. Diese Aussage validiert weder Körperkinematik noch Ampelbänder, Rollbahn,
Stemmbrett, Dollenpitch, Blattmodell oder individuelle Eignung.

## Abgeleitete Übergriff-Beispiele

Die folgenden Werte sind **V2-Modellrechnungen**, keine direkt aus der Arbeitsmappe gelesenen
Kennzahlen. Mit dem in V2 angenommenen Stift-Klemmring-Abstand `d = 2 cm` gilt:

- Skull: `Übergriff = 2 × (IH + d) − DA`
- Riemen: `Übergriff = IH + d − DA`

| Klasse | Rechnung | Ergebnis |
|---|---|---:|
| M1x | 2 × (88,5 + 2) − 160 | 21,0 cm |
| W1x | 2 × (88 + 2) − 160 | 20,0 cm |
| M8+ | 113,75 + 2 − 83,5 | 32,25 cm |
| W8+ | 114 + 2 − 84 | 32,0 cm |

Das zeigt rechnerische Plausibilität der Formel für diese Beispiele. Eine Freigabe der
Zielkorridore verlangt weiterhin Quellenabgleich und reale Messreihen.

## Was dieses Reproduktionsskript nicht belegt

Die aktuelle mitgelieferte Auswertung berechnet **keine** P10/P90-Bereiche und wertet weder
Pitch, Stemmbrettwinkel, Sitzhöhe, Blattlänge, Blattform noch „Distance Through Work“ aus.
Frühere Arbeitsnotizen zu solchen Größen sind deshalb nicht Bestandteil dieses
reproduzierbaren V2-Nachweises.

Ebenfalls nicht aus den drei Medianen ableitbar sind:

- Genauigkeit des Körper- und Armmodells,
- der kombinierte Zielbereich aus Knie 160–170° und Rollweg 70–80 % bei 90°,
- individuelle Verletzungs- oder Trainingsrisiken,
- optimale Werte für ein konkretes Boot, eine konkrete Crew oder Wetterbedingungen.

Vor einer Kauf- oder Store-Version bleiben Trainerfreigabe, dokumentierte Messdefinitionen,
Golden-Datensätze und reale Vergleichsmessungen verbindliche Release-Gates.
