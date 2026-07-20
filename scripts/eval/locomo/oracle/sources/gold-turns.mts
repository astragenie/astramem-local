/**
 * `EvidenceSource` that answers every question from PERFECT evidence: the
 * exact source turns the LoCoMo dataset itself cites as grounding
 * (`qa.evidence[]`, e.g. `["D1:3", "D2:7"]`), read straight out of
 * `ctx.dataset` -- no retrieval, no extraction, no store daemon at all
 * (`needsStore: false`). This is the harness's "oracle" rung (v2 plan
 * §"Phase 1 — the oracle factorial", `harness.mts`'s own header): a score
 * measured here can only be capped by the ANSWERER and the SCORER, because
 * the evidence input is by construction as good as it can ever get. Any gap
 * between this cell's score and the real single-hop benchmark score is
 * therefore attributable to extraction/retrieval, not to answering/scoring.
 *
 * Each `qa.evidence[]` dia_id (e.g. "D1:3" = session 1, turn 3) is resolved
 * against the SAME sample's `conversation.session_N[]` turns (indexed once
 * per sample and cached, since a sample's many QA pairs all resolve against
 * the same turn set). A dia_id that fails to resolve, or a qa with empty/no
 * evidence, is a LEGITIMATE oracle result (some questions are genuinely not
 * evidence-grounded) -- this returns `[]` for those, never throws.
 *
 * Each hit's `text` is prefixed with `[<session date>] <speaker>: ` so the
 * answerer gets the same date-grounding a real captured memory note would
 * carry (see CLAUDE.md's "Temporal reasoning" section on why the model
 * needs the date INSIDE the text it reads, not just in metadata) -- without
 * this prefix the oracle rung would be an unfairly EASIER version of
 * "perfect evidence" than production evidence ever is.
 *
 * Image-grounded turns (`turn.blip_caption` present) get the SAME inline
 * `[shares <blip_caption>]` suffix `lib/envelope.ts`'s `buildIngestEnvelope`
 * appends before real ingest (see that file's `text:` mapping, line ~51) --
 * a meaningful fraction of LoCoMo's evidence lives ONLY in the image
 * caption, not the turn's own `text` (e.g. "what did X paint" answered by a
 * caption, with the turn text itself just small talk). The real store
 * already folds captions into what it ingests, so an oracle source that
 * omitted them would UNDERSTATE the evidence ceiling and mislead every
 * downstream (extraction/retrieval/answering) attribution built on top of
 * this rung. Each such hit's `type` is tagged `gold-turn-image` (instead of
 * the plain `gold-turn`) so a caller can split the ceiling both ways --
 * image-grounded vs text-only -- without re-deriving it from raw turns.
 *
 * `EvidenceSource.id` MUST equal the filename stem -- this file's id is
 * `gold-turns`, matching `gold-turns.mts`.
 */
import type { EvidenceSource, EvidenceContext, QA } from '../harness.mts';
import type { SearchHit } from '../../../shared/daemon-client.js';
import { sessionNumbers, type LoCoMoSample } from '../../lib/types.js';

interface GoldTurn {
  speaker: string;
  text: string;
  sessionDateTime: string;
  blipCaption?: string;
}

/** dia_id -> turn, indexed once per sample_id and reused across every QA
 *  pair of that sample (a 19-session conversation has hundreds of turns;
 *  re-scanning it per question would be pure waste). Keyed by sample_id
 *  rather than by the sample object itself since the harness re-loads the
 *  same dataset file across calls within one process. */
const sampleIndexCache = new Map<string, Map<string, GoldTurn>>();

function indexSample(sample: LoCoMoSample): Map<string, GoldTurn> {
  const cached = sampleIndexCache.get(sample.sample_id);
  if (cached) return cached;

  const index = new Map<string, GoldTurn>();
  for (const n of sessionNumbers(sample.conversation)) {
    const turns = sample.conversation[`session_${n}`] ?? [];
    const sessionDateTime = sample.conversation[`session_${n}_date_time`] ?? '';
    for (const turn of turns) {
      index.set(turn.dia_id, { speaker: turn.speaker, text: turn.text, sessionDateTime, blipCaption: turn.blip_caption });
    }
  }
  sampleIndexCache.set(sample.sample_id, index);
  return index;
}

const goldTurns: EvidenceSource = {
  id: 'gold-turns',
  needsStore: false,
  async hitsFor(qa: QA, sampleId: string, ctx: EvidenceContext): Promise<SearchHit[]> {
    const evidence = qa.evidence ?? [];
    if (evidence.length === 0) return [];

    const sample = ctx.dataset.find(s => s.sample_id === sampleId);
    if (!sample) return []; // should not happen given the driver's own task list, but never throw over it

    const index = indexSample(sample);
    const hits: SearchHit[] = [];
    for (const diaId of evidence) {
      const turn = index.get(diaId);
      if (!turn) continue; // unresolved dia_id -- a legitimate oracle result, not an error
      // Same `[shares <caption>]` convention as lib/envelope.ts:51's real ingest path.
      const body = turn.blipCaption ? `${turn.speaker}: ${turn.text} [shares ${turn.blipCaption}]` : `${turn.speaker}: ${turn.text}`;
      const text = turn.sessionDateTime ? `[${turn.sessionDateTime}] ${body}` : body;
      hits.push({ id: diaId, type: turn.blipCaption ? 'gold-turn-image' : 'gold-turn', text, score: 1.0, source: 'gold-turns' });
    }
    return hits;
  },
};

export default goldTurns;
