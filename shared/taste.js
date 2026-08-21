// Skulpt taste engine. Pure functions, zero deps — imported by both the
// browser app and the Railway server so the two can never drift.
//
// Every axis is 0..1. 0.5 is neutral. The whole model is 14 numbers.

export const AXES = [
  'density', 'radius', 'saturation', 'contrast', 'mode', 'typeWeight',
  'typeStyle', 'spacing', 'ornament', 'gradient', 'depth', 'motion',
  'playfulness', 'texture',
];

// Human-readable poles, used for the deck labels and the compiled brief.
export const POLES = {
  density:     ['airy', 'packed'],
  radius:      ['sharp', 'pill'],
  saturation:  ['muted', 'vivid'],
  contrast:    ['soft', 'stark'],
  mode:        ['light', 'dark'],
  typeWeight:  ['light', 'heavy'],
  typeStyle:   ['geometric', 'humanist'],
  spacing:     ['tight', 'generous'],
  ornament:    ['bare', 'decorated'],
  gradient:    ['flat', 'graduated'],
  depth:       ['flat', 'layered'],
  motion:      ['still', 'kinetic'],
  playfulness: ['serious', 'playful'],
  texture:     ['clean', 'textured'],
};

export const neutral = () => Object.fromEntries(AXES.map(a => [a, 0.5]));

const clamp01 = n => n < 0 ? 0 : n > 1 ? 1 : n;

// ---------------------------------------------------------------------------
// Deterministic RNG. Decks must be reproducible: same site + same seat in the
// deck must always yield the same card, or a refresh silently rerolls the
// user's session and the swipe history stops meaning anything.
// ---------------------------------------------------------------------------
export function rng(seed) {
  let s = 0;
  const str = String(seed);
  for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) >>> 0;
  s = s || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;  s >>>= 0;
    return s / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Learning
// ---------------------------------------------------------------------------

// ponytail: online mean-shift, not gradient descent. 30 swipes is far too few
// a sample for anything fancier to beat it.
const LR = { love: 0.34, keep: 0.18, pass: -0.14 };

// Wu et al. (arXiv:2509.16779) measured binary ranking at 49.2% inter-rater
// agreement — near random. A nudge is a one-tap micro-revision, and revision
// scored 76.1%, so a nudge is weighted well above the swipe that carried it.
const NUDGE_STEP = 0.22;

export const NUDGES = {
  bolder:  { typeWeight: +1, contrast: +1, saturation: +0.6 },
  quieter: { typeWeight: -1, contrast: -1, saturation: -0.6, ornament: -0.6 },
  warmer:  { saturation: +0.7, playfulness: +0.8, texture: +0.5, radius: +0.4 },
  tighter: { spacing: -1, density: +1, ornament: -0.4 },
  looser:  { spacing: +1, density: -1 },
  flatter: { depth: -1, gradient: -1, texture: -0.5 },
};

/**
 * Fold one swipe into the taste vector.
 * @param {object} vec   current vector (not mutated)
 * @param {object} card  the card's own axis values
 * @param {'love'|'keep'|'pass'} verdict
 * @param {string} [nudge] optional key of NUDGES
 */
export function applySwipe(vec, card, verdict, nudge) {
  const rate = LR[verdict];
  if (rate === undefined) throw new Error(`unknown verdict: ${verdict}`);

  const next = { ...vec };
  for (const a of AXES) {
    // Move toward what they loved, away from what they passed on.
    next[a] = clamp01(next[a] + rate * (card[a] - next[a]));
  }

  if (nudge) {
    const deltas = NUDGES[nudge];
    if (!deltas) throw new Error(`unknown nudge: ${nudge}`);
    for (const [axis, dir] of Object.entries(deltas)) {
      next[axis] = clamp01(next[axis] + dir * NUDGE_STEP);
    }
  }
  return next;
}

/**
 * Confidence, 0..1. Rises with swipe count and with how far the vector has
 * committed away from neutral — a user who swipes 30 times but lands on 0.5
 * everywhere genuinely has told us nothing.
 */
export function confidence(vec, swipeCount) {
  const volume = Math.min(1, swipeCount / 26);
  const commitment = AXES.reduce((s, a) => s + Math.abs(vec[a] - 0.5), 0) / (AXES.length * 0.5);
  return Math.round(Math.min(1, volume * 0.65 + Math.min(commitment, 1) * 0.35) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Deck generation — variants of the user's OWN site, not stock inspiration.
// ---------------------------------------------------------------------------

/**
 * Build one card by perturbing the site's measured tokens. Early cards explore
 * widely; later ones tighten around what the user has revealed so far.
 */
export function makeCard(base, vec, seed, index) {
  const r = rng(`${seed}:${index}`);
  // Exploration decays as the profile firms up, but never to zero — a deck
  // that stops exploring can never correct an early wrong turn.
  const spread = Math.max(0.16, 0.52 - index * 0.012);
  const axes = {};
  for (const a of AXES) {
    const anchor = (base[a] ?? 0.5) * 0.35 + vec[a] * 0.65;
    axes[a] = clamp01(anchor + (r() * 2 - 1) * spread);
  }
  return { id: `${seed}:${index}`, index, axes, style: cardStyle(axes) };
}

export function makeDeck(base, vec, seed, count = 12, from = 0) {
  return Array.from({ length: count }, (_, i) => makeCard(base, vec, seed, from + i));
}

// ---------------------------------------------------------------------------
// Rendering: axes -> concrete CSS the card can actually be drawn with
// ---------------------------------------------------------------------------

const FONTS = {
  // Deliberately excludes Inter, Arial and system stacks — Impeccable's
  // first anti-pattern, and the single loudest "generated by AI" tell.
  geometric: ['Space Grotesk', 'Chivo', 'Familjen Grotesk', 'Archivo'],
  neutral:   ['Söhne', 'Suisse Int\'l', 'Basis Grotesque', 'Diatype'],
  humanist:  ['Instrument Serif', 'Fraunces', 'Newsreader', 'Signifier'],
};

export function fontFor(vec, r = Math.random) {
  const t = vec.typeStyle;
  const bucket = t < 0.34 ? 'geometric' : t < 0.67 ? 'neutral' : 'humanist';
  const pool = FONTS[bucket];
  return { bucket, family: pool[Math.floor(r() * pool.length)], pool };
}

/** Tinted neutrals only — never pure black or pure grey (anti-pattern). */
export function neutralsFor(vec) {
  const hue = Math.round(20 + vec.saturation * 200);
  const tint = 4 + Math.round(vec.saturation * 8);
  const dark = vec.mode > 0.5;
  const inkL = dark ? 92 - vec.contrast * 6 : 14 - vec.contrast * 6;
  const bgL = dark ? 8 + (1 - vec.contrast) * 6 : 98 - (1 - vec.contrast) * 4;
  return {
    ink: `hsl(${hue} ${tint}% ${Math.max(4, inkL)}%)`,
    bg: `hsl(${hue} ${Math.max(2, tint - 3)}% ${Math.min(99, bgL)}%)`,
    accent: `hsl(${(hue + 150) % 360} ${30 + vec.saturation * 55}% ${dark ? 62 : 44}%)`,
    dark,
  };
}

export function cardStyle(axes) {
  const n = neutralsFor(axes);
  const r = rng(JSON.stringify(axes));
  return {
    ...n,
    radius: Math.round(axes.radius * 26),
    pad: Math.round(14 + axes.spacing * 30),
    weight: axes.typeWeight < 0.34 ? 400 : axes.typeWeight < 0.7 ? 600 : 800,
    tracking: (0.02 - axes.typeWeight * 0.06).toFixed(3),
    font: fontFor(axes, r).family,
    shadow: axes.depth < 0.3 ? 'none'
      : `0 ${Math.round(axes.depth * 30)}px ${Math.round(axes.depth * 60)}px -${Math.round(axes.depth * 24)}px hsl(${Math.round(20 + axes.saturation * 200)} 30% 12% / ${(axes.depth * 0.42).toFixed(2)})`,
    gradient: axes.gradient > 0.45,
    texture: axes.texture > 0.55,
  };
}

// ---------------------------------------------------------------------------
// Compile: taste vector -> the artefact the agent actually consumes
// ---------------------------------------------------------------------------

const band = v => v < 0.34 ? 0 : v < 0.67 ? 1 : 2;

const RULES = {
  density: [
    'Let the page breathe. Long scroll, few elements per viewport, no filler.',
    'Balanced information density. Group related things, leave real gaps between groups.',
    'Dense and utilitarian. Information-first, minimal decorative whitespace.',
  ],
  radius: [
    'Square corners. `border-radius: 0` on cards, buttons and inputs.',
    'Restrained radii: 6–10px on containers, 6px on controls. Never pill-shaped.',
    'Soft and rounded: 16–24px on containers, fully pill controls.',
  ],
  saturation: [
    'Near-monochrome. One accent hue used sparingly, everything else tinted neutral.',
    'One dominant hue plus one accent. Resist a third.',
    'Saturated and confident. Colour carries the hierarchy.',
  ],
  contrast: [
    'Low contrast, close values. Separation comes from spacing, not borders.',
    'Clear but unaggressive contrast. Body text at least 7:1 on its background.',
    'Stark. Near-black on near-white, hard edges, no mid-tone mush.',
  ],
  mode: [
    'Light ground. Tinted off-white background, never `#fff`.',
    'Light default with a real dark mode — both designed, not inverted.',
    'Dark ground. Tinted near-black background, never `#000`.',
  ],
  typeWeight: [
    'Light type. 300–400 headings, generous line-height, let size do the work.',
    'Medium weights. 600 headings, 400 body. Weight contrast over size contrast.',
    'Heavy display type. 700–800 headings, tight tracking (-0.03em), large sizes.',
  ],
  typeStyle: [
    'Geometric sans throughout. Even strokes, closed apertures.',
    'Neutral grotesque. Workhorse face, no personality in the letterforms.',
    'Humanist or serif display. Let the headline face carry the character.',
  ],
  spacing: [
    'Tight rhythm. 4px base scale, components sit close.',
    'Standard 8px scale. Consistent vertical rhythm.',
    'Generous 8px scale with large multiples. Sections separated by 96px+.',
  ],
  ornament: [
    'No ornament. No icons for decoration, no dividers that a gap could do.',
    'Sparing ornament. One motif, used consistently.',
    'Ornament is the point: rules, marks, badges, deliberate detail.',
  ],
  gradient: [
    'Flat fills only. No gradients anywhere.',
    'Gradients only as large, low-contrast background fields — never on text or buttons.',
    'Gradient as a signature element, with grain over it so it does not band.',
  ],
  depth: [
    'Completely flat. Separation by colour and space, zero shadows.',
    'One elevation level. Soft, large-radius, low-opacity shadow.',
    'Layered. Multiple elevations, but every shadow tinted with the background hue.',
  ],
  motion: [
    'Essentially static. Respect `prefers-reduced-motion` and ship almost nothing.',
    'Motion on state change only. 150–220ms, ease-out.',
    'Motion is expressive: entrances, parallax, transitions. Still capped at 400ms.',
  ],
  playfulness: [
    'Serious and institutional. No jokes in the copy, no whimsy in the shapes.',
    'Warm but professional. Plain-spoken copy, a little personality.',
    'Playful. Character in copy, shape and interaction.',
  ],
  texture: [
    'Perfectly clean surfaces. No noise, no paper, no grain.',
    'Subtle grain on large colour fields to stop banding.',
    'Texture is visible and intentional: grain, paper, print artefacts.',
  ],
};

// Non-negotiables. These are the tells that mark output as machine-made, from
// Impeccable's anti-pattern list (github.com/pbakaus/impeccable).
export const ANTI_PATTERNS = [
  'Never use Inter, Arial, Helvetica, Roboto or a bare system font stack.',
  'Never use pure `#000` or pure `#fff`. Every neutral carries a hue tint.',
  'Never use untinted grey text on a coloured background.',
  'Never nest a card inside a card. If it needs a border, it probably needs a gap.',
  'Never use bounce or elastic easing. Use ease-out or a custom cubic-bezier.',
  'Never centre long-form body copy.',
  'Never use an emoji as a UI icon.',
  'Never ship a purple-to-blue diagonal gradient on a hero.',
];

/**
 * Compile a taste vector into the markdown brief an agent consumes.
 * @param {object} vec
 * @param {{site?:string, swipes?:number, name?:string}} meta
 */
export function compile(vec, meta = {}) {
  const swipes = meta.swipes ?? 0;
  const conf = confidence(vec, swipes);
  const font = fontFor(vec, rng(JSON.stringify(vec)));
  const n = neutralsFor(vec);

  const directives = AXES.map(a => `- **${a}** — ${RULES[a][band(vec[a])]}`).join('\n');
  const table = AXES
    .map(a => `| ${a} | ${vec[a].toFixed(2)} | ${POLES[a][vec[a] < 0.5 ? 0 : 1]} |`)
    .join('\n');

  return `# Design direction${meta.site ? ` — ${meta.site}` : ''}

Generated by Skulpt from ${swipes} taste signals. Confidence ${(conf * 100).toFixed(0)}%.
${conf < 0.45 ? '\n> Low confidence. Treat this as a starting bias, not a specification.\n' : ''}
## Hard constraints

These override any default you would otherwise reach for. They are the
difference between output that looks designed and output that looks generated.

${ANTI_PATTERNS.map(p => `- ${p}`).join('\n')}

## Direction

${directives}

## Concrete starting values

\`\`\`css
:root {
  --ink: ${n.ink};
  --bg: ${n.bg};
  --accent: ${n.accent};
  --radius: ${Math.round(vec.radius * 26)}px;
  --space: ${vec.spacing < 0.34 ? 4 : 8}px;
  --weight-display: ${vec.typeWeight < 0.34 ? 400 : vec.typeWeight < 0.7 ? 600 : 800};
  --tracking-display: ${(0.02 - vec.typeWeight * 0.06).toFixed(3)}em;
}
\`\`\`

Display face: **${font.family}** (or another ${font.bucket} face — ${font.pool.filter(f => f !== font.family).join(', ')}).
Colour scheme: **${n.dark ? 'dark' : 'light'}**.

## Taste vector

| axis | value | leaning |
| --- | --- | --- |
${table}
`;
}

/** Wrap the brief in whatever envelope the target tool expects. */
export function exportAs(vec, format, meta = {}) {
  const md = compile(vec, meta);
  switch (format) {
    case 'md':
      return { filename: 'design-direction.md', mime: 'text/markdown', body: md };
    case 'claude':
      return {
        filename: 'SKILL.md', mime: 'text/markdown',
        body: `---\nname: taste\ndescription: The user's design taste, compiled by Skulpt. Load before writing any UI.\n---\n\n${md}`,
      };
    case 'cursor':
      return {
        filename: '.cursorrules', mime: 'text/plain',
        body: `Apply this design direction to all UI work in this project.\n\n${md}`,
      };
    case 'codex':
      return {
        filename: 'AGENTS.md', mime: 'text/markdown',
        body: `${md}\n---\nApply the above to every interface you generate in this repository.\n`,
      };
    case 'json':
      return {
        filename: 'taste.json', mime: 'application/json',
        body: JSON.stringify({ vector: vec, confidence: confidence(vec, meta.swipes ?? 0), antiPatterns: ANTI_PATTERNS }, null, 2),
      };
    default:
      throw new Error(`unknown format: ${format}`);
  }
}
