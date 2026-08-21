# Skulpt

Taste capture and de-slopping for coding agents.

The swipe deck is the free demo. The MCP server is the product: it checks every
UI file your agent writes against the patterns that mark output as machine-made,
and rewrites what it gets wrong.

```
index.html        marketing lander      -> GitHub Pages
app/index.html    the product           -> GitHub Pages
shared/           taste engine + linter -> imported by both browser and server
server/           API + MCP             -> Railway
```

`shared/` is imported unmodified by the browser and the server, so the taste
maths can't drift between what a user swipes and what their agent receives.

## Why the swipe alone isn't enough

Wu et al. ([arXiv:2509.16779](https://arxiv.org/html/2509.16779), CHI 2026)
compared feedback modalities for improving UI generation across 1,460
annotations from 21 professional designers:

| Modality | Inter-rater agreement | Model Elo |
| --- | --- | --- |
| Revising | 76.1% | 1026 |
| Sketching | 63.6% | 1054 |
| Commenting | 57.3% | no improvement |
| Ranking (binary swipe) | 49.2% — near random | no improvement |

Binary ranking is fast but close to noise: it captures judgements about existing
UIs rather than the changes a designer would make. So a Love in Skulpt opens a
one-tap nudge — *bolder, quieter, warmer, tighter, looser, flatter* — which is a
micro-revision. `NUDGE_STEP` is weighted well above the swipe learning rate for
exactly this reason.

## The de-slopper

Detection is deterministic (`shared/deslop.js`) — no model, no latency, same
answer every run, so an agent can call it on every file without thinking about
cost. The model is only asked to do the rewrite, where judgement is required.

Eleven rules, drawn from [Impeccable](https://github.com/pbakaus/impeccable)'s
anti-pattern list plus the tells we see most: banned fonts (Inter, Arial,
Roboto…), pure `#000`/`#fff`, untinted greys and shadows, nested cards, bounce
easing, the purple-to-blue gradient, default Tailwind cards, centred prose,
emoji as icons, bare system font stacks.

Both pages in this repo score 100/100 against it. That is enforced by tests.

## MCP tools

| Tool | Plan | Model call |
| --- | --- | --- |
| `get_taste_profile` | free | no |
| `get_design_tokens` | free | no |
| `deslop_check` | free | no |
| `deslop_rewrite` | pro | yes |
| `review_url` | pro | no |

Resources: `skulpt://taste/profile`, `skulpt://taste/anti-patterns`.

Install (HTTP transport — no local process, no npx):

```bash
claude mcp add --transport http skulpt https://<your-api>/mcp \
  --header "Authorization: Bearer skmcp_..."
```

## Running it

```bash
npm install
npm test                      # 30 tests, no database needed
DATABASE_URL=postgres://... npm run dev
```

Without `RESEND_API_KEY`, magic links print to the server console.
Without `ANTHROPIC_API_KEY`, `deslop_rewrite` refuses and everything else works.

`SKULPT_MODEL` defaults to `claude-fable-5`. Note that Fable 5 is **$10/$50 per
MTok — twice Opus 5's $5/$25**; set `SKULPT_MODEL=claude-opus-5` to halve the
rewrite cost.

## Deliberate limitations

- Site analysis is regex over fetched CSS, not a headless browser. ~300ms
  instead of ~4s, at the cost of missing runtime-computed styles.
- No billing. `users.plan` is a column; set it to `'pro'` by hand.
- Schema is `CREATE TABLE IF NOT EXISTS` on boot, not migrations.
- `nested-card` detection is textual, so it sees `class="card"`, not a
  styled-component that happens to render one.
