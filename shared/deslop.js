// The de-slopper. This is the paid surface — the swipe deck is a demo, this is
// the thing that earns the subscription.
//
// Detection is deliberately deterministic: no model call, no latency, no
// disagreement between runs. An agent can call this on every file it writes
// and trust the answer. The LLM only gets involved in the rewrite, where
// judgement is actually required.
//
// Rules are drawn from Impeccable's anti-pattern list
// (github.com/pbakaus/impeccable) plus the tells we see most in agent output.

/** @typedef {{rule:string, severity:'error'|'warn', line:number, match:string, why:string, fix:string}} Finding */

const HEX = /#([0-9a-f]{3}|[0-9a-f]{6})\b/gi;

const expand = h => h.length === 3 ? h.split('').map(c => c + c).join('') : h;
const rgbOf = h => {
  const e = expand(h);
  return [parseInt(e.slice(0, 2), 16), parseInt(e.slice(2, 4), 16), parseInt(e.slice(4, 6), 16)];
};
const isGrey = ([r, g, b]) => r === g && g === b;

// Hue in degrees, for gradient detection.
function hueOf([r, g, b]) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

// ---------------------------------------------------------------------------
// Rules. Each gets the source split into lines and pushes findings.
// ---------------------------------------------------------------------------

const BANNED_FONTS = ['inter', 'arial', 'helvetica neue', 'helvetica', 'roboto', 'open sans', 'lato', 'montserrat', 'poppins', 'nunito'];

const RULES = [
  {
    name: 'banned-font',
    run(lines, push) {
      lines.forEach((ln, i) => {
        const low = ln.toLowerCase();
        // Only look at lines that are actually declaring a face.
        if (!/font-family|fontfamily|font-\[|--font|@import.*fonts\.googleapis|family=/.test(low)) return;
        for (const f of BANNED_FONTS) {
          if (new RegExp(`(^|[^a-z-])${f.replace(/ /g, '[ +-]')}([^a-z-]|$)`, 'i').test(low)) {
            push({
              rule: 'banned-font', severity: 'error', line: i + 1, match: ln.trim().slice(0, 120),
              why: `"${f}" is one of the most-used faces in generated UI. It reads as a default, not a choice.`,
              fix: 'Pick a face with a point of view. See the display face named in your Skulpt profile.',
            });
            break;
          }
        }
      });
    },
  },
  {
    name: 'system-font-stack',
    run(lines, push) {
      lines.forEach((ln, i) => {
        if (/font-family[^;]*:\s*(-apple-system|system-ui|ui-sans-serif)\s*[,;]/i.test(ln) && !/var\(/.test(ln)) {
          push({
            rule: 'system-font-stack', severity: 'warn', line: i + 1, match: ln.trim().slice(0, 120),
            why: 'A bare system stack is the absence of a typographic decision.',
            fix: 'Name a display face; keep the system stack only as the fallback tail.',
          });
        }
      });
    },
  },
  {
    name: 'pure-neutral',
    run(lines, push) {
      lines.forEach((ln, i) => {
        if (/prefers-color-scheme|@media|\/\//.test(ln) && !/#(000|fff)/i.test(ln)) return;
        // In a mask, black and white are alpha values, not colours.
        if (/(^|[\s;{])(-webkit-)?mask(-image)?\s*:/.test(ln)) return;
        const hits = [];
        for (const m of ln.matchAll(HEX)) {
          const [r, g, b] = rgbOf(m[1]);
          if ((r === 0 && g === 0 && b === 0) || (r === 255 && g === 255 && b === 255)) hits.push(m[0]);
        }
        if (/\b(color|background|background-color|border-color|fill)\s*:\s*(black|white)\b/i.test(ln)) hits.push('black/white keyword');
        if (/rgba?\(\s*0\s*,\s*0\s*,\s*0\s*[,)]/.test(ln)) hits.push('rgb(0,0,0)');
        if (/rgba?\(\s*255\s*,\s*255\s*,\s*255\s*[,)]/.test(ln)) hits.push('rgb(255,255,255)');
        if (hits.length) {
          push({
            rule: 'pure-neutral', severity: 'error', line: i + 1, match: hits.join(', '),
            why: 'Pure black and pure white never occur in considered palettes. They make a page feel unmixed.',
            fix: 'Tint every neutral toward the accent hue, e.g. hsl(210 8% 12%) rather than #000.',
          });
        }
      });
    },
  },
  {
    name: 'untinted-grey',
    run(lines, push) {
      lines.forEach((ln, i) => {
        for (const m of ln.matchAll(HEX)) {
          const rgb = rgbOf(m[1]);
          if (isGrey(rgb) && rgb[0] !== 0 && rgb[0] !== 255) {
            push({
              rule: 'untinted-grey', severity: 'warn', line: i + 1, match: m[0],
              why: 'A perfectly neutral grey sits dead against any tinted surface.',
              fix: `Give it a hue: hsl(<accent-hue> 6% ${Math.round(rgb[0] / 2.55)}%).`,
            });
            break;
          }
        }
      });
    },
  },
  {
    name: 'untinted-shadow',
    run(lines, push) {
      lines.forEach((ln, i) => {
        if (/box-shadow|drop-shadow/i.test(ln) && /rgba?\(\s*0\s*,\s*0\s*,\s*0/.test(ln)) {
          push({
            rule: 'untinted-shadow', severity: 'warn', line: i + 1, match: ln.trim().slice(0, 120),
            why: 'Black shadows go muddy over colour. Real shadows carry the hue of the surface they fall on.',
            fix: 'Tint the shadow: hsl(<hue> 30% 12% / .28).',
          });
        }
      });
    },
  },
  {
    name: 'bounce-easing',
    run(lines, push) {
      lines.forEach((ln, i) => {
        let bad = /\b(bounce|elastic|backOut|easeOutBack|spring\()/i.test(ln) && /transition|animation|ease|duration|type:/i.test(ln);
        // cubic-bezier that overshoots outside 0..1 on the control points
        for (const m of ln.matchAll(/cubic-bezier\(([^)]+)\)/gi)) {
          const p = m[1].split(',').map(Number);
          if (p.length === 4 && (p[1] < -0.01 || p[3] > 1.01)) bad = true;
        }
        if (bad) {
          push({
            rule: 'bounce-easing', severity: 'warn', line: i + 1, match: ln.trim().slice(0, 120),
            why: 'Overshoot easing dates a UI to roughly 2014.',
            fix: 'Use ease-out, or cubic-bezier(.2,.8,.25,1) for something with more character.',
          });
        }
      });
    },
  },
  {
    name: 'slop-gradient',
    run(lines, push) {
      lines.forEach((ln, i) => {
        if (/from-(purple|violet|indigo|fuchsia)-\d+[^"']*to-(blue|pink|cyan|indigo)-\d+/i.test(ln)) {
          push({
            rule: 'slop-gradient', severity: 'error', line: i + 1, match: ln.trim().slice(0, 120),
            why: 'The purple-to-blue (or purple-to-pink) gradient is the single most recognisable generated-UI signature.',
            fix: 'Use a single tinted field, or a gradient between two values of one hue.',
          });
          return;
        }
        const g = ln.match(/linear-gradient\(([^)]*)\)/i);
        if (!g) return;
        const hues = [...g[1].matchAll(HEX)].map(m => hueOf(rgbOf(m[1])));
        if (hues.length >= 2 && hues.some(h => h > 250 && h < 300) && hues.some(h => h > 190 && h < 250)) {
          push({
            rule: 'slop-gradient', severity: 'error', line: i + 1, match: g[0].slice(0, 120),
            why: 'Purple-into-blue reads as a template default.',
            fix: 'Stay within one hue family, or drop the gradient for a flat tinted field.',
          });
        }
      });
    },
  },
  {
    name: 'nested-card',
    run(lines, push, src) {
      // Structural, so it needs the whole source. Track depth of anything that
      // calls itself a card and flag the second level.
      const tokens = [...src.matchAll(/<(\/?)(\w+)([^>]*)>/g)];
      const stack = [];
      let cardDepth = 0;
      for (const t of tokens) {
        const [full, closing, , attrs] = t;
        if (/^(br|img|input|hr|meta|link)$/i.test(t[2])) continue;
        const isCard = !closing && /\b(class|className)\s*=\s*["'][^"']*\bcard\b/i.test(attrs);
        if (!closing) {
          stack.push(isCard);
          if (isCard) {
            cardDepth++;
            if (cardDepth === 2) {
              const line = src.slice(0, t.index).split('\n').length;
              push({
                rule: 'nested-card', severity: 'error', line, match: full.slice(0, 120),
                why: 'A card inside a card doubles the borders and halves the meaning of both.',
                fix: 'Drop the inner container. If the group needs separating, give it space, not a box.',
              });
            }
          }
        } else {
          if (stack.pop()) cardDepth--;
        }
      }
    },
  },
  {
    name: 'emoji-icon',
    run(lines, push) {
      // Pictographic emoji always count. A dingbat or geometric mark (✕ ♡ ✦)
      // is typography, not emoji, unless it carries U+FE0F asking for emoji
      // presentation — flagging those would ban legitimate symbol type.
      const EMO = '(?:[\\u{1F300}-\\u{1FAFF}]|[\\u{2600}-\\u{27BF}]\\u{FE0F})';
      const emoji = new RegExp(EMO, 'u');
      lines.forEach((ln, i) => {
        if (!emoji.test(ln)) return;
        if (new RegExp(`<(button|a|li|span|div)[^>]*>\\s*${EMO}`, 'u').test(ln)
          || new RegExp(`icon\\s*[:=]\\s*["']${EMO}`, 'u').test(ln)) {
          push({
            rule: 'emoji-icon', severity: 'warn', line: i + 1, match: ln.trim().slice(0, 120),
            why: 'Emoji render differently on every platform and carry a tone you did not choose.',
            fix: 'Use a real icon set, or a typographic mark.',
          });
        }
      });
    },
  },
  {
    name: 'centred-prose',
    run(lines, push) {
      lines.forEach((ln, i) => {
        if (/text-align\s*:\s*center|\btext-center\b/.test(ln) && /\b(p|prose|body|paragraph|description)\b/i.test(ln)) {
          push({
            rule: 'centred-prose', severity: 'warn', line: i + 1, match: ln.trim().slice(0, 120),
            why: 'Centred body copy gives the eye no consistent left edge to return to.',
            fix: 'Centre headlines if you like. Range body copy left.',
          });
        }
      });
    },
  },
  {
    name: 'default-tailwind-card',
    run(lines, push) {
      lines.forEach((ln, i) => {
        if (/rounded-(lg|xl|2xl)/.test(ln) && /shadow-(md|lg|xl)/.test(ln) && /bg-white|bg-gray-50|bg-slate-50/.test(ln)) {
          push({
            rule: 'default-tailwind-card', severity: 'warn', line: i + 1, match: ln.trim().slice(0, 120),
            why: 'rounded-xl + shadow-lg + bg-white is the default card every agent reaches for.',
            fix: 'Decide the radius, elevation and surface from your profile instead of taking the defaults.',
          });
        }
      });
    },
  },
];

/**
 * Lint source for slop. Deterministic — same input always yields same output.
 * @param {string} src
 * @param {{rules?:string[]}} [opts] restrict to a subset of rule names
 * @returns {{findings:Finding[], score:number, counts:{error:number,warn:number}}}
 */
export function deslop(src, opts = {}) {
  if (typeof src !== 'string') throw new TypeError('deslop() needs a string');
  const lines = src.split('\n');
  const findings = [];
  const push = f => findings.push(f);
  for (const rule of RULES) {
    if (opts.rules && !opts.rules.includes(rule.name)) continue;
    rule.run(lines, push, src);
  }
  findings.sort((a, b) => (a.severity === b.severity ? a.line - b.line : a.severity === 'error' ? -1 : 1));

  const counts = {
    error: findings.filter(f => f.severity === 'error').length,
    warn: findings.filter(f => f.severity === 'warn').length,
  };
  // 100 is clean. Errors bite harder than warnings, and the floor is 0.
  const score = Math.max(0, 100 - counts.error * 14 - counts.warn * 6);
  return { findings, score, counts };
}

export const RULE_NAMES = RULES.map(r => r.name);

/** Render a lint result as the compact markdown an agent reads back. */
export function formatReport(result, label = 'input') {
  if (!result.findings.length) return `**${label}** — clean. Slop score 100/100.`;
  const rows = result.findings
    .map(f => `- \`${f.severity === 'error' ? '!' : '?'}\` **line ${f.line}** · ${f.rule}\n  - ${f.why}\n  - **Fix:** ${f.fix}\n  - \`${f.match}\``)
    .join('\n');
  return `**${label}** — slop score ${result.score}/100 (${result.counts.error} errors, ${result.counts.warn} warnings)\n\n${rows}`;
}
