# Ruderpositions-Visualisierer

Browser-Werkzeug zum Visualisieren und Prüfen der Ruderplatz-Einstellung (Trimm) von Ruderbooten,
nach den Richtwerten des DRV-Trimmhandbuchs (Ellerbrake/Filter · Nolte · v. Lingelsheim · Piesik)
und quervalidiert gegen den FISA-Rigging-Survey der Ruder-WM 2017 (Sarasota).

**→ [App öffnen](https://wolfaa73-jpg.github.io/rudertrimm/)**

Ein Projekt der Ruderriege Mark Essen 1904.

## Was die App kann

- **Drei Ansichten** (Draufsicht, Querschnitt, Seitenansicht) eines vollständigen kinematischen
  Körpermodells — ein Ruderer/Ruder-Solver, alle Ansichten sind reine Projektionen desselben Zustands.
- **Zwei Ruderer im Boot** (außer im Einer): Schlagmann als Referenz, Ruderer 2 frei durch eine
  Ruderer-Datenbank durchschaltbar, inkl. Riemen-Gegenseiten (Backbord/Steuerbord).
- **Platzweises Rigg:** Dollenabstand, Innenhebel, Ruderlänge, Dollenhöhe, Stemmbrett u. a. gelten
  pro Sitz — nach DRV-Handbuch Kap. 4.1 ("bei Körperbau-Unterschieden kleinerer Dollenabstand/Innenhebel").
- **Werkstatt- und Wasser-Modus:** Trimmen am Bock (Dollenhöhe ab Rollsitz/Schiene) oder am Steg
  (Dollenhöhe über Wasser) — mit umschaltbarer Referenz und BB/StB-Vergleich.
- **Ampel-Checks** gegen die DRV-Richtwerte (Übergriff, Auslagewinkel, Schlagweite, Dollenhöhe,
  Anlage, Innenhebel, Stemmbrett-Kniewinkel) sowie WM-2017-Presets als Elite-Referenz.
- **Ruderer- und Boots-Datenbank** (lokal im Browser, JSON-Export/Import) — Körpermaße und komplette
  Boots-Einstellungen benannt speichern und wiederverwenden.
- **Blattformen** (Big-Blade/Macon) mit korrektem Auf-/Abdrehen im Schlagzyklus.
- **Offline-fähig** als installierbare PWA (Home-Bildschirm-Icon, funktioniert ohne Internet nach
  dem ersten Laden).

## Technik

Eine einzige `index.html` ohne Build-Schritt und ohne Abhängigkeiten (reines HTML/CSS/JavaScript/SVG).
Einfach öffnen — lokal per Doppelklick oder über die veröffentlichte URL.

## Quellen & Hinweise

- DRV-Trimmhandbuch, Kap. 5 "Das Trimmen der Boote"
- FISA Rigging Survey 2017 (World Rowing Championships, Sarasota) — siehe [ANALYSE_WM2017.md](ANALYSE_WM2017.md)
- Entwicklungsstand & Entscheidungen: [LASTENHEFT.md](LASTENHEFT.md)

Alle Maße sind Ausgangspunkte für die Werkstatt- bzw. Steg-Praxis — auf dem Wasser erproben.
Keine personenbezogenen Daten werden im Code gespeichert; Ruderer- und Boots-Profile bleiben lokal
im Browser des jeweiligen Geräts.
