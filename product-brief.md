# Font weight gradient

Plugin identity:
- displayName: Font weight gradient
- description: Create letter-by-letter variable font weight gradients with manual values or exact font-file limits.

Original user prompt:
Okay, ich brauche einen Plugin. Erstelle ein Plugin für Text. Und zwar für Schriften, die Variable Fonts verwenden. In dem Plugin möchte ich gerne, dass innerhalb eines Textes unterschiedliche Font Weights benutzt werden. Und die progressiv, dass ich einstellen kann von 100 bis 900 soll in Stufen die Buchstaben die Weight ändern. Das heißt, wenn ich ein Wort mit vier Buchstaben habe, dann hat der erste Buchstabe 100, der zweite und dritte befindet sich irgendwo zwischen 100 und 900 und der letzte, also der vierte, hat 900. In dem Plugin möchte ich das gerne selber konfigurieren, von welcher Font Weight bis zu welcher Font Weight. Und die Font Weight soll immer darausgehend, was die ausgewählte Schrift anbietet. Wenn du dazu Fragen hast, stell die gerne, bevor du loslegst und das Plugin erstellst

Usage:
- User chose exact range from uploaded matching variable TTF/OTF font file.
- Parse fvar weight limits and name table locally; reject unsupported/static/mismatching fonts. File is metadata only, not font installation.
- One selected text layer with one font family; preserve each character's other variation axes, styling and text content.
- Start/end controls constrained to exact uploaded axis bounds, reverse supported, continuous linear interpolation per grapheme. Whole text or restart per whitespace-separated word; whitespace unchanged and excluded from progression. One character uses start value.
- Explicit apply, restore original font ranges, selection status, numeric weight preview. Persist successful start/end/mode per layer but never persist uploaded file bytes; re-upload on relaunch.

Update request:
wenn ich eine schrift reinlade, kommt "Textebene wird erkannt …" es geht aber nicht weiter. bitte fixen und eine andere option hinzufügen, dass man manuell den start und end wert eingeben kann

Updated usage:
- New default manual mode allows direct start/end entry without any font file. General input guard is 1–1000; exact font limits are explicitly unknown in manual mode. File mode remains for exact fvar bounds.
- Persist mode choice per text layer; old attachments retain file mode. Manual mode ignores unrelated uploaded font metadata.
- Startup handshake no longer waits for all UI components to register, retries missing initial connection and reports a bounded error instead of an indefinite loading label. UI state is isolated to avoid global variable collisions; selection inspection reports errors rather than leaving stale loading text.
- Check applied wght values by readback; unsupported/clamped values restore original font ranges and report failure, never claim success for ignored variable settings.

Latest update request:
- Passe die UI in dem plugin so an, dass es in dem figma style gehalten ist.
- challenge die abstände, padding und margin. es soll alles modern aussehen und mit bester ux bedienbar sein.
- das plugin soll komplett auf englisch sein.
- Finde ein treffenderen name, der das plugin direkt beschreibt

UI and naming:
- Renamed to Font weight gradient; retain existing plugin ID and storage keys.
- Fully English interface, validations, parsing errors, status messages, and relaunch label.
- Native Figma-style themed controls and grouped settings. Start/end sit side by side with an accessible swap button; selected text, weight range, distribution, calculated steps and footer actions form a clear compact hierarchy.
- Use native control spacing, restrained section dividers and 4/8/12/16 spacing on custom containers. Light/dark theme tokens, inline validation, input-time preview updates and a persistent primary Apply gradient action.
- Preserve manual/file modes, font upload privacy, restore, parameter memory and reliable startup handshake.

Latest update request:
- Manual entry und Font file sollte in einem tap sein, damit man hin und her switchen kann
- use shadcn/ui with this preset: --preset bIkeyoK
- use the primary color of figma: #0D99FF

Delivered adaptation:
- Replace the source dropdown with native keyboard-navigable Manual entry / Font file tabs and associated panels. Shared start/end controls, uploaded file metadata and per-layer source persistence remain intact when switching.
- Retrieved https://ui.shadcn.com/init?preset=bIkeyoK: base-vega, neutral, Inter, .45rem radius. Adapt these visual cues to the required native plugin controls; do NOT claim the React shadcn/ui library is installed. This implementation limitation was explained to the user before editing.
- Explicit user primary override #0D99FF for enabled Apply action, selected-tab indicator and focus rings, while preserving Figma light/dark surface tokens. Use dark text on the blue primary action for readable contrast.

Latest update request:
orientiere dich an dem style von figma. spacing und größen sollten gleich sein. aktuell ist alles sehr eng und die schriften sind teilweise zu klein. bitte sauber arbeiten!

Reference: .figma/attachments/41b158c130aa2faffeb7669e96fc14ab7462bf2d/CleanShot 2026-10-23 at 14.58.24_2x.png

Current UI direction (supersedes compact preset layout):
- Follow the attached native Figma typography-properties panel: consistently aligned horizontal label/control rows, calm dividers, clear spacing and neutral selected tabs.
- Remove 11px body type, compact groups, custom preset-radius overrides, cramped split weight inputs and tiny icon-only swap control.
- Use 12px control/label/helper text, 18–20px line heights, 14px title and 13px calculated steps. Set readable typography tokens for native controls and preserve a 32px minimum control hit area.
- Full-width stacked Start weight / End weight rows with a shared 2/5 label column. Clearly labeled Swap start and end action. Custom sections use 16px insets, 12px gaps and 8px row spacing; retain native control padding and footer layout.
- Keep tabs, English copy, #0D99FF primary, all behavior and saved parameters. Retain dark text on the blue primary button for readable contrast.
