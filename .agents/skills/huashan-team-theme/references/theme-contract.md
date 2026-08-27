# Team Theme Contract

## Runtime files

- Registry: `internal/server/web/js/theme-registry.js`
- Shared template: `[data-theme-template=team]` rules in `internal/server/web/styles.css`
- Runtime assets: `internal/server/web/assets/`
- Frontend tests: `test/test.mjs`

A normal team addition changes the registry, adds one crest, updates tests and user-facing release documentation, and does not change the shared CSS template.

## Registry entry

Add one entry inside the `themes` array:

```js
createTeamTheme({
  id: 'team-slug',
  name: '战队中文名',
  englishName: 'TEAM NAME',
  desc: '一句面向用户的服装配色描述。',
  crest: 'assets/team-slug-crest.webp',
  palette: {
    background: '#f3f6fa',
    surface: '#ffffff',
    surfaceAlt: '#eaf0f7',
    border: '#c8d3e2',
    text: '#12233f',
    muted: '#60708a',
    primary: '#1769d2',
    primarySoft: '#d7e7fb',
    secondary: '#20b8c8',
    accent: '#f0b429',
    accentText: '#805f00',
    link: '#08799b',
    danger: '#b7354a',
    hover: '#e1e9f3',
    onPrimary: '#ffffff',
    buttonTop: '#2780e8',
    buttonBottom: '#1156b4',
  },
}),
```

`id` must use lowercase ASCII letters, digits, and hyphens. `crest` is relative to `internal/server/web/`.

## Palette roles

- `background`: application canvas; usually the lightest uniform-neutral color.
- `surface`: cards and controls; must separate clearly from `background`.
- `surfaceAlt`: secondary cards, placeholders, and hover foundations.
- `border`: visible on both `surface` values without dominating them.
- `text`: darkest uniform color; must keep normal text readable on both surfaces.
- `muted`: secondary text; keep readable at small sizes.
- `primary`: main jersey/brand color used for actions and focus.
- `primarySoft`: pale primary tint used behind controls and focus accents.
- `secondary`: secondary jersey or crest color used for decorative light effects.
- `accent`: small, vivid trim color used for stripes and MVP-style emphasis.
- `accentText`: darker companion to `accent`, readable on its pale tint.
- `link`: readable interactive text color on both surfaces.
- `danger`: loss/error/backpack mark color, distinct from `primary`.
- `hover`: subtle interactive surface.
- `onPrimary`: button text on `primary`.
- `buttonTop` / `buttonBottom`: restrained action gradient derived from `primary`.

Prefer the uniform's fabric colors over colors that appear only in the crest. Check normal text and controls for sufficient contrast; when a literal garment color is too bright, darken only the semantic text companion rather than changing the visible brand accent.

## Crest asset

- Use WebP with transparency and no baked background.
- Keep the full crest inside the canvas with balanced transparent padding.
- Use a square or near-square canvas when practical; the runtime uses `object-fit: contain`.
- Avoid unnecessary resolution. The largest current rendered size is 116 CSS pixels, while a higher-resolution source is useful for dense displays.
- Do not add the uniform reference image to runtime assets; it is an input for palette decisions only.

## Invariants

- `theme-registry.js` loads before `styles.css`, so saved themes apply without a flash.
- The registry owns theme IDs, metadata, palettes, persistence, and team-brand DOM content.
- The shared CSS owns layout and decoration. It must use semantic variables such as `--acc`, `--team-secondary`, `--team-accent`, and `--team-crest`.
- The theme picker renders all team previews from registry data; no team ID checks belong in `options.js`.
- Switching away from a team theme must clear `data-theme-template` and all injected variables.
