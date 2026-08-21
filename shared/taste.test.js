// node --test shared/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AXES, neutral, applySwipe, confidence, makeCard, makeDeck, compile, exportAs, rng } from './taste.js';
import { deslop, formatReport, RULE_NAMES } from './deslop.js';

const card = v => Object.fromEntries(AXES.map(a => [a, v]));

test('love moves toward the card, pass moves away', () => {
  const v = neutral();
  assert.ok(applySwipe(v, card(1), 'love').density > v.density);
  assert.ok(applySwipe(v, card(1), 'pass').density < v.density);
  assert.ok(applySwipe(v, card(0), 'pass').density > v.density, 'passing on a low card pushes high');
});

test('the vector stays inside 0..1 under repeated extreme swipes', () => {
  let v = neutral();
  for (let i = 0; i < 200; i++) v = applySwipe(v, card(1), 'love', 'bolder');
  for (const a of AXES) assert.ok(v[a] >= 0 && v[a] <= 1, `${a} escaped: ${v[a]}`);
});

test('a nudge outweighs the swipe that carried it', () => {
  const v = neutral();
  const swipeOnly = applySwipe(v, card(0.5), 'keep');
  const nudged = applySwipe(v, card(0.5), 'keep', 'bolder');
  assert.ok(nudged.typeWeight - swipeOnly.typeWeight > 0.2);
});

test('unknown verdicts and nudges are rejected, not silently ignored', () => {
  assert.throws(() => applySwipe(neutral(), card(0.5), 'maybe'));
  assert.throws(() => applySwipe(neutral(), card(0.5), 'love', 'spicier'));
});

test('confidence needs both volume and commitment', () => {
  assert.ok(confidence(neutral(), 0) < 0.1);
  assert.ok(confidence(neutral(), 30) < 0.7, 'many swipes landing on neutral is not confidence');
  let v = neutral();
  for (let i = 0; i < 30; i++) v = applySwipe(v, card(1), 'love');
  assert.ok(confidence(v, 30) > 0.9);
});

test('decks are reproducible for a seed and diverse within one', () => {
  const base = neutral(), v = neutral();
  assert.deepEqual(makeCard(base, v, 'site-7', 3), makeCard(base, v, 'site-7', 3));
  assert.notDeepEqual(makeCard(base, v, 'site-7', 3).axes, makeCard(base, v, 'site-8', 3).axes);
  const deck = makeDeck(base, v, 'site-7', 12);
  assert.equal(new Set(deck.map(c => JSON.stringify(c.axes))).size, 12);
});

test('rng is deterministic and stays in range', () => {
  const a = rng('x'), b = rng('x');
  for (let i = 0; i < 50; i++) {
    const n = a();
    assert.equal(n, b());
    assert.ok(n >= 0 && n < 1);
  }
});

test('the compiled brief never recommends what it forbids', () => {
  for (const val of [0, 0.5, 1]) {
    const md = compile(card(val), { swipes: 30, site: 'example.com' });
    assert.match(md, /Hard constraints/);
    // #000 and Inter legitimately appear in the constraints that ban them, so
    // only the advice below "Concrete starting values" is held to the rules.
    const advice = md.split('## Concrete starting values')[1];
    assert.doesNotMatch(advice, /#000\b|#fff\b|#ffffff\b/i, 'recommended a pure neutral');
    assert.doesNotMatch(advice, /\bInter\b|\bArial\b|\bRoboto\b/, 'recommended a banned face');
  }
});

test('compiled output survives its own linter', () => {
  const css = compile(card(0.8), { swipes: 30 }).match(/```css\n([\s\S]*?)```/)[1];
  assert.equal(deslop(css).counts.error, 0, formatReport(deslop(css), 'compiled css'));
});

test('low confidence is flagged in the brief, high confidence is not', () => {
  assert.match(compile(neutral(), { swipes: 2 }), /Low confidence/);
  let v = neutral();
  for (let i = 0; i < 30; i++) v = applySwipe(v, card(1), 'love');
  assert.doesNotMatch(compile(v, { swipes: 30 }), /Low confidence/);
});

test('every export format produces a body and a filename', () => {
  for (const f of ['md', 'claude', 'cursor', 'codex', 'json']) {
    const out = exportAs(neutral(), f, { swipes: 10 });
    assert.ok(out.body.length > 100, f);
    assert.ok(out.filename, f);
  }
  assert.throws(() => exportAs(neutral(), 'nope'));
  assert.doesNotThrow(() => JSON.parse(exportAs(neutral(), 'json', {}).body));
});

// --------------------------------------------------------------------------
// de-slop
// --------------------------------------------------------------------------

test('clean source scores 100 and finds nothing', () => {
  const clean = `.a{font-family:'Space Grotesk',sans-serif;color:hsl(210 8% 12%);background:hsl(210 6% 97%);
  box-shadow:0 8px 20px -8px hsl(210 30% 12% / .3);transition:transform .2s ease-out}`;
  const r = deslop(clean);
  assert.deepEqual(r.findings, []);
  assert.equal(r.score, 100);
  assert.match(formatReport(r), /clean/);
});

test('catches each headline tell', () => {
  const cases = {
    'banned-font': `body { font-family: Inter, sans-serif; }`,
    'pure-neutral': `.h { color: #000; background: #ffffff; }`,
    'untinted-grey': `.m { color: #888888; }`,
    'untinted-shadow': `.c { box-shadow: 0 4px 6px rgba(0,0,0,.1); }`,
    'bounce-easing': `.x { transition: transform .3s cubic-bezier(.68,-0.55,.27,1.55); }`,
    'slop-gradient': `<div class="bg-gradient-to-r from-purple-500 to-blue-500"></div>`,
    'nested-card': `<div class="card"><div class="card">x</div></div>`,
    'default-tailwind-card': `<div class="rounded-xl shadow-lg bg-white p-4"></div>`,
    'centred-prose': `p.description { text-align: center; }`,
    'system-font-stack': `body { font-family: -apple-system, sans-serif; }`,
  };
  for (const [rule, src] of Object.entries(cases)) {
    const hit = deslop(src).findings.map(f => f.rule);
    assert.ok(hit.includes(rule), `${rule} missed in: ${src} (got ${hit.join(',') || 'nothing'})`);
  }
});

test('every declared rule is exercised above', () => {
  const covered = new Set(['banned-font', 'pure-neutral', 'untinted-grey', 'untinted-shadow',
    'bounce-easing', 'slop-gradient', 'nested-card', 'default-tailwind-card', 'centred-prose',
    'system-font-stack', 'emoji-icon']);
  for (const r of RULE_NAMES) assert.ok(covered.has(r), `rule "${r}" has no test`);
});

test('mask gradients may use pure black and white as alpha', () => {
  assert.deepEqual(deslop('.a{mask-image:linear-gradient(90deg,#000 0,#000 78%,transparent)}').findings, []);
  assert.deepEqual(deslop('.b{-webkit-mask:linear-gradient(#fff,transparent)}').findings, []);
  // Still caught when it really is a colour.
  assert.equal(deslop('.c{background:linear-gradient(90deg,#000,#333)}').counts.error, 1);
});

test('typographic marks are not emoji, real emoji are', () => {
  assert.deepEqual(deslop('<button>\u2715</button><span>\u2666</span>').findings, []);
  assert.ok(deslop('<button>\u{1F680}</button>').findings.some(f => f.rule === 'emoji-icon'));
  assert.ok(deslop('<button>\u26A0\uFE0F</button>').findings.some(f => f.rule === 'emoji-icon'));
});

test('does not fire on innocent lookalikes', () => {
  // A font named in prose, sibling cards, and a legitimate hue-tinted grey.
  const ok = `<div class="card">a</div><div class="card">b</div>
  <p>We moved off Inter last year.</p>
  <style>.g{color:hsl(210 6% 53%)} .e{transition:opacity .2s ease-out}</style>`;
  assert.deepEqual(deslop(ok).findings.map(f => f.rule), []);
});

test('score falls with severity and floors at zero', () => {
  assert.ok(deslop(`.a{color:#000}`).score < 100);
  const awful = Array.from({ length: 30 }, (_, i) => `.a${i}{color:#000;font-family:Inter}`).join('\n');
  assert.equal(deslop(awful).score, 0);
});

test('deslop rejects non-strings rather than coercing', () => {
  assert.throws(() => deslop(null), TypeError);
  assert.throws(() => deslop({ code: 'x' }), TypeError);
});
