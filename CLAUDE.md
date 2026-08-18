# Clip — implementation rules for this design

Read `README.md` first. It is self-sufficient for the UI. Product semantics live in `docs/01_CLIP_PRODUCT_SPEC.md` and are settled — do not redesign them.

## Hard rules

1. `design/*.dc.html` are **design references, not code**. Never import, copy, or serve them. Recreate the UI in this codebase's framework.
2. Use `tokens.css` as the single source of visual values. No ad-hoc hex codes, no new spacing values outside the 4px scale.
3. `--faint` (#5f646a) is for **disabled controls only**. Any readable text uses `--muted`. This is an accessibility rule, not a preference.
4. No shadows, no gradients, no blur, no animation beyond a 120ms hover color transition.
5. Radius is 2px (1px chips, 50% radios). Borders are 1px.
6. Monospace = machine values only (channel, role, timestamp, permission constant, slash command). Never for human sentences.
7. One primary button per screen. Destructive actions are always two steps with consequence copy listing what is deleted and what survives.
8. Every state gets a **text tag** (`NOTE` / `OK` / `확인` / `오류` / `누락`). Never signal state with color alone.
9. Korean copy in the README is final. Put it in a string table; do not paraphrase or "improve" it.
10. Mockups use `<span>` where a real control belongs. Build semantic `<button>`, `<input>`, `<select>`, `<fieldset>` with labels and keyboard support.

## Do not add

Reaction/vote/rank counts anywhere in the web UI. Dark/light theme switcher UI (the tokens support both; P0 ships dark). Illustrations, icon sets, marketing pages. Search, AI summarization, publishing — those are P1+ per the spec.

## When you change the design

If implementation forces a visual or copy change, record it in `docs/DESIGN_RATIONALE_APPEND.md` (append, don't rewrite) so the decision log stays complete.
