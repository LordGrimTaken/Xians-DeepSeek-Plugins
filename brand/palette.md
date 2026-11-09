# Hadal Mint — brand palette & icon system

The visual language for **Xian's DeepSeek Plugins**: a deep-ink rounded square with a
bioluminescent mint line glyph. Every icon is one family — same container, same stroke mass,
same light source — so fifteen plugins read as one curated pack.

Derived from the system-monitor reference icon at
`/opt/dsh-mobile/plugins/system-monitor/icon.svg`, formalised into a strict template.

---

## 1. Tokens

| Token          | Hex       | Role                                                                 |
| -------------- | --------- | -------------------------------------------------------------------- |
| `ink-deep`     | `#050c09` | Page / contact-sheet / banner background. Never an icon fill.        |
| `ink`          | `#0a1f17` | Icon container fill (`rect` at `x2 y2 60x60 rx14`).                  |
| `mint`         | `#4ee59b` | Container stroke at 55% opacity; gradient start; secondary details.  |
| `mint-bright`  | `#a8ffd9` | Gradient end; headline/accent text; small solid accent fills.        |
| `kelp`         | `#2a7a58` | Deep-sea support green — underline rules, quiet dividers, hovers.    |

Observatory accents (sparingly, brand surfaces only): `mint` at 8–14% opacity for grid lines,
aurora glows and focus rings.

### Gradient

```svg
<linearGradient id="xdp-mint" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#4ee59b"/>
  <stop offset="1" stop-color="#a8ffd9"/>
</linearGradient>
```

Always 45° (top-left → bottom-right). Glyph strokes use `stroke="url(#xdp-mint)"`; the gradient
is what makes the line look lit from within rather than simply green.

---

## 2. Icon anatomy (non-negotiable)

| Layer      | Spec                                                                                      |
| ---------- | ----------------------------------------------------------------------------------------- |
| Canvas     | `viewBox="0 0 64 64" width="64" height="64"` — no other size                              |
| Container  | `<rect x="2" y="2" width="60" height="60" rx="14" fill="#0a1f17" stroke="#4ee59b" stroke-opacity="0.55"/>` |
| Gradient   | one `xdp-mint` linearGradient per file (45°)                                              |
| Glyph      | `fill="none" stroke="url(#xdp-mint)" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round"` |
| Ink bounds | artwork stays roughly inside `x/y 12…52` — a 40 px optical field inside the container     |
| Detail     | optional secondary strokes: `stroke="#4ee59b" stroke-opacity="0.55" stroke-width="2.6"`   |
| Accent     | optional single fill `#a8ffd9` (dot, node, play head) — never a large solid mass           |
| Text       | **no text, no letters, no emoji** in icons (contact sheet / banner may use real text)      |
| Refs       | no external references, no scripts, no raster, no `<image>`, no web fonts                 |
| Access     | `role="img"` + `aria-label="<Plugin Title>"`                                              |

Stroke weight is deliberately `3.4` for every icon so the family has one optical mass; the
permitted 3.2–3.8 band exists for legibility corrections only, never for style. At 24 px the
stroke renders ≈1.3 px — the reason glyphs are drawn with generous gaps and at most one idea each.

---

## 3. Do / Don't

**Do**

- Keep one clear silhouette per plugin and test it at 24 px before shipping.
- Let the container breathe: the glyph should not kiss the rounded square.
- Use round caps/joins everywhere — the family is drawn, not cut.
- Keep the single accent fill for the one thing the eye should land on.
- Keep each file ≤ 4 KB, ASCII-only, one root `<svg>`.

**Don't**

- Don't change the container geometry, radius, or stroke colour/opacity per icon.
- Don't fill the container with mint, a gradient, or a photo — it is always flat `ink`.
- Don't introduce a second hue (no cyan, no lime-yellow, no white glyphs).
- Don't use emoji, letters, numbers, or tiny multi-line detail that dies at 24 px.
- Don't add drop shadows, glows, filters, or `stroke-dasharray` decoration.
- Don't reuse one plugin's glyph for another; fifteen distinct silhouettes is the bar.

---

## 4. DSH delivery format

DeepSeek Harness embeds each plugin icon as a **base64 data URI**:

`data:image/svg+xml;base64,…`

- The pack limit is **< 256 KiB per embedded data URI**.
- We keep each source icon **≤ 4 KB**, so the base64 payload is ≈ 5.5 KB — two orders of
  magnitude under the limit, and cheap enough to inline fifteen of them.
- Keep icons ASCII-only and free of external references: a data URI cannot fetch siblings,
  fonts, or CSS. Everything must be inside the single file.
- Keep the same `viewBox` across the family so hosts can render at any pixel size
  (16 / 24 / 32 / 40 / 48 / 64 px all derive from the same artwork).

---

## 5. Brand surfaces in this folder

| File                | Size       | Purpose                                                             |
| ------------------- | ---------- | ------------------------------------------------------------------- |
| `icons/*.svg`       | 64 × 64    | The 15 plugin icons, one per fixed slug.                            |
| `brand/icon-sheet.svg` | 1118 × 600 | 5 × 3 contact sheet on `ink-deep`, titles in mint monospace.     |
| `brand/preview.html`   | fluid      | Self-contained dark preview: every icon at 88 px and 40 px.      |
| `brand/banner.svg`     | 1280 × 320 | Hero: wordmark, subtitle, `ink-deep` background, mint grid/aurora. |
| `brand/palette.md`     | —          | This document.                                                      |

## 6. Type & copy

- Monospace only for brand text:
  `ui-monospace, Menlo, Consolas, monospace` (terminal heritage; no web fonts, no external files).
- Wordmark casing is **sentence case**: “Xian's DeepSeek Plugins” — never all caps.
- Subtitle: “A curated, green-icon plugin pack for DeepSeek Harness”.
- Availability microcopy: “15 plugins · installed off by default”.
- Small labels/eyebrows: uppercase, letter-spaced 0.12–0.18 em, `mint` at 55–70% opacity.

## 7. Colour on dark — quick rules

- Body text: `mint-bright` on `ink-deep`.
- Secondary text: `mint` at 62–88% opacity; never below ~50% for anything readable.
- Dividers: `mint` at 12–20% opacity, 1 px.
- Icon containers may sit on `ink-deep` or `ink` panels; the 55% mint ring keeps them separated.
- Avoid `mint` text at 11 px or smaller on `ink` — drop to 10 px only for slug captions, where it
  is decorative.
