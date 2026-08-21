// The Skulpt MCP server — the paid surface.
//
// Division of labour: detection is deterministic (deslop.js, no model, no
// latency, identical every run), and the model is only asked to do the part
// that needs judgement — rewriting. An agent can call deslop_check on every
// file it writes without thinking about cost.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import Anthropic from '@anthropic-ai/sdk';

import { compile, exportAs, confidence, ANTI_PATTERNS } from '../../shared/taste.js';
import { deslop, formatReport, RULE_NAMES } from '../../shared/deslop.js';
import { extractSite, ExtractError } from './extract.js';

const MODEL = process.env.SKULPT_MODEL || 'claude-fable-5';
const anthropic = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;

const text = t => ({ content: [{ type: 'text', text: t }] });
const fail = t => ({ content: [{ type: 'text', text: t }], isError: true });

const PAID = 'This tool is part of the Skulpt Pro plan. Upgrade at https://goskulpt.com/pricing — deslop_check and get_taste_profile stay available on the free plan.';

/**
 * @param {{user:object, loadProfile:() => Promise<object|null>}} ctx
 */
export function createServer(ctx) {
  const server = new McpServer({ name: 'skulpt', version: '1.0.0' });
  const pro = () => ctx.user?.plan === 'pro';

  const profileOr404 = async () => {
    const p = await ctx.loadProfile();
    if (!p) throw new Error('No taste profile yet. Train one at https://goskulpt.com — it takes about a minute.');
    return p;
  };

  // -- free ---------------------------------------------------------------

  server.registerTool('get_taste_profile', {
    title: 'Get taste profile',
    description: 'Load the design direction this user trained on Skulpt. Call this BEFORE writing or editing any UI, and follow its hard constraints — they override your defaults.',
    inputSchema: {
      format: z.enum(['md', 'claude', 'cursor', 'codex', 'json']).default('md')
        .describe('Envelope for the brief. "md" for direct reading.'),
    },
  }, async ({ format }) => {
    const p = await profileOr404();
    const out = exportAs(p.vector, format, { swipes: p.swipes, site: p.site?.host });
    return text(out.body);
  });

  server.registerTool('deslop_check', {
    title: 'Check for AI-generated design tells',
    description: 'Lint HTML, CSS, JSX or Tailwind for the patterns that mark UI as machine-generated: banned fonts, pure black/white, untinted greys and shadows, nested cards, bounce easing, purple-to-blue gradients, default Tailwind cards. Deterministic and instant — run it on every UI file you write, before you show the user.',
    inputSchema: {
      code: z.string().min(1).max(400_000).describe('The source to check.'),
      label: z.string().optional().describe('Filename, for the report.'),
      rules: z.array(z.enum(RULE_NAMES)).optional().describe('Restrict to a subset of rules.'),
    },
  }, async ({ code, label, rules }) => {
    const r = deslop(code, rules ? { rules } : {});
    return text(formatReport(r, label || 'input'));
  });

  server.registerTool('get_design_tokens', {
    title: 'Get design tokens',
    description: 'The user\'s taste as machine-readable tokens plus the raw 14-axis vector. Use when you need concrete values rather than prose.',
    inputSchema: {},
  }, async () => {
    const p = await profileOr404();
    return text(exportAs(p.vector, 'json', { swipes: p.swipes }).body);
  });

  // -- pro ----------------------------------------------------------------

  server.registerTool('deslop_rewrite', {
    title: 'Rewrite to match the user\'s taste',
    description: 'Rewrite UI code so it satisfies every hard constraint and matches the user\'s trained taste. Returns code only. Use after deslop_check reports findings you cannot fix mechanically.',
    inputSchema: {
      code: z.string().min(1).max(120_000).describe('The source to rewrite.'),
      language: z.string().default('html').describe('html, css, jsx, tsx, vue, svelte'),
      intent: z.string().optional().describe('What this UI is for, if it is not obvious from the code.'),
    },
  }, async ({ code, language, intent }) => {
    if (!pro()) return fail(PAID);
    if (!anthropic) return fail('ANTHROPIC_API_KEY is not configured on this Skulpt instance.');

    const p = await profileOr404();
    const before = deslop(code);
    const brief = compile(p.vector, { swipes: p.swipes, site: p.site?.host });

    const system = `You rewrite user interface code so it stops looking machine-generated.

You are given a design brief the user trained themselves, and a lint report of
what is currently wrong. Apply the brief. Fix every finding. Change nothing
about the markup's behaviour, structure, accessibility, or content — this is a
restyle, not a redesign.

Return ONLY the rewritten code. No preamble, no explanation, no code fence.`;

    const res = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 32000,
      betas: ['server-side-fallback-2026-06-01'],
      fallbacks: [{ model: 'claude-opus-4-8' }],
      system,
      output_config: { effort: 'medium' },
      messages: [{
        role: 'user',
        content: `${brief}\n\n## Lint findings to fix\n\n${formatReport(before)}\n\n## Intent\n\n${intent || 'not stated'}\n\n## Code (${language})\n\n${code}`,
      }],
    });

    if (res.stop_reason === 'refusal') {
      return fail(`The model declined this rewrite (${res.stop_details?.category ?? 'unspecified'}).`);
    }
    const out = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim()
      .replace(/^```[a-z]*\n?/i, '').replace(/```$/, '');

    const after = deslop(out);
    return text(`${out}\n\n<!-- skulpt: slop score ${before.score} -> ${after.score}. ${before.findings.length - after.findings.length} findings resolved. -->`);
  });

  server.registerTool('review_url', {
    title: 'Review a live page',
    description: 'Fetch a URL and report how far its design sits from the user\'s taste, plus any slop in its stylesheets.',
    inputSchema: { url: z.string().min(4).describe('Public http(s) URL.') },
  }, async ({ url }) => {
    if (!pro()) return fail(PAID);
    const p = await profileOr404();
    try {
      const site = await extractSite(url);
      const drift = Object.entries(site.axes)
        .map(([a, v]) => ({ a, gap: v - p.vector[a] }))
        .sort((x, y) => Math.abs(y.gap) - Math.abs(x.gap))
        .slice(0, 5)
        .map(d => `- **${d.a}** is ${Math.abs(d.gap) > 0.3 ? 'well' : 'slightly'} ${d.gap > 0 ? 'above' : 'below'} your taste (${d.gap > 0 ? '+' : ''}${d.gap.toFixed(2)})`)
        .join('\n');
      return text(`# ${site.title}\n\n${site.host}\n\n## Biggest gaps from your taste\n\n${drift}\n\n## Detected\n\n\`\`\`json\n${JSON.stringify(site.evidence, null, 2)}\n\`\`\``);
    } catch (e) {
      return fail(e instanceof ExtractError ? e.message : `Could not review that URL: ${e.message}`);
    }
  });

  // -- resource -----------------------------------------------------------

  server.registerResource('taste-profile', 'skulpt://taste/profile', {
    title: 'Skulpt taste profile',
    description: 'The user\'s compiled design direction.',
    mimeType: 'text/markdown',
  }, async uri => {
    const p = await profileOr404();
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'text/markdown',
        text: compile(p.vector, { swipes: p.swipes, site: p.site?.host }),
      }],
    };
  });

  server.registerResource('anti-patterns', 'skulpt://taste/anti-patterns', {
    title: 'Hard constraints',
    description: 'The non-negotiable rules, independent of any trained profile.',
    mimeType: 'text/markdown',
  }, async uri => ({
    contents: [{
      uri: uri.href, mimeType: 'text/markdown',
      text: `# Hard constraints\n\n${ANTI_PATTERNS.map(p => `- ${p}`).join('\n')}\n`,
    }],
  }));

  return server;
}

export { confidence };
