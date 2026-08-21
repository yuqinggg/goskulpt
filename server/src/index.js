import { serve } from '@hono/node-server';
import { RESPONSE_ALREADY_SENT } from '@hono/node-server/utils/response';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import * as db from './db.js';
import { extractSite, ExtractError } from './extract.js';
import { sendMagicLink } from './mail.js';
import { createServer } from './mcp.js';
import { neutral, makeDeck, applySwipe, exportAs, confidence, AXES, NUDGES } from '../../shared/taste.js';
import { deslop, formatReport } from '../../shared/deslop.js';

const APP_URL = process.env.APP_URL || 'https://yuqinggg.github.io/goskulpt';
const PORT = Number(process.env.PORT) || 8080;

const app = new Hono();

app.use('*', cors({
  origin: (o) => (!o || /github\.io$|goskulpt\.com$|^http:\/\/localhost:\d+$/.test(new URL(o).host) ? o : ''),
  allowHeaders: ['content-type', 'authorization', 'mcp-session-id', 'mcp-protocol-version'],
  exposeHeaders: ['mcp-session-id'],
  credentials: false,
}));

const bearer = c => (c.req.header('authorization') || '').replace(/^Bearer\s+/i, '') || null;

/** Attach the user when a token is present. Routes decide whether they need one. */
app.use('*', async (c, next) => {
  c.set('user', await db.userForToken(bearer(c)));
  await next();
});

const requireUser = async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'Sign in first.' }, 401);
  await next();
};

app.onError((err, c) => {
  if (err instanceof ExtractError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: 'Something broke on our side.' }, 500);
});

app.get('/health', c => c.json({ ok: true }));

// --- auth -----------------------------------------------------------------

const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/;

app.post('/auth/request', async c => {
  const { email } = await c.req.json().catch(() => ({}));
  if (!email || !EMAIL.test(email)) return c.json({ error: 'That is not a valid email address.' }, 400);

  const token = await db.createMagicToken(email.toLowerCase().trim());
  const link = `${new URL(c.req.url).origin}/auth/verify?token=${encodeURIComponent(token)}`;
  const { delivered } = await sendMagicLink(email, link);
  // Never reveal whether the address is already registered.
  return c.json({ ok: true, delivered });
});

app.get('/auth/verify', async c => {
  const email = await db.consumeMagicToken(c.req.query('token'));
  if (!email) return c.redirect(`${APP_URL}/app/#error=link_expired`);
  const user = await db.upsertUser(email);
  const token = await db.issueToken(user.id, 'session');
  return c.redirect(`${APP_URL}/app/#token=${encodeURIComponent(token)}`);
});

app.get('/me', requireUser, async c => {
  const u = c.get('user');
  const profile = await db.profileWithSite(u.id, null);
  return c.json({
    email: u.email, plan: u.plan,
    profile: profile && {
      id: profile.id, swipes: profile.swipes, vector: profile.vector,
      site: profile.site && { host: profile.site.host, title: profile.site.title },
      confidence: confidence(profile.vector, profile.swipes),
    },
  });
});

// --- site + deck ----------------------------------------------------------

app.post('/sites', requireUser, async c => {
  const { url } = await c.req.json().catch(() => ({}));
  if (!url) return c.json({ error: 'Send a url.' }, 400);

  const u = c.get('user');
  const site = await extractSite(url);          // throws ExtractError -> onError
  const row = await db.saveSite(u.id, site);
  // Seed the vector from the site itself so the first cards are recognisable.
  const profile = await db.createProfile(u.id, row.id, site.axes);
  return c.json({
    profile: { id: profile.id, swipes: 0, vector: profile.vector },
    site: { host: site.host, title: site.title, evidence: site.evidence },
    deck: makeDeck(site.axes, profile.vector, String(profile.id), 8, 0),
  });
});

app.get('/deck', requireUser, async c => {
  const p = await db.profileWithSite(c.get('user').id, c.req.query('profileId'));
  if (!p) return c.json({ error: 'No profile yet.' }, 404);
  const from = Number(c.req.query('from') || p.swipes);
  return c.json({ deck: makeDeck(p.site?.axes ?? neutral(), p.vector, String(p.id), 8, from) });
});

app.post('/swipe', requireUser, async c => {
  const { profileId, card, verdict, nudge } = await c.req.json().catch(() => ({}));
  if (!card?.axes || !verdict) return c.json({ error: 'Send card and verdict.' }, 400);
  if (nudge && !NUDGES[nudge]) return c.json({ error: `Unknown nudge: ${nudge}` }, 400);
  for (const a of AXES) {
    if (typeof card.axes[a] !== 'number') return c.json({ error: `Card is missing axis ${a}.` }, 400);
  }

  const p = await db.getProfile(c.get('user').id, profileId);
  if (!p) return c.json({ error: 'No profile yet.' }, 404);

  let next;
  try { next = applySwipe(p.vector, card.axes, verdict, nudge); }
  catch (e) { return c.json({ error: e.message }, 400); }

  const updated = await db.recordSwipe(p, card, verdict, nudge, next);
  return c.json({
    vector: updated.vector, swipes: updated.swipes,
    confidence: confidence(updated.vector, updated.swipes),
  });
});

app.post('/reset', requireUser, async c => {
  const { profileId } = await c.req.json().catch(() => ({}));
  const p = await db.getProfile(c.get('user').id, profileId);
  if (!p) return c.json({ error: 'No profile yet.' }, 404);
  const site = await db.profileWithSite(c.get('user').id, p.id);
  return c.json({ profile: await db.resetProfile(p.id, site.site?.axes ?? neutral()) });
});

// --- export ---------------------------------------------------------------

app.get('/export', requireUser, async c => {
  const format = c.req.query('format') || 'md';
  const p = await db.profileWithSite(c.get('user').id, c.req.query('profileId'));
  if (!p) return c.json({ error: 'No profile yet.' }, 404);
  let out;
  try { out = exportAs(p.vector, format, { swipes: p.swipes, site: p.site?.host }); }
  catch (e) { return c.json({ error: e.message }, 400); }

  c.header('content-type', `${out.mime}; charset=utf-8`);
  c.header('content-disposition', `attachment; filename="${out.filename}"`);
  return c.body(out.body);
});

// Free, unauthenticated taster: lint anything, no account needed. It is the
// cheapest possible demonstration that the paid tool does something real.
app.post('/deslop', async c => {
  const { code, label } = await c.req.json().catch(() => ({}));
  if (typeof code !== 'string' || !code.length) return c.json({ error: 'Send code as a string.' }, 400);
  if (code.length > 400_000) return c.json({ error: 'That is too large to lint.' }, 413);
  const r = deslop(code);
  return c.json({ ...r, report: formatReport(r, label || 'input') });
});

// --- MCP keys -------------------------------------------------------------

app.get('/keys', requireUser, async c => c.json({ keys: await db.listMcpKeys(c.get('user').id) }));

app.post('/keys', requireUser, async c => {
  const { label } = await c.req.json().catch(() => ({}));
  const u = c.get('user');
  const name = (label || 'default').slice(0, 40);
  const token = await db.issueToken(u.id, 'mcp', name);
  // Shown once. Only the hash is stored.
  return c.json({ label: name, token });
});

app.delete('/keys/:label', requireUser, async c => {
  await db.revokeToken(c.get('user').id, c.req.param('label'));
  return c.json({ ok: true });
});

// --- MCP transport --------------------------------------------------------
// Stateless: one server + transport per request. Keeps Railway free to scale
// horizontally without sticky sessions.

app.all('/mcp', async c => {
  const user = c.get('user');
  if (!user) {
    return c.json({
      jsonrpc: '2.0', id: null,
      error: { code: -32001, message: 'Unauthorized. Set your Skulpt key as a Bearer token — get one at https://goskulpt.com/app.' },
    }, 401);
  }

  const server = createServer({
    user,
    loadProfile: () => db.profileWithSite(user.id, null),
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  const { incoming, outgoing } = c.env;
  outgoing.on('close', () => { transport.close(); server.close(); });

  const body = c.req.method === 'POST' ? await c.req.json().catch(() => undefined) : undefined;
  await server.connect(transport);
  await transport.handleRequest(incoming, outgoing, body);
  // The transport owns the response from here.
  // The MCP transport wrote to the raw Node response itself.
  return RESPONSE_ALREADY_SENT;
});

await db.migrate();
serve({ fetch: app.fetch, port: PORT }, info => {
  console.log(`skulpt api on :${info.port}`);
  if (!process.env.ANTHROPIC_API_KEY) console.warn('  ANTHROPIC_API_KEY unset — deslop_rewrite will refuse.');
  if (!process.env.RESEND_API_KEY) console.warn('  RESEND_API_KEY unset — magic links print to this console.');
});
