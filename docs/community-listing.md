# Figma Community listing

Assets: Figma file „Variable Axis Progression – Testdatei“, page **Community assets**
(https://www.figma.com/design/inLqueV9Xq6S57WpgwW0vq). Every frame has a PNG export preset.

Ready-to-upload exports (PNG, 1×) are in [`assets/community/`](../assets/community/):

| Asset | File | Figma frame | Size |
|---|---|---|---|
| Icon | [icon-128.png](../assets/community/icon-128.png) | Icon · 128×128 | 128 × 128 |
| Thumbnail / cover | [cover-1920x1080.png](../assets/community/cover-1920x1080.png) | Cover · 1920×1080 | 1920 × 1080 |
| Carousel 1 | [carousel-1-peak-anywhere.png](../assets/community/carousel-1-peak-anywhere.png) | Carousel 1 · Peak anywhere | 1920 × 1080 |
| Carousel 2 | [carousel-2-linked-or-own.png](../assets/community/carousel-2-linked-or-own.png) | Carousel 2 · Linked or own | 1920 × 1080 |
| Carousel 3 | [carousel-3-every-axis.png](../assets/community/carousel-3-every-axis.png) | Carousel 3 · Detected axes | 1920 × 1080 |

After changing the frames in Figma, export again (every frame has a PNG 1× preset) and replace the files.

Sizes follow Figma's publishing guide (icon 128 × 128, thumbnail and carousel 1920 × 1080, carousel safe area 1800 × 1080).

Design system for the assets (one style for all):
- Background `#151515` everywhere, no header bars. Each slide: title in Google Sans Flex (white, wght 800 / ROND 60) and a DM Mono subtitle in lime caps.
- Type: **Google Sans Flex** (wght, ROND, slnt, wdth, GRAD) for display, always with stylistic sets **SS01** (single-storey a) and **SS02** (double-storey g). **Google Sans Code** 400 with 4 % tracking for labels and values. The Plugin API can't set OpenType features, so new Google Sans Flex text is created by cloning a text that already has them.
- Chips: dot + a baseline-aligned box holding the name (Google Sans Flex) and the value (Google Sans Code).
- Optical alignment: hero words sit in an „Optical offset“ frame so the first glyph's ink lines up with the title's ink edge (85.4 px), not the text box.
- Shapes: only round — pills, dots, bars with round ends, rulers with ticks. No square boxes or outlines.
- One colour per axis: Weight `#2F7BFF` (blue), Roundness `#A47BFF` (violet), Slant `#FF7A21` (orange), Width `#D7F23D` (lime), Grade `#FF3E9B` (pink). Lime also marks the peak.
- Inspiration: section „Inspiration“ on the same page.

## Name
Font Axis Gradient

## Tagline
Vary any variable font axis, letter by letter.

## Description
Font Axis Gradient turns a headline into a progression across any variable font axis: weight, width, grade, roundness, slant or a custom axis.

- Detects every axis of the selected font and measures its range right inside Figma — no font file needed.
- Put the peak on any letter, set how far it fades and shape the curve.
- Combine axes: link them to one shared progression or give each its own.
- Edits apply live to your text. Undo works step by step, and Restore brings back the original at any time.
- Works per text or per word, on texts up to 100 characters.

Tip: if a range looks off, correct it per axis or load the font file for exact limits. Figma sets optical size (opsz) automatically from the font size, so that axis cannot be changed by plugins.

## Tags
typography, variable fonts, font weight, text effects, headline
