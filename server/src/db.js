// Postgres access. No ORM: the whole schema is six tables and a dozen queries,
// and a migration tool would be more code than the thing it migrates.
// ponytail: CREATE TABLE IF NOT EXISTS on boot — swap for real migrations the
// first time a column needs changing under live traffic.

import postgres from 'postgres';
import { randomBytes, createHash } from 'node:crypto';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is not set. Add the Postgres plugin in Railway.');

export const sql = postgres(url, {
  ssl: url.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 8,
  idle_timeout: 20,
});

export async function migrate() {
  await sql`create table if not exists users (
    id           bigserial primary key,
    email        text unique not null,
    plan         text not null default 'free',
    created_at   timestamptz not null default now()
  )`;
  await sql`create table if not exists magic_tokens (
    hash         text primary key,
    email        text not null,
    expires_at   timestamptz not null,
    used_at      timestamptz
  )`;
  // One token type does double duty: browser session and MCP key. Fewer
  // concepts, and revoking access revokes it everywhere at once.
  await sql`create table if not exists tokens (
    hash         text primary key,
    user_id      bigint not null references users(id) on delete cascade,
    kind         text not null default 'session',
    label        text,
    created_at   timestamptz not null default now(),
    last_used_at timestamptz,
    revoked_at   timestamptz
  )`;
  await sql`create table if not exists sites (
    id           bigserial primary key,
    user_id      bigint not null references users(id) on delete cascade,
    url          text not null,
    host         text not null,
    title        text,
    axes         jsonb not null,
    evidence     jsonb,
    created_at   timestamptz not null default now()
  )`;
  await sql`create table if not exists profiles (
    id           bigserial primary key,
    user_id      bigint not null references users(id) on delete cascade,
    site_id      bigint references sites(id) on delete set null,
    vector       jsonb not null,
    swipes       int not null default 0,
    updated_at   timestamptz not null default now()
  )`;
  await sql`create table if not exists swipes (
    id           bigserial primary key,
    profile_id   bigint not null references profiles(id) on delete cascade,
    card_id      text not null,
    axes         jsonb not null,
    verdict      text not null,
    nudge        text,
    created_at   timestamptz not null default now()
  )`;
  await sql`create index if not exists tokens_user on tokens(user_id) where revoked_at is null`;
  await sql`create index if not exists profiles_user on profiles(user_id)`;
  await sql`create index if not exists magic_expiry on magic_tokens(expires_at)`;
}

// --- tokens ---------------------------------------------------------------
// Only hashes are stored. A database dump must not hand over live credentials.

const hash = t => createHash('sha256').update(t).digest('hex');
const mint = (prefix) => `${prefix}_${randomBytes(24).toString('base64url')}`;

export async function createMagicToken(email) {
  const token = mint('ml');
  await sql`insert into magic_tokens ${sql({
    hash: hash(token), email, expires_at: new Date(Date.now() + 20 * 60_000),
  })}`;
  return token;
}

/** Single-use and time-bounded. Returns the email, or null. */
export async function consumeMagicToken(token) {
  const [row] = await sql`
    update magic_tokens set used_at = now()
    where hash = ${hash(token)} and used_at is null and expires_at > now()
    returning email`;
  return row?.email ?? null;
}

// ponytail: no billing yet, so an env allowlist IS the plan mechanism.
// Replace with a webhook from the payment provider when one exists.
const PRO = (process.env.SKULPT_PRO_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

export async function applyProAllowlist() {
  if (!PRO.length) return 0;
  const rows = await sql`update users set plan = 'pro'
                         where email = any(${PRO}) and plan <> 'pro' returning email`;
  return rows.length;
}

export async function upsertUser(email) {
  const clean = email.toLowerCase().trim();
  const [u] = await sql`
    insert into users (email, plan) values (${clean}, ${PRO.includes(clean) ? 'pro' : 'free'})
    on conflict (email) do update set plan = case
      when ${PRO.includes(clean)} then 'pro' else users.plan end
    returning *`;
  return u;
}

export async function issueToken(userId, kind = 'session', label = null) {
  const token = mint(kind === 'mcp' ? 'skmcp' : 'sk');
  await sql`insert into tokens ${sql({ hash: hash(token), user_id: userId, kind, label })}`;
  return token;
}

export async function userForToken(token) {
  if (!token) return null;
  const [row] = await sql`
    update tokens set last_used_at = now()
    where hash = ${hash(token)} and revoked_at is null
    returning user_id, kind`;
  if (!row) return null;
  const [user] = await sql`select * from users where id = ${row.user_id}`;
  return user ? { ...user, tokenKind: row.kind } : null;
}

export async function listMcpKeys(userId) {
  return sql`select label, created_at, last_used_at from tokens
             where user_id = ${userId} and kind = 'mcp' and revoked_at is null
             order by created_at desc`;
}

export async function revokeToken(userId, label) {
  return sql`update tokens set revoked_at = now()
             where user_id = ${userId} and kind = 'mcp' and label = ${label} and revoked_at is null`;
}

// --- sites & profiles -----------------------------------------------------

export async function saveSite(userId, site) {
  const [row] = await sql`insert into sites ${sql({
    user_id: userId, url: site.url, host: site.host, title: site.title,
    axes: site.axes, evidence: site.evidence ?? {},
  })} returning *`;
  return row;
}

export async function createProfile(userId, siteId, vector) {
  const [row] = await sql`insert into profiles ${sql({
    user_id: userId, site_id: siteId, vector,
  })} returning *`;
  return row;
}

export async function getProfile(userId, profileId) {
  const [row] = profileId
    ? await sql`select * from profiles where id = ${profileId} and user_id = ${userId}`
    : await sql`select * from profiles where user_id = ${userId} order by updated_at desc limit 1`;
  return row ?? null;
}

export async function profileWithSite(userId, profileId) {
  const p = await getProfile(userId, profileId);
  if (!p) return null;
  const [site] = p.site_id ? await sql`select * from sites where id = ${p.site_id}` : [null];
  return { ...p, site: site ?? null };
}

export async function recordSwipe(profile, card, verdict, nudge, nextVector) {
  return sql.begin(async tx => {
    await tx`insert into swipes ${tx({
      profile_id: profile.id, card_id: card.id, axes: card.axes, verdict, nudge: nudge ?? null,
    })}`;
    const [row] = await tx`update profiles
      set vector = ${tx.json(nextVector)}, swipes = swipes + 1, updated_at = now()
      where id = ${profile.id} returning *`;
    return row;
  });
}

export async function resetProfile(profileId, vector) {
  await sql`delete from swipes where profile_id = ${profileId}`;
  const [row] = await sql`update profiles set vector = ${sql.json(vector)}, swipes = 0, updated_at = now()
                          where id = ${profileId} returning *`;
  return row;
}
