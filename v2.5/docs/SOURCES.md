# Fachquellen und Nachweisstatus

Releasebezug: **Rudertrimm V2 · 0.9.0-beta.1 · Build 2026-07-16 · shell-1f28bf1a5d5a322a**  
Shell-Revision: `sha256-1f28bf1a5d5a322a26dd19b5efdc3aff0addd97bdc29e48d0f5629732cbb0d96`.

Stand: 16. Juli 2026. Diese Liste trennt Primärdaten, allgemeine Ausbildungswerte und noch offene
Modellannahmen. „Quellengeprüft“ bedeutet nicht automatisch „sportwissenschaftlich validiert“.

## Primärdaten

- [World Rowing – 2017 Rigging Survey](https://worldrowing.com/document/2017-rigging-survey/)
- Offizielle Arbeitsmappe: `2017RiggingSurveyJune272018_Neutral.xlsx`
- Erwarteter SHA-256: `e0d494d42fd5e0868a2bc64a388713083fec26c84a11173bc8c329a07659024d`
- Reproduktionsskript: `scripts/analyze_world_rowing_2017.py`
- Abgeleitete, maschinenlesbare Ergebnisse: `data/world-rowing-2017-summary.json`

Damit sind die WM-Presets für Dollenabstand beziehungsweise Span, Innenhebel und
Ruderlänge unabhängig reproduziert. Die Messzeilen sind nicht zwingend unabhängige Boote; die
Ergebnisse sind Referenzmediane und keine vorgeschriebene Norm.

Die neuen Fa-Startwerte 32,5 cm (Skull) und 50 cm (Riemen) stammen aus Alex’ kontrolliert
portiertem Kinematikvorschlag, nicht aus der WM-2017-Tabelle. Sie werden deshalb als
unkalibrierte Modell-Defaults behandelt und nur bei bewusster Neu-/Presetwahl angewendet;
gespeicherte explizite Fa-Werte bleiben unverändert.

3x und 6x sind ausdrücklich gewünschte Vereins-/Skullklassen, nicht aus dem Survey abgeleitete
World-Rowing-Standardklassen. Bug = Platz 1 und Schlag = höchste Ruderplatznummer ist ein
Produktvertrag, keine aus der Preset-Arbeitsmappe abgeleitete Leistungsregel.

## Offizielle Ausbildungsunterlagen

- [World Rowing – Basic Rigging](https://worldrowing.com/wp-content/uploads/2020/12/Level2%EA%9E%89Chapter1%EA%9E%89BasicRigging_English.pdf)
- [World Rowing – Intermediate Rigging](https://worldrowing.com/wp-content/uploads/2020/12/Level3%EA%9E%89Chapter1%EA%9E%89IntermediateRigging_English.pdf)

Die Unterlagen stützen unter anderem typische Bereiche für Span/Spread, Innenhebel, Dollenhöhe,
Stemmbrettwinkel und Pitch. Definitionen müssen vor einer direkten Übernahme abgeglichen werden:
zum Beispiel Dollenhöhe über Sitz versus über Wasser sowie „Line of Work – Toes“ versus Fa ab Ferse.

## Status der V2-Regeln

| Teilmodell | Status | Konsequenz in der App |
|---|---|---|
| Übergriff und Hebelgeometrie | quellen- und formelgeprüft | reguläre Zielkorridore |
| Momentarmverhältnis | physikalisch korrigiert auf `outb / inb` | testbarer Kraftvergleich |
| WM-2017-Presets | gegen Primärdatei reproduziert | als Elite-Referenz gekennzeichnet |
| 90°-Stemmbrettprüfung | Anforderung dokumentiert, aktuelles Körpermodell widerspricht ihr | nur beide Kriterien gemeinsam; Standardfall ist nicht grün |
| Schulter–Hand-Winkel | Definition geklärt, Ziel/Toleranz noch nicht kalibriert | immer „Modellwert“, nie „optimal“ |
| Natural Catch aus Fa/Körper/Rigg | Alex-Modell mit 58° Knie und 16° Vorlage; rechnerisch/regressiv geprüft, real nicht kalibriert | Ist-Auslage getrennt vom Rigg-Ziel, nie grüne Trainerfreigabe |
| BB/StB-Höhendifferenz | Messwert vorhanden, Koppelung an die Kinematik fehlt | ausdrücklich als ungekoppelter Messwert markiert |
| Rollbahn-/Sitzreferenz | V2 hat eine vorläufige 5-cm-Referenzannahme | „Kalibrieren“-Hinweis statt Freigabe |
| Ergebnispriorisierung | deterministisch aus vorhandenen Warnungen/Korridoren | höchstens drei Modellmaßnahmen; keine Empfehlung bei fehlenden Daten |

## eFa-Evidenzgrenze

Der eFa-CSV-Parser ist ein lokaler Datentransfervertrag und keine fachliche Trimmquelle.
Geprüft sind synthetische UTF-8/RFC4180-, Mapping-, Vorschau- und Konfliktfälle. Eine reale
eFa-/efaLive-Version, ein Originalexport und dessen Feldsemantik wurden noch nicht verifiziert.
Kandidaten führen deshalb `efaVersion: unknown` in der Provenienz; Live-Sync und Writeback
bleiben unimplementiert. Diese Grenze ändert nichts an den weiterhin offenen Trainer-Golden-
Daten und Kalibrierungen.

## Erforderliche fachliche Freigabe

Vor einer Kauf- oder Store-Version müssen mindestens drei reale Messreihen mit Trainer und
Bootswart gegen die App gerechnet werden: Skull, Riemen und ein körperlicher Grenzfall. Akzeptiert
wird ein Modellwert erst, wenn Definition, Messmethode, Toleranz, Quelle und Golden-Test gemeinsam
dokumentiert sind.
