# Plan: Font Axis Gradient (vormals „Font weight gradient“)

Stand: 2026-11-17

## 1. Ist-Zustand

| Datei | Inhalt |
|---|---|
| `manifest.json` | ID `f5640f22-…`, `main: code.js`, `ui: ui.html`, `isTool: true`, `documentAccess: dynamic-page` |
| `code.ts` | Prüft die Auswahl, liest `fvar` aus hochgeladenen TTF/OTF-Dateien (nur `wght`), lineare Interpolation pro Graphem, Kontrolle per Readback, Restore über `pluginData` |
| `ui.html` | PropsKit-`fig-*`-Web-Components, Tabs Manual / Font file, Start/End, Entire text / Each word, Textvorschau der Werte |

Erkenntnisse:
- Das ist ein **„generatives“ Figma-Plugin** (Figma-gehostet; in deinem Account als „Weight progression“ mit derselben ID). Die `fig-*`-Komponenten werden von der Figma-Runtime eingeschleust, deshalb gibt es in `ui.html` kein `<script src>`.
- Lokal fehlt alles zum Bauen: kein `package.json`, kein `tsconfig`, kein `code.js`. **Lokal in Figma Desktop importiert läuft das Plugin so nicht.** Die `fig-*`-Tags wären undefiniert und `code.js` fehlt.
- Nur `wght` wird unterstützt, die Progression ist immer linear von Anfang bis Ende.
- Grenzen der Achsen gibt es nur per Datei-Upload oder als „1–1000“-Schätzung.

## 2. Was die Figma-API heute kann (Update 138, Sept. 2026)

- `figma.getFontFamilyVariationAxes(family)` → `['wght','wdth','ROND', …]` oder `null` (statische Schrift). **Nur die Tags, keine min/max/default.**
- Beim Lesen enthält `fontName.variationSettings` **alle** Achsen mit den aktuellen Werten.
- Schreiben: `setRangeFontName(start, end, { family, style?, variationSettings })`, nicht angegebene Achsen behalten den Default des Named Instance.
- `loadFontAsync({ family })` lädt alle Styles.

→ **Schrift und Achsen automatisch zu erkennen ist gelöst.** Es fehlen nur die Wertebereiche pro Achse.

### Wertebereiche ohne Datei-Upload ermitteln – Ergebnis Phase 0 (getestet 2026-11-17)
- **Figma klemmt NICHT.** `variationSettings: { wght: 100000 }` wird gespeichert und genau so zurückgelesen, auch −100000. Readback-Probing funktioniert also nicht. Folge: Die bisherige Readback-Prüfung in `apply()` erkennt ungültige Werte nicht und kann weg.
- **Render-Probing funktioniert:** Ein temporärer TextNode („HOamgs“, 48 px) wird per `exportAsync({ format: 'SVG_STRING' })` gerendert. Die Ausgabe bei einem Wert ≥ max ist identisch zur Ausgabe bei +100000. Eine Binärsuche zwischen Default und ±100000 liefert so max bzw. min.
  - Gemessen: 9 Achsen in **2,9 s**, ca. 7 ms pro Render.
  - Roboto Flex: wght 100–1000, wdth 25–151, GRAD −200–150, slnt −10–0, XTRA 323–603 ✔
  - Google Sans Flex: ROND 0–100, wght 1–1000 ✔ · Inter: wght ~100,9–899,1, slnt −10–0 (leichte Ungenauigkeit)
  - Nachbearbeitung: Werte auf Named-Instance-Werte bzw. ganze Zahlen runden (Toleranz ~1 % des Bereichs). Ergebnis pro Familie in `figma.clientStorage` cachen.
- Default pro Achse: `fontName.variationSettings` des Styles „Regular“ (bzw. des ersten Styles).
- **Erkennung:** 506 von 1939 verfügbaren Familien sind variabel; `getFontFamilyVariationAxes` liefert für alle die Tags (z. B. Roboto Flex: 12 Achsen).
- Datei-Upload bleibt als exakte Quelle und wird auf alle Achsen erweitert. Fallback: Tabelle der registrierten Achsen.

## 3. Zielfunktionen

1. **Alle variablen Achsen**: Liste der erkannten Achsen; jede mit Schalter (aktiv/inaktiv), Start- und Peak-Wert, Bereich auto-erkannt. Mehrere Achsen gleichzeitig.
2. **Peak-Position statt nur Anfang→Ende** (✅ Phase 2):
   - `Peak position` 0–100 % (Slider), zusätzlich ein Buchstabe im Preview klickbar zum Setzen.
   - `Falloff` (Breite): wie schnell der Wert vom Peak abfällt.
   - `Curve`: Linear / Smooth / Ease-in / Ease-out.
   - Formel pro Buchstabe *i* von *n*: `pos = i/(n-1)`, `d = |pos − peak| / falloff` (auf 1 begrenzt), `v = base + (peak − base) · curve(1 − d)`.
   - Beispiel „Wort“, Peak auf „r“ (66,7 %): r = Peak; o und t haben den gleichen Abstand → gleicher Wert; W ist am weitesten weg → am kleinsten. ✔
   - Der alte Modus „Start → End“ ist der Spezialfall peak = 100 %, falloff = 100 %, kein eigener Code nötig.
3. **Live-Vorschau im Plugin-UI** (siehe §4).
4. **Dark/Light**: `figma.showUI(…, { themeColors: true })` ist schon gesetzt. Nur `--figma-color-*`-Tokens verwenden, keine festen Farben; die eigene Primärfarbe `#0D99FF` deckt sich mit `--figma-color-bg-brand`, die Überschreibung kann also wegfallen.
5. Beibehalten: Each word / Entire text, Restore, Readback-Verifikation, Persistenz pro Layer (Schema auf `version: 2` migrieren).

## 4. Live-Vorschau: Optionen

| Option | Treue | Aufwand | Bemerkung |
|---|---|---|---|
| **A. Render durch Figma** (Empfehlung): temporären Klon off-canvas anlegen, Werte anwenden, `exportAsync({format:'PNG'})`, Bytes ans UI schicken, Klon löschen. Debounce ~120 ms. | 100 % echte Glyphen, jede Schrift | mittel | Funktioniert ohne Netzwerk und ohne Font-Datei. |
| B. CSS im iframe (`font-variation-settings` pro `<span>`) | nur, wenn die Schrift im iframe verfügbar ist (lokal installiert über `local()`, oder per Upload mit `FontFace`) | gering | Gute Ergänzung bei hochgeladener Datei, sonst unzuverlässig. |
| C. Direkt auf dem Canvas live anwenden, „Cancel“ setzt zurück | 100 % | gering | Optionaler Schalter „Live on canvas“; Undo-Historie sauber halten. |
| D. Balkendiagramm der Werte pro Buchstabe | abstrakt | gering | Immer anzeigen, zusätzlich zu A. |

Empfehlung: **A + D**, C als Option.

## 5. Grundsatzentscheidung: generativ oder lokales Dev-Plugin

| | Generativ (wie jetzt) | Lokales Dev-Plugin |
|---|---|---|
| Bearbeiten | per Figma-MCP `update_generative_plugin` (nur `code.ts`/`ui.html`) | normal im Repo, Git |
| Manifest/Dateien | **nicht änderbar**, keine neuen Dateien | frei (z. B. `networkAccess` für Google-Fonts-Metadaten) |
| UI-Kit | PropsKit eingebaut | **FigUI3** (`@rogieking/figui3`): dieselbe `fig-*`-Familie, CSS+JS inline gebündelt |
| Build | keiner | `esbuild` (`code.ts` → `code.js`, UI inline) + `tsc --noEmit` mit `@figma/plugin-typings` |
| Testen | Try-Link im Browser | Figma Desktop → Plugins → Development → Import from manifest, Hot Reload |
| Veröffentlichen | Account-Library | Community oder privat in der Org |

**Empfehlung: lokales Dev-Plugin.** Das Repo existiert bereits, das UI lässt sich fast 1:1 mit FigUI3 übernehmen, man kann Typen prüfen und Tests schreiben, und man ist nicht an das Manifest gebunden.

## 6. Umsetzung in Phasen

**Phase 0 – Lauffähig machen & Annahmen prüfen ✅ erledigt**
- Erledigt: `package.json`, `tsconfig.json`, `scripts/build.mjs` (esbuild + FigUI3 12.0.3 inline), Quellen in `src/`, Build nach `dist/`, Manifest angepasst (`isTool` entfernt, `networkAccess: none`), FigUI3-Skills in `.claude/skills/`, Testdatei in Figma angelegt, Clamping-Experiment (siehe §2).
- Ursprünglicher Plan:
- `package.json`, `tsconfig.json`, `@figma/plugin-typings` (die eigene `VariableFontApi`-Typ-Krücke entfernen, sobald die Typings Update 138 kennen), `esbuild`-Script `npm run build` / `npm run watch`.
- FigUI3 einbinden (CSS+JS ins `ui.html` inlinen, da Plugin-iframes keine relativen Pfade laden).
- Manifest: `main: dist/code.js`, `ui: dist/ui.html`, Feld `documentAccess` beibehalten. `isTool` entfernen, falls Figma es lokal ablehnt.
- Experiment (per Figma-MCP `use_figma` in einer Testdatei mit Inter / Roboto Flex): Klemmt Figma Achsenwerte außerhalb des Bereichs? Wie verhält sich ein Wert ohne Named Instance? Hiervon hängt die Probing-Strategie ab.

**Phase 1 – Achsen-Erkennung ✅ umgesetzt (Test in Figma Desktop offen)**
- `src/axes.ts` (Typen, Namen, Fallback-Tabelle, Snapping), `src/probe.ts` (Render-Probing, Cache `axisRanges:v2:<family>` in `clientStorage`), `src/fontfile.ts` (fvar: alle Achsen inkl. Namen aus der `name`-Tabelle, versteckte Achsen ausgelassen).
- Tab „Manual entry“ → „Detected“ (gespeichertes `manual` wird zu `auto` migriert). Achsenliste im UI, Start/End-Weight auf den erkannten bzw. aus der Datei gelesenen `wght`-Bereich begrenzt.
- Per MCP verifiziert: Inter wght 100–900 / slnt −10–0; Roboto Flex alle 12 Achsen inkl. YTAS 649–854; Google Sans Flex ROND 0–100, wght 1–1000; Recursive wght 300–1000, slnt −15–0.
- Bekannte Grenze: Achsen mit Stufen-Verhalten (Recursive CRSV) zeigen nur den sichtbar wirksamen Teilbereich.
- **opsz ist per Plugin nicht steuerbar:** Figma koppelt die optische Größe automatisch an die Schriftgröße. Bei Roboto Flex fehlt `opsz` in `getFontFamilyVariationAxes` ganz (das Setzen wirft „not a valid variation setting“); bei Bricolage Grotesque/„Allo Variable“ ist die Achse gelistet, Werte haben aber keine sichtbare Wirkung. Solche Achsen werden als `unavailable` markiert („Auto · font size“ bzw. „Not adjustable“) statt mit erfundenem 1–1000-Bereich.
- Nachbesserung nach erstem Test: Tabs „Detected/Font file“ entfernt. Die Erkennung ist der Standard; eine passende Font-Datei überschreibt automatisch („Ranges look wrong? Use the font file“). Schlägt die Erkennung fehl → Spec-Bereiche als „Assumed“ + Datei-Option offen. Spinner + Fortschritt („3 of 12 · wdth“) während der Messung. Sektionen „Variable axes“ und „Weight“ getrennt. Manuelles Überschreiben pro Achse → Phase 3.
- Ursprünglicher Plan:
- Bei `selectionchange`: Familie → `getFontFamilyVariationAxes` → Bereich per Probing (gecacht pro Familie) → ans UI.
- Datei-Upload auf alle Achsen erweitern; die Datei überschreibt die geprobten Werte.

**Phase 2 – Mehrachsen-Engine mit Peak/Falloff/Curve ✅ umgesetzt**
- `src/engine.ts`: `strengths()` / `computeValues()` (Peak-Position, Falloff, Kurve linear/smooth/easeIn/easeOut), 10 Unit-Tests in `test/engine.test.ts` (`npm test`).
- UI-Skript ist jetzt `src/ui/main.ts` (TypeScript, von esbuild gebündelt und in `dist/ui.html` eingesetzt) und nutzt dieselbe Engine wie das Plugin. Eigene `tsconfig.ui.json` mit DOM-Typen.
- `apply()`: alle aktiven Achsen pro Buchstabe in `variationSettings` gemischt, übrige Achsen bleiben. Speicherformat v2 (`settings`), v1 (Start/End-Weight) wird automatisch migriert.
- UI (funktional): pro Achse Schalter + Edge/Peak-Wert; Peak position, Falloff, Curve, Apply across; „Start → End“-Reset; Balkenvorschau pro Buchstabe, Klick setzt den Peak.
- Verifiziert: Browser-Vorschau mit simulierter Auswahl (Wort, Peak auf r → W 400 · o 700 · r 1000 · t 700); in Figma wght + wdth pro Buchstabe gesetzt und zurückgelesen, GRAD unverändert.
- Für Phase 3 notiert: eingerückte fig-field-Labels, Restore-Button in eigener Zeile, Slider-Zahlenfeld-Optik, `fig-easing-curve` für die Kurve.
- Ursprünglicher Plan:
- Reine Funktion `computeValues(glyphCount, axisConfig) → number[]`, in eigener Datei mit Unit-Tests (vitest), läuft in Plugin und UI identisch.
- Anwenden: pro Graphem alle aktiven Achsen in `variationSettings` mergen, übrige Achsen erhalten.

**Phase 3 – UI (in Arbeit)**
- ✅ Header/Untertitel entfernt, Auswahl als kompakte Zeile („T Google Sans Flex · 4 letters“).
- ✅ Footer einzeilig (Restore + Apply), Apply nutzt Figmas Brand-Tokens (weiß auf Blau, im Dark Mode #0C8CE9) statt eigener Farben.
- ✅ Link „Ranges look wrong?“ ohne blauen Hover-Hintergrund (FigUI3-`button:hover` überschrieben).
- ✅ Achsen verknüpft/gelöst: jede Achse folgt standardmäßig der gemeinsamen Progression; Ketten-Symbol gibt ihr eine eigene (`AxisSetting.shape`). Chips „Shared / <Achse>“ wählen, welche Progression Regler und Vorschau zeigen.
- ✅ Richtungs-Toggle „Start → End“ ↔ „End → Start“ (für die gerade bearbeitete Progression).
- ✅ Bereich pro Achse manuell korrigieren (Stift-Symbol), gespeichert pro Schrift in `clientStorage` (`rangeOverrides:v1:<family>`), Reset möglich.
- ✅ fig-field-Labels bündig (FigUI3 bringt eigene 16-px-Ränder mit).
- ✅ Runde 2: Slider-Zahlenfeld-Abstand 12 px; Vorschau + Status + Buttons als fixiertes Dock unten (Fensterhöhe max. 760 px, darüber scrollen die Einstellungen); Werte pro Buchstabe hinter „Show values“ als Tabelle (alle aktiven Achsen, Peak markiert).
- ✅ Schriftwechsel an der ausgewählten Ebene wird erkannt (`page.on('nodechange')` auf fontName/characters/styledTextSegments/textStyleId, auch nach Seitenwechsel). Das UI lädt dann die Achsen der neuen Schrift neu und behält die Progression.
- ✅ Kurve als `fig-easing-curve` (Bezier, Presets + Ziehen); Engine wertet `Shape.bezier` aus (alte Presets werden auf Bezier abgebildet).
- ✅ Slider-Wertfeld wieder als native FigUI3-Einheit (Spur | Wert, 24 px); die 32-px-Regel gilt nicht mehr für das Slider-Feld.
- ✅ Chips heißen nach den Achsen, die sie steuern: eine verknüpfte Achse → ihr Name; mehrere → Ketten-Symbol + „Width + Grade“ bzw. „Width, Grade +2“ (Tooltip listet alle). Kein abstraktes „Shared“ mehr.
- ✅ Umbenannt in **Font Axis Gradient** (Plugin-ID und Speicher-Keys unverändert).
- Ursprünglicher Plan:
- Pro Achse ein aufklappbarer Block: Schalter, Bereich, `fig-slider` für Base/Peak.
- Globale Steuerung: Peak position (Slider + Klick auf Buchstaben), Falloff, Curve, Entire text / Each word.
- Footer: Restore · Apply.

**Phase 4 – Live-Vorschau → Live-Bearbeitung ✅ umgesetzt und in Figma getestet**
- Erst als SVG-Vorschau einer temporären Kopie gebaut, dann nach Messung verworfen: direkt auf den Text ist bei kurzen Texten ~2,5× schneller (8 vs. 20 ms) und zeigt das Ergebnis im echten Kontext.
- Messung: jeder `setRangeFontName`-Aufruf kostet Zeit proportional zur Textlänge → quadratisch. Unabhängig von Zeilenumbruch/Auto-Resize/Reihenfolge; nur weniger Aufrufe helfen.
- Live pro Regler-Schritt (mit Zusammenfassen gleicher Nachbarwerte): 4 Zeichen 4–7 ms · 30 Zeichen 24–55 ms · 50 Zeichen 45–104 ms · 100 Zeichen 133–670 ms.
- Daher **Limit 100 Zeichen** mit klarer Meldung. Änderungen erst bei Nutzer-Eingaben (Öffnen/Auswählen ändert nichts), max. ein Schreibvorgang pro Frame, Plugin verarbeitet nur den neuesten.
- Rückgängig: kein `commitUndo` pro Schritt; Abschluss bei „Done“ (schließt das Plugin), Ebenenwechsel oder Schließen. In Figma getestet: ⌘Z springt pro losgelassenem Regler einen Schritt zurück (nicht pro Zwischenschritt beim Ziehen). „Restore“ geht jederzeit zum Original zurück.
- Balken-Vorschau zum Peak-Setzen bleibt einzeilig: Ausschnitt von 16 Buchstaben, Pfeile links/rechts mit „+N“ verschieben ihn um je einen Buchstaben (auch per Scrollrad/Trackpad). Bewegt der Slider den Peak aus dem Ausschnitt, wandert dieser mit. (Variante „umbrechen wie Text“ getestet und verworfen.)
- Ursprünglicher Plan: (A + D, optional C).

**Phase 5 – Feinschliff**: Persistenz v2 + Migration, Fehlerfälle (statische Schrift, Mixed Fonts, fehlende Schrift), Performance bei langen Texten (Preview nur erste Zeile / max. N Zeichen).

## 7. Testen

1. **Unit-Tests** (`npm test`): `computeValues` (Beispiel „Wort“, Symmetrie, n = 1, Falloff-Grenzen), fvar-Parser mit echten Fonts als Fixtures (Roboto Flex, Inter).
2. **In Figma Desktop**: `npm run watch` → Plugins → Development → Import plugin from manifest → `manifest.json` wählen. Konsole über Plugins → Development → Show/Hide console.
3. **Testdatei** mit Textebenen in: Inter (wght, opsz), Roboto Flex (viele Achsen inkl. Custom), einer Schrift mit Rundungsachse (z. B. Nunito / Recursive mit `CRSV`/`CASL`), einer statischen Schrift (Fehlerfall) und gemischten Schriften (Fehlerfall). Die Datei kann ich per Figma-MCP anlegen.
4. Theme-Test: Figma → Appearance Light/Dark umschalten, das UI muss mitziehen.

## 8. Tools / Skills

- Kein spezieller Skill für „Figma-Plugin-Entwicklung“ gefunden (Katalogsuche ohne Treffer).
- Nützlich vorhanden: `figma:figma-use` (Experimente & Testdatei per `use_figma`), `figma:figma-generative-plugins` (nur falls generativ bleibt).
- FigUI3 bringt im Paket eine eigene Agent-Skill-Datei für die `fig-*`-Komponenten mit (`.cursor/skills/propkit/SKILL.md`), die man als Projekt-Skill übernehmen kann.
