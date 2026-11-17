# Font Axis Gradient

Figma plugin that varies variable-font axes letter by letter (formerly “Font weight gradient”). Roadmap: [PLAN.md](PLAN.md).

## Setup

```bash
npm install
npm run build      # dist/code.js + dist/ui.html
npm run watch      # rebuild on change
npm run typecheck
npm test           # engine unit tests
```

## In Figma Desktop testen

1. `npm run build` (oder `npm run watch` laufen lassen).
2. Figma Desktop → Menü **Plugins → Development → Import plugin from manifest…** → `manifest.json` in diesem Ordner wählen.
3. Eine Textebene auswählen → **Plugins → Development → Font Axis Gradient**.
4. Nach Code-Änderungen: Plugin schließen und erneut starten (oder ⌥⌘P „Run last plugin“).
5. Konsole: **Plugins → Development → Show/Hide console**.

Testdatei mit Inter, Roboto Flex, Google Sans Flex, Recursive, mehreren Wörtern und gemischten Schriften:
https://www.figma.com/design/inLqueV9Xq6S57WpgwW0vq

## Struktur

- `src/code.ts` – Plugin-Logik (Sandbox)
- `src/ui.html` – UI-Markup mit FigUI3-`fig-*`-Komponenten
- `src/ui/main.ts` – UI-Logik (wird mit FigUI3 in `dist/ui.html` eingebettet)
- `src/engine.ts` – Progressions-Mathematik (Plugin + UI)
- `src/probe.ts`, `src/axes.ts`, `src/fontfile.ts` – Achsen-Erkennung
- `scripts/build.mjs` – Build
- `.claude/skills/figui3`, `.claude/skills/propskit` – Agent-Skills aus `@rogieking/figui3` (MIT)

## Community-Assets

Icon, Cover und Carousel-Bilder zum Veröffentlichen liegen fertig in `assets/community/`, Texte und Gestaltungsregeln in [docs/community-listing.md](docs/community-listing.md).

## Plugin-ID

Figma vergibt Plugin-IDs; sie lassen sich nicht selbst erzeugen. Die ID steht nur in `manifest.json` (`"id"`), der Code hängt nicht davon ab.

Neue ID holen:
1. Figma Desktop → **Plugins → Development → New plugin…** → beliebige Vorlage, Name „Font Axis Gradient“, in einen temporären Ordner speichern.
2. Aus dem dort erzeugten `manifest.json` den Wert von `"id"` kopieren und hier in `manifest.json` eintragen. Den temporären Ordner danach löschen.
3. In Figma das alte Development-Plugin entfernen und dieses `manifest.json` neu importieren.

Alternativ vergibt Figma beim ersten Veröffentlichen eine neue ID.

Folge eines ID-Wechsels: Gespeicherte Original-Zustände („Restore“) bereits bearbeiteter Ebenen, gemessene Achsenbereiche und manuell korrigierte Bereiche gehören zur alten ID und werden nicht mehr gefunden (Bereiche werden einfach neu gemessen).
