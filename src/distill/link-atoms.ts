/**
 * Retrieval-overhaul Phase 6 (P6b) — deterministic cross-atom linking.
 *
 * Codex architecture review: "Relations currently must connect entities
 * appearing inside the same atom. That is too narrow for conversational
 * multi-hop evidence... After reduce, deterministically link atoms sharing
 * normalized entities, session proximity, possession/family relations, or
 * explicit event participants... Require provenance for every generated
 * edge." (docs/research/20260720-codex-architecture-reviews.md, "Add
 * cross-atom links; do not spend first on more extraction".)
 *
 * Runs on `ReducedAtom[]` — the output of stage 6 (`06-reduce.ts`), BEFORE
 * stage 8 assigns real memory ids. Candidates are keyed by `contentHash`
 * (the stable per-atom identity `reduce()` computes), not a memory id, since
 * no memory id exists yet at this point in the pipeline — mirrors how
 * `relations[]` itself rides through the pipeline as atom-shaped data and
 * is only resolved to real ids at stage 8 (see 08-embed-index.ts's
 * `entityIdByName` resolution). The caller (pipeline.ts) threads the
 * returned candidates to `embedAndIndex`, which resolves `contentHash ->
 * memoryId` once every atom in the batch has been inserted and writes the
 * final `memory_links` rows (migration 056).
 *
 * Deliberately deterministic-only (no LLM call) — this is the "populate the
 * graph" data-layer track, and the retrieval-overhaul plan's own local-first
 * rule for this phase is "rules plus local model; a strong offline
 * extractor is acceptable for extraction, but NO cloud dependency in
 * recall" (recall-path constraint; this module runs at INGEST time, not
 * recall time, and adds no network call either way). A narrow offline LLM
 * enrichment pass for atoms that share NO deterministic signal at all is
 * explicitly flagged as a follow-up in this module's own doc comment below,
 * not silently dropped.
 */

import type { ReducedAtom } from './stages/06-reduce.js';
import { normalizeEntityName } from '../entity/normalize.js';

export type AtomLinkType = 'shared_entity' | 'session_proximity' | 'possession_family' | 'event_participant';

export interface AtomLinkCandidate {
  contentHashA: string;
  contentHashB: string;
  linkType: AtomLinkType;
  /** Human-readable reason this link was generated (e.g. the shared entity
   *  name, or "adjacent in extraction order") — provenance, never empty. */
  evidence: string;
  confidence: number;
}

/**
 * An entity mentioned in more than this many atoms within one run is
 * treated as too generic to carry linking signal (the same "non-generic
 * bridge entity" idea Phase 4's search-side chaining already applies when
 * picking bridge entities to traverse — see the plan's Phase 4 section) —
 * without this cap, one very common entity (e.g. the primary speaker's own
 * name, mentioned in nearly every atom) would generate a near-complete
 * pairwise graph, which is noise, not signal.
 */
const GENERIC_ENTITY_MAX_OCCURRENCES = 12;

/** Adjacent-only by design (window = 1 atom on either side) — a wider
 *  window trades precision for a denser but noisier proximity graph;
 *  starting conservative since this link type has no entity/text signal
 *  backing it, only position. */
const SESSION_PROXIMITY_WINDOW = 1;

const DEFAULT_SHARED_ENTITY_CONFIDENCE = 0.5;
const DEFAULT_SESSION_PROXIMITY_CONFIDENCE = 0.4;
const DEFAULT_EVENT_PARTICIPANT_CONFIDENCE = 0.55;
const DEFAULT_POSSESSION_FAMILY_CONFIDENCE = 0.65;

/**
 * Deterministic family/relation-noun detector for the possession_family
 * link type — matches "<name>'s <relation noun>" (e.g. "Alice's mother",
 * "Sergey's daughter"). Intentionally narrow (a closed relation-noun list,
 * not a general possessive-anything match) so this only fires on genuine
 * family/relationship language, not every possessive in the transcript
 * ("Sergey's job", "Alice's school" should NOT upgrade a link to
 * possession_family — those are shared_entity, correctly).
 */
const FAMILY_RELATION_RE =
  /\b[\p{L}][\p{L}'-]*'s\s+(mother|father|mom|dad|daughter|son|sister|brother|wife|husband|spouse|partner|parent|child|grandmother|grandfather|grandma|grandpa|aunt|uncle|cousin|niece|nephew|fiancé|fiancée|fiance|fiancee)\b/giu;

function hasFamilyRelationLanguage(text: string): boolean {
  FAMILY_RELATION_RE.lastIndex = 0;
  return FAMILY_RELATION_RE.test(text);
}

/** Rank used to pick ONE entity-driven link type per atom pair when more
 *  than one condition applies — higher rank wins. session_proximity is
 *  scored/stored independently (see linkAtoms below), since it is
 *  orthogonal to entity-driven types, not competing with them. */
const ENTITY_LINK_TYPE_RANK: Record<Exclude<AtomLinkType, 'session_proximity'>, number> = {
  shared_entity: 0,
  event_participant: 1,
  possession_family: 2,
};

function pairKey(i: number, j: number): string {
  return i < j ? `${i}|${j}` : `${j}|${i}`;
}

/**
 * Compute deterministic cross-atom link candidates for one pipeline run's
 * reduced atoms. Pure function — no DB access, no I/O; the caller resolves
 * `contentHash` to real memory ids and persists via `MemoryLinkRepo`
 * (src/storage/memory-links.ts).
 */
export function linkAtoms(atoms: ReducedAtom[]): AtomLinkCandidate[] {
  if (atoms.length < 2) return [];

  // ── entity-driven candidates (shared_entity / possession_family / event_participant) ──
  const occurrencesByEntity = new Map<string, number[]>();
  atoms.forEach((atom, index) => {
    for (const entity of atom.entities ?? []) {
      const name = normalizeEntityName(entity.name);
      if (!name) continue;
      const list = occurrencesByEntity.get(name);
      if (list) list.push(index);
      else occurrencesByEntity.set(name, [index]);
    }
  });

  interface EntityCandidate { linkType: Exclude<AtomLinkType, 'session_proximity'>; evidence: string; confidence: number }
  const bestEntityCandidate = new Map<string, EntityCandidate>();

  for (const [entityName, indices] of occurrencesByEntity) {
    const uniqueIndices = [...new Set(indices)];
    if (uniqueIndices.length < 2 || uniqueIndices.length > GENERIC_ENTITY_MAX_OCCURRENCES) continue;

    for (let a = 0; a < uniqueIndices.length; a++) {
      for (let b = a + 1; b < uniqueIndices.length; b++) {
        const i = uniqueIndices[a]!;
        const j = uniqueIndices[b]!;
        const atomI = atoms[i]!;
        const atomJ = atoms[j]!;

        let linkType: Exclude<AtomLinkType, 'session_proximity'> = 'shared_entity';
        let confidence = DEFAULT_SHARED_ENTITY_CONFIDENCE;

        if (atomI.type === 'event' || atomJ.type === 'event') {
          linkType = 'event_participant';
          confidence = DEFAULT_EVENT_PARTICIPANT_CONFIDENCE;
        }
        if (hasFamilyRelationLanguage(atomI.text) || hasFamilyRelationLanguage(atomJ.text)) {
          linkType = 'possession_family';
          confidence = DEFAULT_POSSESSION_FAMILY_CONFIDENCE;
        }

        const key = pairKey(i, j);
        const existing = bestEntityCandidate.get(key);
        if (!existing || ENTITY_LINK_TYPE_RANK[linkType] > ENTITY_LINK_TYPE_RANK[existing.linkType]) {
          bestEntityCandidate.set(key, { linkType, evidence: entityName, confidence });
        }
      }
    }
  }

  const candidates: AtomLinkCandidate[] = [];
  for (const [key, candidate] of bestEntityCandidate) {
    const [iStr, jStr] = key.split('|');
    const i = Number(iStr);
    const j = Number(jStr);
    candidates.push({
      contentHashA: atoms[i]!.contentHash,
      contentHashB: atoms[j]!.contentHash,
      linkType: candidate.linkType,
      evidence: candidate.evidence,
      confidence: candidate.confidence,
    });
  }

  // ── session-proximity candidates (positional, orthogonal to entity-driven types) ──
  for (let i = 0; i < atoms.length; i++) {
    for (let offset = 1; offset <= SESSION_PROXIMITY_WINDOW; offset++) {
      const j = i + offset;
      if (j >= atoms.length) break;
      candidates.push({
        contentHashA: atoms[i]!.contentHash,
        contentHashB: atoms[j]!.contentHash,
        linkType: 'session_proximity',
        evidence: 'adjacent in extraction order',
        confidence: DEFAULT_SESSION_PROXIMITY_CONFIDENCE,
      });
    }
  }

  return candidates;
}
