/**
 * Adversarial + fire-rate validation for the date-grounding retry
 * (src/distill/ground-dates.ts), run against the REAL codex-subscription
 * provider — not a mock. The whole premise of this module (vs. PR #257's
 * closed-unmerged regex rewrite) is that an LLM can read a full sentence
 * and decide whether a relative-date phrase attaches to the session's own
 * timeline or to a different noun's — a mock canned-response double cannot
 * demonstrate that judgment; only a live call can.
 *
 * Usage: bun scripts/eval/date-grounding-retry-adversarial.mts
 * Requires: `codex login` already done (~/.codex/auth.json present). Uses
 * the cheap-tier default model — no GPU/Ollama involved, does not contend
 * with any local extraction bench.
 */

import { CodexSubscriptionLLMProvider } from '../../src/providers/llm/codex-subscription.js';
import { groundAtomDates, hasUnresolvedRelativeDate } from '../../src/distill/ground-dates.js';
import type { ReducedAtom } from '../../src/distill/stages/06-reduce.js';

const SESSION_DATE = '2023-07-15';

function atom(text: string): ReducedAtom {
  return { type: 'fact', text, importance: 0.5, confidence: 0.8, contentHash: 'x' };
}

// The three PR #257 fabrication classes (round 1: "of <noun>" continuation;
// round 2: Saxon genitive / "before" / "for" re-anchoring — folded together
// here since round 1's cases are a strict subset of what round 2's allowlist
// also had to hold), plus round 3's pronoun-possessive class, plus the two
// extra adversarial shapes the team-lead handoff specified, plus one
// genuinely session-relative case that MUST resolve.
const CASES: Array<{ label: string; text: string; mustResolve: boolean }> = [
  {
    label: 'FABRICATION CLASS 1 (round 1, "of <noun>")',
    text: 'Caroline described the last week of the project as extremely stressful.',
    mustResolve: false,
  },
  {
    label: 'FABRICATION CLASS 2 (round 2, Saxon genitive)',
    text: "The project's last week's numbers were the worst on record.",
    mustResolve: false,
  },
  {
    label: 'FABRICATION CLASS 3 (round 3, pronoun possessive)',
    text: 'Her last week was overwhelming.',
    mustResolve: false,
  },
  {
    label: 'ADVERSARIAL — re-anchoring preposition',
    text: 'The last week before the launch was chaos.',
    mustResolve: false,
  },
  {
    label: 'ADVERSARIAL — adjective interposition',
    text: "The team's exhausting last month was finally over.",
    mustResolve: false,
  },
  {
    label: 'MUST RESOLVE — genuinely session-relative',
    text: 'I saw her last week.',
    mustResolve: true,
  },
];

// A sample of atoms approximating a realistic mixed batch, to state a fire
// rate with a real denominator (team-lead ask: "measure the fire rate; it
// should be ~10-15% of temporal atoms, not 100% of all atoms").
const FIRE_RATE_SAMPLE: string[] = [
  'Caroline lives in Berlin.',
  'Melanie painted a sunset over a lake last year.',
  'Caroline attended an LGBTQ support group yesterday, which she found meaningful.',
  'Melanie signed up for a pottery class.',
  'They discussed the new API design.',
  'Caroline is going to the transgender conference this month.',
  'Melanie codes primarily in TypeScript.',
  'The team shipped the release last Friday.',
  'Caroline and Melanie went to a pride festival together.',
  'The project uses sqlite-vec for vector storage.',
  'Melanie went to the museum a few days ago.',
  'Caroline described the last week of the project as extremely stressful.',
  "The project's last week's numbers were the worst on record.",
  'Her last week was overwhelming.',
  'The last week before the launch was chaos.',
  "The team's exhausting last month was finally over.",
  'I saw her last week.',
  'Caroline mentioned she started ten years ago.',
  'They decided to use Zod for schema validation.',
  'Melanie visited the pottery studio last weekend.',
];

// A large, deliberately NON-temporal control batch — realistic memory-atom
// prose with zero relative-date content, to measure the FALSE-POSITIVE rate
// of the detector on its own (no LLM call needed unless it wrongly fires).
// Part 2's 20-atom sample above was hand-loaded with temporal candidates to
// exercise both the resolve and decline paths and is NOT representative of
// a real corpus mix — this batch is the honest denominator.
const NON_TEMPORAL_CONTROL: string[] = [
  'The daemon binds port 7777 by default.',
  'sqlite-vec is used for the vector store.',
  'Caroline prefers tea over coffee.',
  'The extraction prompt lives in prompts/extract.ts.',
  'Melanie works as a graphic designer.',
  'Bun is faster than Node for CLI startup.',
  'The team decided to use Zod for schema validation.',
  'Caroline has a dog named Max.',
  'TypeScript strict mode is enabled project-wide.',
  'Melanie is allergic to peanuts.',
  'The config file is written in YAML.',
  'Caroline studied at a university in Chicago.',
  'The bearer token is stored in secrets.env.',
  'Melanie collects vintage postcards.',
  'Fastify is the HTTP framework used by the daemon.',
  'Caroline speaks three languages fluently.',
  'The migration files live under migrations/.',
  "Melanie's favorite color is teal.",
  'The embedding model is mxbai-embed-large.',
  'Caroline volunteers at an animal shelter on weekends.',
  'The relation predicates are a closed enum of ten values.',
  'Melanie is training for a marathon.',
  'The doctor command runs a full diagnostic suite.',
  'Caroline is learning to play the violin.',
  'The reduce stage deduplicates atoms by content hash.',
  'Melanie changed her hairstyle to a bob cut.',
  'The health endpoint requires no bearer token.',
  'Caroline adopted a cat from a local shelter.',
  'The budget tracker caps daily LLM spend.',
  'Melanie is fluent in sign language.',
];

async function main(): Promise<void> {
  const llm = new CodexSubscriptionLLMProvider();

  console.log('='.repeat(100));
  console.log('PART 1 — ADVERSARIAL CASES (must not fabricate; the "must resolve" case must resolve)');
  console.log('='.repeat(100));

  let fabricationCount = 0;
  for (const c of CASES) {
    const atoms = [atom(c.text)];
    const result = await groundAtomDates(atoms, SESSION_DATE, llm, {
      log: (m) => console.log('  [log] ' + m),
    });
    const outputText = result.atoms[0]!.text;
    const changed = outputText !== c.text;
    const isFabrication = c.mustResolve ? false : changed;
    if (isFabrication) fabricationCount++;

    console.log(`\n--- ${c.label} ---`);
    console.log(`INPUT:    ${c.text}`);
    console.log(`OUTPUT:   ${outputText}`);
    console.log(`fired=${result.fired} resolved=${result.resolved} errors=${result.errors} changed=${changed}`);
    console.log(
      c.mustResolve
        ? changed
          ? 'PASS — resolved as expected'
          : 'FAIL — did NOT resolve a genuinely session-relative case'
        : changed
          ? 'FAIL — FABRICATED A DATE'
          : 'PASS — correctly left unchanged',
    );
  }

  console.log('\n' + '='.repeat(100));
  console.log(`ADVERSARIAL SUMMARY: ${fabricationCount}/5 fabrication cases fabricated (must be 0/5 to pass)`);
  console.log('='.repeat(100));

  console.log('\n' + '='.repeat(100));
  console.log('PART 2 — FIRE RATE on a realistic mixed batch');
  console.log('='.repeat(100));

  const detected = FIRE_RATE_SAMPLE.filter(hasUnresolvedRelativeDate).length;
  console.log(`\nDetector matched ${detected}/${FIRE_RATE_SAMPLE.length} atoms (${((detected / FIRE_RATE_SAMPLE.length) * 100).toFixed(1)}%)`);

  const batchAtoms = FIRE_RATE_SAMPLE.map(atom);
  const batchResult = await groundAtomDates(batchAtoms, SESSION_DATE, llm, { log: () => {} });

  console.log(`\nfired=${batchResult.fired} resolved=${batchResult.resolved} errors=${batchResult.errors} totalAtoms=${batchResult.totalAtoms}`);
  console.log(`fire rate = ${batchResult.fired}/${batchResult.totalAtoms} = ${((batchResult.fired / batchResult.totalAtoms) * 100).toFixed(1)}%`);
  console.log(`resolve rate (of fired) = ${batchResult.resolved}/${batchResult.fired} = ${((batchResult.resolved / batchResult.fired) * 100).toFixed(1)}%`);

  console.log('\nPer-atom before/after:');
  for (let i = 0; i < FIRE_RATE_SAMPLE.length; i++) {
    const before = FIRE_RATE_SAMPLE[i]!;
    const after = batchResult.atoms[i]!.text;
    if (before !== after) {
      console.log(`  CHANGED: "${before}"\n        -> "${after}"`);
    }
  }

  console.log('\n' + '='.repeat(100));
  console.log('PART 3 — NON-TEMPORAL CONTROL (false-positive rate; detector-only, no LLM call needed unless it wrongly fires)');
  console.log('='.repeat(100));

  const falsePositives = NON_TEMPORAL_CONTROL.filter(hasUnresolvedRelativeDate);
  console.log(
    `\nDetector fired on ${falsePositives.length}/${NON_TEMPORAL_CONTROL.length} non-temporal atoms ` +
      `(${((falsePositives.length / NON_TEMPORAL_CONTROL.length) * 100).toFixed(1)}%)`,
  );
  for (const fp of falsePositives) console.log(`  FALSE POSITIVE: "${fp}"`);

  const combinedTotal = FIRE_RATE_SAMPLE.length + NON_TEMPORAL_CONTROL.length;
  const combinedFired = detected + falsePositives.length;
  console.log(
    `\nCombined (Part 2 mixed sample + Part 3 non-temporal control), a closer approximation of a real ` +
      `corpus mix: detector fires on ${combinedFired}/${combinedTotal} atoms ` +
      `(${((combinedFired / combinedTotal) * 100).toFixed(1)}%).`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
