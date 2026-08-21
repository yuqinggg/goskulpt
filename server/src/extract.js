// Read a real site and estimate where it already sits on the 14 axes, so the
// first cards a user sees are recognisably variants of their own product
// rather than stock inspiration.
//
// No headless browser. A fetch plus a regex pass over the stylesheets gets us
// close enough to seed a deck, and it runs in ~300ms instead of ~4s.
// ponytail: no CSS AST — upgrade to one only if the token estimates prove noisy.

import { AXES } from '../../shared/taste.js';

const UA = 'Mozilla/5.0 (compatible; SkulptBot/1.0; +https://goskulpt.com)';
const MAX_BYTES = 2_000_000;
const TIMEOUT_MS = 8000;

export class ExtractError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

/** Only ever fetch public http(s). Blocks the obvious SSRF targets. */
export function assertPublicUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) throw new ExtractError('That does not look like a URL.');
  const trimmed = raw.trim();

  // Reject a foreign scheme outright. Prefixing "https://" onto "file:///x"
  // yields the perfectly valid https://file///x, which sails past a protocol
  // check made after the fact.
  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):/i);
  if (scheme && !/^https?$/i.test(scheme[1])) {
    throw new ExtractError('Only http and https URLs are supported.');
  }

  let u;
  try { u = new URL(scheme ? trimmed : `https://${trimmed}`); }
  catch { throw new ExtractError('That does not look like a URL.'); }

  if (!/^https?:$/.test(u.protocol)) throw new ExtractError('Only http and https URLs are supported.');
  if (!u.hostname.includes('.')) throw new ExtractError('That does not look like a public hostname.');
  const h = u.hostname.toLowerCase();
  const blocked = h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal')
    || /^(127|10)\./.test(h)
    || /^192\.168\./.test(h)
    || /^169\.254\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || h === '0.0.0.0' || h === '::1' || h.startsWith('[');
  if (blocked) throw new ExtractError('That host is not reachable from Skulpt.');
  return u;
}

async function get(url, signal) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,text/css,*/*' }, signal, redirect: 'follow' });
  if (!res.ok) throw new ExtractError(`Site returned ${res.status}.`, 502);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_BYTES) throw new ExtractError('That page is too large to analyse.', 413);
  return (await res.text()).slice(0, MAX_BYTES);
}

// --- token scraping -------------------------------------------------------

const hexes = css => [...css.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)].map(m => m[1]);

function toRgb(h) {
  const e = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  return [parseInt(e.slice(0, 2), 16), parseInt(e.slice(2, 4), 16), parseInt(e.slice(4, 6), 16)];
}

function hsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return [s, l];
}

const median = a => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

const SERIF_HINTS = /(serif|georgia|garamond|times|playfair|fraunces|newsreader|lora|merriweather|instrument serif)/i;
const GEOMETRIC_HINTS = /(grotesk|futura|poppins|montserrat|circular|geist|archivo|chivo|gilroy)/i;

/**
 * @returns {{axes:object, evidence:object}} axes are 0..1, ready to seed a deck
 */
export function analyse(html, css) {
  const all = `${html}\n${css}`;
  const ev = {};

  // colour -------------------------------------------------------------
  const cols = hexes(css).map(toRgb).map(hsl);
  const sats = cols.map(c => c[0]).filter(s => s > 0.02);
  const lums = cols.map(c => c[1]);
  ev.colours = cols.length;
  const saturation = sats.length ? Math.min(1, (median(sats) ?? 0.3) * 1.5) : 0.3;
  // Dark mode if the bulk of declared colours are dark.
  const darkShare = lums.length ? lums.filter(l => l < 0.35).length / lums.length : 0;
  const mode = Math.min(1, darkShare * 1.4);
  const spread = lums.length > 1 ? Math.max(...lums) - Math.min(...lums) : 0.5;
  const contrast = Math.min(1, spread * 1.1);

  // shape ---------------------------------------------------------------
  const radii = [...css.matchAll(/border-radius\s*:\s*([\d.]+)(px|rem)/gi)]
    .map(m => Number(m[1]) * (m[2] === 'rem' ? 16 : 1))
    .filter(n => n > 0 && n < 200);
  ev.radius = median(radii);
  const radius = radii.length ? Math.min(1, (median(radii) ?? 8) / 26) : 0.4;

  // type ----------------------------------------------------------------
  const fams = [...css.matchAll(/font-family\s*:\s*([^;}]+)/gi)].map(m => m[1]).join(' ');
  ev.fonts = [...new Set([...fams.matchAll(/["']([^"']{2,32})["']/g)].map(m => m[1]))].slice(0, 6);
  const typeStyle = SERIF_HINTS.test(fams) ? 0.85 : GEOMETRIC_HINTS.test(fams) ? 0.15 : 0.5;
  const weights = [...css.matchAll(/font-weight\s*:\s*(\d{3})/g)].map(m => Number(m[1]));
  ev.weight = median(weights);
  const typeWeight = weights.length ? Math.min(1, Math.max(0, ((median(weights) ?? 500) - 300) / 500)) : 0.5;

  // surface -------------------------------------------------------------
  const shadows = (css.match(/box-shadow\s*:\s*(?!none)/gi) || []).length;
  ev.shadows = shadows;
  const depth = Math.min(1, shadows / 12);
  const grads = (css.match(/linear-gradient|radial-gradient|conic-gradient/gi) || []).length;
  ev.gradients = grads;
  const gradient = Math.min(1, grads / 6);
  const texture = /noise|grain|texture|\.png\)|feTurbulence/i.test(all) ? 0.6 : 0.2;

  // rhythm --------------------------------------------------------------
  const gaps = [...css.matchAll(/(?:gap|padding|margin)\s*:\s*([\d.]+)(px|rem)/gi)]
    .map(m => Number(m[1]) * (m[2] === 'rem' ? 16 : 1))
    .filter(n => n >= 2 && n < 200);
  ev.spacing = median(gaps);
  const spacing = gaps.length ? Math.min(1, (median(gaps) ?? 16) / 40) : 0.5;
  const density = 1 - spacing;

  const transitions = (css.match(/transition|@keyframes|animation\s*:/gi) || []).length;
  ev.motion = transitions;
  const motion = Math.min(1, transitions / 20);

  const ornament = Math.min(1, ((css.match(/border\s*:\s*(?!none|0)/gi) || []).length + (all.match(/<svg/gi) || []).length) / 25);
  const playfulness = Math.min(1, saturation * 0.5 + (radius > 0.6 ? 0.3 : 0) + (grads ? 0.2 : 0));

  const axes = { density, radius, saturation, contrast, mode, typeWeight, typeStyle, spacing, ornament, gradient, depth, motion, playfulness, texture };
  // Guard: a bad parse must not emit NaN into the taste vector.
  for (const a of AXES) {
    const v = axes[a];
    axes[a] = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0.5;
  }
  return { axes, evidence: ev };
}

/** Fetch a site and estimate its design tokens. */
export async function extractSite(rawUrl) {
  const url = assertPublicUrl(rawUrl);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const html = await get(url.href, ac.signal);

    // Inline styles plus up to four linked sheets — enough signal, bounded cost.
    let css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
    const links = [...html.matchAll(/<link[^>]+href=["']([^"']+\.css[^"']*)["']/gi)].map(m => m[1]).slice(0, 4);
    const sheets = await Promise.allSettled(links.map(h => get(new URL(h, url).href, ac.signal)));
    css += '\n' + sheets.filter(s => s.status === 'fulfilled').map(s => s.value).join('\n');

    const title = (html.match(/<title[^>]*>([^<]{1,120})</i) || [])[1]?.trim();
    const { axes, evidence } = analyse(html, css);
    return { url: url.href, host: url.hostname, title: title || url.hostname, axes, evidence, cssBytes: css.length };
  } catch (e) {
    if (e instanceof ExtractError) throw e;
    if (e.name === 'AbortError') throw new ExtractError('That site took too long to respond.', 504);
    throw new ExtractError(`Could not read that site: ${e.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}
