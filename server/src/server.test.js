// node --test server/src/server.test.js
// Covers everything that does not need Postgres: URL safety, token extraction,
// and the MCP surface driven end-to-end over an in-memory transport.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { assertPublicUrl, analyse, ExtractError } from './extract.js';
import { createServer } from './mcp.js';
import { neutral, AXES } from '../../shared/taste.js';

// --- SSRF ------------------------------------------------------------------

test('rejects hosts that could reach our own network', () => {
  const bad = ['http://localhost:8080', 'http://127.0.0.1', 'http://10.1.2.3', 'http://192.168.0.1',
    'http://169.254.169.254/latest/meta-data/', 'http://172.16.9.9', 'https://foo.internal',
    'file:///etc/passwd', 'ftp://example.com', 'not a url'];
  for (const u of bad) assert.throws(() => assertPublicUrl(u), ExtractError, u);
});

test('accepts public URLs and defaults the scheme', () => {
  assert.equal(assertPublicUrl('example.com').href, 'https://example.com/');
  assert.equal(assertPublicUrl('http://example.com/a').protocol, 'http:');
});

// --- extraction ------------------------------------------------------------

test('analyse always returns 14 finite axes in range, even on junk', () => {
  for (const [html, css] of [['', ''], ['<p>hi', 'body{}'], ['<x>', 'color:;;{{']]) {
    const { axes } = analyse(html, css);
    assert.deepEqual(Object.keys(axes).sort(), [...AXES].sort());
    for (const a of AXES) {
      assert.ok(Number.isFinite(axes[a]) && axes[a] >= 0 && axes[a] <= 1, `${a}=${axes[a]}`);
    }
  }
});

test('reads the obvious signals off a stylesheet', () => {
  const dark = analyse('', `body{background:#111318;color:#e8e8ea}.a{background:#1a1d24}.b{color:#0d0f14}`).axes;
  assert.ok(dark.mode > 0.5, `expected dark, got ${dark.mode}`);

  const round = analyse('', `.a{border-radius:24px}.b{border-radius:20px}.c{border-radius:28px}`).axes;
  assert.ok(round.radius > 0.6, `expected round, got ${round.radius}`);

  const serif = analyse('', `h1{font-family:"Playfair Display",Georgia,serif}`).axes;
  assert.ok(serif.typeStyle > 0.6);

  const flat = analyse('', `.a{color:#333}`).axes;
  assert.equal(flat.depth, 0, 'no shadows declared means no depth');
});

// --- MCP -------------------------------------------------------------------

async function connect(plan = 'pro', profile = { vector: neutral(), swipes: 20, site: { host: 'example.com' } }) {
  const server = createServer({ user: { id: 1, plan }, loadProfile: async () => profile });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  return { client, server };
}

test('exposes the expected tools and resources', async () => {
  const { client } = await connect();
  const tools = (await client.listTools()).tools.map(t => t.name).sort();
  assert.deepEqual(tools, ['deslop_check', 'deslop_rewrite', 'get_design_tokens', 'get_taste_profile', 'review_url']);
  const res = (await client.listResources()).resources.map(r => r.uri).sort();
  assert.deepEqual(res, ['skulpt://taste/anti-patterns', 'skulpt://taste/profile']);
});

test('get_taste_profile returns a brief in every format', async () => {
  const { client } = await connect();
  for (const format of ['md', 'claude', 'cursor', 'codex', 'json']) {
    const r = await client.callTool({ name: 'get_taste_profile', arguments: { format } });
    assert.ok(!r.isError, format);
    assert.ok(r.content[0].text.length > 200, format);
  }
});

test('deslop_check finds real slop and stays quiet on clean code', async () => {
  const { client } = await connect('free');   // free plan still gets this
  const dirty = await client.callTool({
    name: 'deslop_check',
    arguments: { code: `.a{font-family:Inter;color:#000}`, label: 'a.css' },
  });
  assert.ok(!dirty.isError);
  assert.match(dirty.content[0].text, /banned-font/);
  assert.match(dirty.content[0].text, /pure-neutral/);

  const clean = await client.callTool({
    name: 'deslop_check',
    arguments: { code: `.a{font-family:'Space Grotesk';color:hsl(210 8% 12%)}` },
  });
  assert.match(clean.content[0].text, /clean/);
});

test('pro tools refuse on the free plan and are reachable on pro', async () => {
  const free = await connect('free');
  for (const name of ['deslop_rewrite', 'review_url']) {
    const args = name === 'review_url' ? { url: 'https://example.com' } : { code: '.a{}', language: 'css' };
    const r = await free.client.callTool({ name, arguments: args });
    assert.ok(r.isError, `${name} should be gated`);
    assert.match(r.content[0].text, /Pro plan/);
  }
  // On pro the gate is passed; without an API key it fails for a different reason.
  const pro = await connect('pro');
  const r = await pro.client.callTool({ name: 'deslop_rewrite', arguments: { code: '.a{}', language: 'css' } });
  if (r.isError) assert.doesNotMatch(r.content[0].text, /Pro plan/, 'pro user was still gated');
});

test('an untrained user gets a useful error, not a crash', async () => {
  const server = createServer({ user: { id: 1, plan: 'pro' }, loadProfile: async () => null });
  const client = new Client({ name: 'test', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  const r = await client.callTool({ name: 'get_taste_profile', arguments: { format: 'md' } });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /No taste profile yet/);
});

test('the profile resource renders the brief', async () => {
  const { client } = await connect();
  const r = await client.readResource({ uri: 'skulpt://taste/profile' });
  assert.match(r.contents[0].text, /Hard constraints/);
  const a = await client.readResource({ uri: 'skulpt://taste/anti-patterns' });
  assert.match(a.contents[0].text, /Never use Inter/);
});

test('deslop_check rejects oversized input at the schema boundary', async () => {
  const { client } = await connect();
  // The SDK reports schema violations as an error result, not a thrown rejection.
  const r = await client.callTool({ name: 'deslop_check', arguments: { code: 'x'.repeat(400_001) } });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /validation error/i);
});
