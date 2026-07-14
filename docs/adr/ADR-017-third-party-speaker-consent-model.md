# ADR-017: Third-Party Speaker Consent Model — non-user voices and captions (FEAT-489, FEAT-491)

**Status:** Proposed — ratification (proposed → accepted) is the product owner's call, per the
ADR-012 precedent of an explicit human sign-off closing the gate before slice 1 opens (see
"Acceptance checklist" below).
**Date:** 2026-07-14 · **Confidence:** High on the gating requirement and default posture; Medium
on the caption-vs-audio disposition (reasoned from statute text, not counsel-reviewed); Low on any
specific jurisdiction's current law (see "Jurisdiction posture" — verify before GA, this ADR is
not legal advice).
**Context:** ADR-009's threat model (§5) has one row for every threat *to the astramem user's own
data* — device theft, secrets in transcripts, token theft, cloud breach, employer overreach. It
has zero rows for the inverse case: the astramem user's device capturing *someone else's* speech
without that person's knowledge or consent. Two features now make that gap load-bearing:
FEAT-489 (audio file ingestion — records a meeting, everyone in the room is captured) and
FEAT-491 (meeting-caption capture — scrapes what other participants said from Meet/Teams live
captions). The 2026-07-14 architecture review (`.claude/artifacts/crew/reviews/20260714-arch-review-feat-489-495.md`)
flagged this as a required gate on both FEATs, citing two pieces of this repo's own precedent:
ADR-008's rejection of file-watching capture as "consent-ambiguous" (`ADR-008` decision, options
considered #3, lines 54-56) and ADR-012's rule that every new capture-surface tier gets its own
risk ADR — default OFF, explicit opt-in, disclosure copy, human sign-off — *before* any build
dispatch (`ADR-012` decision 4, options considered #1). Both prior ADRs govern surfaces where the
subject of capture is the astramem user themselves. Recording or transcribing other people is a
different threat class with different (and in places criminal, not just contractual) exposure,
and gets its own ADR for the same reason ADR-013 didn't fold the LLM-proxy tier into ADR-012:
re-derive the trust model from scratch rather than assume the shape transfers.

FEAT-489 and FEAT-491 both `depends_on: [FEAT-496, FEAT-497]` in their backlog frontmatter —
FEAT-497 is the tracking feature for this ADR. Neither FEAT may open slice 1 until this ADR is
accepted.

## Decision

### 1. Threat-model amendment — extends ADR-009 §5, does not replace it

New rows, appended to ADR-009's existing threat table, scoped to captured *non-user* speech:

| Threat | Mitigation |
|---|---|
| Audio recording captures a non-consenting third party's voice (FEAT-489) | Default OFF; explicit opt-in with disclosure copy naming third-party exposure (decision 3); on-device-only transcription, `private` scope by default (unchanged from ADR-009 §1); operator-responsibility framing (decision 3) — the daemon cannot obtain the other parties' consent, only the human running it can |
| Caption capture persists a non-consenting third party's spoken words as durable, searchable text (FEAT-491) | Same tier as audio (decision 2) — default OFF, explicit opt-in, `private` scope default (per FEAT-491's own acceptance hints), plugin-side visible-indicator requirement (decision 5) |
| Two-party/all-party consent-recording law exposure (multiple US states and other jurisdictions) | General guidance posture, not a compliance guarantee (decision 4); counsel review recommended before any default-on or enterprise/org rollout |
| Cross-repo capture point is upstream of the daemon's own gates (FEAT-491: astramem-plugin does the scraping in the browser, before anything reaches `/ingest/transcript`) | Plugin repo must implement the same default-OFF + opt-in gate locally, cannot rely on the daemon dropping ungated payloads after the fact (decision 5) |
| Team/org promotion of a third-party-speaker atom re-exposes captured third-party content to an employer/org audience the third party never agreed to at all | ADR-009's existing promotion + aggregation-floor rules apply unchanged, but decision 3's disclosure copy must say so explicitly — promoting a meeting-caption memory to `team` scope ships another person's words to a corporate audience |

### 2. Caption-vs-audio disposition: same consent tier, decided explicitly

FEAT-491's own framing calls caption capture "bot-free, zero-ASR" and treats it as a lighter-weight
path than audio because the text is "already displayed" to meeting participants by the platform.
**That argument is rejected as a basis for treating captions as a lower consent tier than audio.**
Reasoning:

- The legally relevant act under most consent-recording statutes is not the sensory modality
  (audio vs. on-screen text) — it is *creating a durable, exportable record of the contents of a
  communication without the other party's knowledge*. A caption feed is ephemeral by the
  platform's own design (Meet/Teams/Zoom captions are not persisted or exportable through the
  platform UI in the general case); systematically scraping, storing, and making that content
  searchable outside the platform is a materially different act than the platform showing it on
  screen for the duration of the utterance. This repo's own atom model reinforces the point:
  captured captions do not stay ephemeral once ingested — they become bitemporal, retrievable,
  potentially team/org-promotable memories (ADR-009 §1-3), which is a strictly stronger
  persistence guarantee than anything the meeting platform itself offers the other participants.
- Several consent-recording statutes are not audio-specific by text. California Penal Code §632,
  for example, covers recording a "confidential communication" "by means of any electronic
  amplifying or recording device," not "audio recording device" — the caption pipeline
  (platform ASR → displayed text → scraped and persisted) plausibly falls inside that scope even
  though no microphone or audio codec is touched by this repo's code. This ADR does not resolve
  that question (it isn't counsel), but flags that "we never touch audio" is not a safe-harbor
  argument on its face.
- The one real difference that *does* survive: caption capture has a smaller *technical*
  disclosure surface than raw audio (no tone, no ambient room content, no voice-biometric-adjacent
  data, no accidental capture of a side conversation the ASR didn't transcribe). That is a
  mitigation of degree, not of kind — it lowers the blast radius of a given capture event, it does
  not change whether the third party consented to being captured at all. It is reflected below as
  a note in the disclosure copy, not as a reason to relax the gate.

**Decision: FEAT-489 and FEAT-491 are the same consent tier** — both require decision 3's full
gate (default OFF, explicit opt-in, disclosure copy, purge-on-disable) before either ships.

### 3. Consent / disclosure requirements — default OFF, explicit opt-in, reversible

Mirrors ADR-012 decision 4's shape, extended for the third-party case:

- Default: **OFF** for both (`audio.enabled: false` per FEAT-489's existing config note;
  `captureSource.meetingCaptions.enabled: false`, new, for FEAT-491).
- Opt-in is explicit and per-surface — enabling audio capture does not silently enable caption
  capture or vice versa; each gets its own disclosed prompt, never bundled into one "enable
  meeting memory" toggle that obscures which surface is doing the capturing.
- **Disclosure copy is operator-facing, not participant-facing, and must say so.** The daemon and
  plugin cannot reach the other meeting participants — only the human enabling the feature can.
  The opt-in prompt must therefore include, verbatim or materially equivalent, a canonical
  disclosure string shared across both repos (this is the cross-repo binding, decision 5):

  > "This will capture what other people say in your meetings/calls, not just your own words.
  > Recording or transcribing someone without their knowledge is restricted or illegal in many
  > places (see [jurisdiction guidance link]). Turning this on does not make it legal — you are
  > responsible for informing other participants and getting consent where required."

  This copy belongs in astramem-local's `init` wizard (audio, FEAT-489) and in the astramem-plugin
  extension's opt-in UI (captions, FEAT-491) — both repos, same text, so the posture is consistent
  regardless of which capture surface a given user enables first.
- `doctor` gets a WARN row per surface when enabled, following the existing ADR-012 pattern
  (`src/doctor/checks.ts:786`) — distinguishing audio-capture-on and caption-capture-on so an
  operator (or a later audit) can see at a glance which third-party-facing surfaces are live, not
  just an aggregate auto-capture flag.
- **Disabling either surface offers a purge**, same mechanism ADR-012 decision 4 specifies
  (`erase_memory`/`invalidate_memory`, lifecycle routes at `src/server/routes/lifecycle.ts`),
  scoped to atoms tagged with that surface's provenance. Offered, not forced — consistent with
  ADR-012.
- No feature in this ADR's scope may be enabled by policy/config push for a user other than the
  person physically consenting at the `init`/opt-in prompt. An org admin turning audio capture on
  for someone else's device is out of scope entirely — if it is ever proposed, it needs its own
  ADR, because remote-enablement removes the one consent signal this decision relies on (the
  operator's own click).

### 4. Jurisdiction posture — general guidance, not legal advice

This ADR does not attempt geo-detection or per-jurisdiction feature gating; the device's location
is not a reliable proxy for where the *other participants* are, and building a false sense of
compliance via IP-based geofencing would be worse than no gating at all. Instead:

- Ship the same default-OFF + disclosure gate everywhere, regardless of detected locale.
- The disclosure copy (decision 3) names the general shape of the risk without asserting legal
  conclusions: the U.S. splits between "one-party consent" states (a recording party who is
  themselves part of the conversation may record without telling the others) and "all-party" /
  "two-party consent" states (commonly cited: California, Connecticut, Florida, Illinois,
  Maryland, Massachusetts, Montana, Nevada, New Hampshire, Pennsylvania, Washington — this list is
  illustrative and drifts; do not hardcode it into product logic or treat it as current law
  without verification at ship time). Several jurisdictions outside the U.S. lean further toward
  all-party consent by default (e.g. Germany's Strafgesetzbuch §201 criminalizes recording the
  spoken word of a non-consenting party) — international posture should be treated as at least as
  strict as the strictest US state, not as an unaddressed gap.
- **Recommend counsel review before any of the following**, none of which are authorized by this
  ADR on its own: enabling either surface by default for any user tier; marketing copy that
  implies the feature is broadly legal to use; an enterprise/org rollout where the org (not the
  individual operator) controls the toggle; any feature that auto-detects "this looks like a
  meeting, start recording" without an explicit per-session confirmation.
- This posture intentionally matches ADR-009's existing works-council caution (§ Context) — the
  same "optics can veto org rollouts" logic that shaped the personal/team/org scope model applies
  with more force here, since the exposed party has no relationship with astramem at all.

### 5. Cross-repo binding — astramem-plugin (caption scraping) requirements

FEAT-491's capture point (the browser extension reading Meet/Teams DOM captions) is upstream of
anything astramem-local's daemon can gate — by the time a payload reaches
`POST /ingest/transcript`, the scraping has already happened. This ADR therefore binds the plugin
repo, not just this one:

- The extension must implement its own default-OFF + explicit opt-in for caption scraping,
  independently of any daemon-side config. The daemon dropping ungated envelopes after the fact is
  not equivalent — the scraping itself is the consent-relevant event, not the ingest call.
- While caption scraping is active for a given meeting, the extension must show a persistent,
  visible indicator in the browser UI (comparable in visibility to a "recording" indicator) — no
  silent background scraping, matching the "no additional observation surface without disclosure"
  spirit of ADR-012 decision 5 (non-goals: no live/invisible tap without disclosure).
- The extension's opt-in prompt uses the same canonical disclosure copy as decision 3, so an
  operator who has already seen the audio-capture disclosure in astramem-local recognizes the same
  posture in the plugin, and vice versa.
- Envelopes the plugin sends must carry a disclosure-confirmed marker so the daemon can enforce
  the gate server-side too, not just trust the client. This requires a schema field — see
  decision 6.

### 6. Contract touch point — coordinate with FEAT-496, do not fork a competing shape

`provenance` in `contracts/schemas/atom.v2.schema.json` (`:66-82`) is `additionalProperties:
false` with exactly four fields (`tool`, `session_id`, `project`, `extractor`) — there is no
passthrough, so a consent marker cannot ride along informally. FEAT-496 (contract extension,
already scoped to add `speaker_label` + `segment_start_ms` for this same FEAT-489/491 pair) is the
correct, and only sanctioned, place to add it. This ADR adds one line item to FEAT-496's scope
rather than opening a second schema-change surface:

- Add an optional `consent_disclosed: boolean` (or equivalently-named) field to `provenance`,
  set by the capturing adapter (astramem-local's audio pipeline, astramem-plugin's caption
  scraper) at the point the operator completed the opt-in flow in decision 3/5. Daemon-side
  ingest validation for the audio and meeting-captions capture sources should treat a missing or
  `false` value as a hard reject, not a silent accept — this is the server-side backstop for
  decision 5's client-side requirement.
- This is additive/minor per `contracts/README.md:272-283`, same bucket as the speaker/segment
  fields FEAT-496 already owns — no schema-major bump required, no separate ADR needed for the
  field itself, only for the policy this ADR sets around it.

### 7. Non-goals

- **This ADR does not make either feature legally safe to ship.** It sets the product-side gate
  (default OFF, disclosure, purge, cross-repo consistency) that this repo's own precedent (ADR-012)
  requires before build dispatch. It is not a substitute for jurisdiction-specific legal review,
  which decision 4 recommends before any broader rollout.
- **The daemon does not attempt to detect or verify third-party consent.** There is no mechanism
  proposed here for confirming the other meeting participants agreed — that is structurally
  impossible for code running on only one participant's device to verify, and no design in this
  ADR pretends otherwise. The gate is entirely about what the *operator* is told and required to
  acknowledge.
- **Redaction/scrub of captured third-party content is unchanged by this ADR.** Stage-0 redaction
  (SEC-3/5, ADR-012 decision 3) already runs on all persisted content regardless of whose speech it
  is; this ADR does not add a new redaction requirement, it adds the consent/disclosure gate that
  sits in front of capture happening at all.
- **No geofencing or jurisdiction auto-detection** (decision 4) — treated as a non-goal, not an
  oversight; it would create a false compliance signal.

## Options considered

1. **New dedicated ADR extending ADR-009's threat model, mirroring ADR-012's shape (chosen).**
   Matches this repo's own precedent for a materially new trust surface (ADR-013 did the same
   thing rather than editing ADR-012 in place) — keeps ADR-009 stable as the general privacy/scope
   model while giving this third-party-specific case its own decision record other FEATs can cite
   and its own accept/reject lifecycle independent of ADR-009's already-`accepted` status.
2. **Amend ADR-009 directly (add rows to its existing threat table, no new document).** Rejected:
   ADR-009 is `accepted` and governs the general scope model; folding a third-party-consent-specific,
   still-`proposed` decision into an already-accepted document either forces re-review of the whole
   ADR or creates an ambiguous half-accepted state. A new ADR that explicitly extends ADR-009's
   table (decision 1) gets the cross-reference without the merge conflict.
3. **Treat caption capture (FEAT-491) as a lower tier than audio (FEAT-489), gate only audio.**
   Rejected in decision 2 — the "already displayed text" argument does not hold up against how
   consent-recording statutes are actually written, and this repo's own persistence model turns an
   ephemeral on-screen caption into a durable, searchable, potentially team/org-promotable record,
   which is the part that matters.
4. **Ship with jurisdiction auto-detection (IP/locale) gating the feature on/off.** Rejected —
   unreliable proxy for where the *other* participants are, and creates a false sense of
   case-by-case compliance that this repo cannot actually guarantee (decision 4).
5. **Block both FEATs indefinitely pending formal legal sign-off before any ADR is written.**
   Rejected — matches neither ADR-012's own precedent (which reached `accepted` via an explicit,
   recorded human decision, not indefinite deferral) nor this backlog's stated intent (FEAT-497:
   "the value is deciding BEFORE building — same gate ADR-012 imposed on itself"). This ADR is
   that decision artifact; ratification is still a human call (see Acceptance checklist), just not
   an open-ended one.

## Consequences & migration

- FEAT-489 and FEAT-491 stay blocked (`depends_on: [FEAT-496, FEAT-497]`) until this ADR moves
  `proposed → accepted` and FEAT-496 ships the `consent_disclosed` field on a `contracts-v*` tag
  (merge ≠ publish, per this repo's own contract-publish rule).
- FEAT-489's acceptance hints and FEAT-491's acceptance hints should be updated, once this ADR is
  accepted, to reference: the canonical disclosure copy (decision 3), the doctor WARN row per
  surface (decision 3), and the `consent_disclosed` provenance field (decision 6) as explicit
  acceptance criteria rather than a narrative note.
- astramem-plugin needs a corresponding tracking item for decision 5 (opt-in gate + visible
  indicator + shared disclosure copy in the caption-scraping extension) — this ADR states the
  requirement; the plugin-repo backlog entry to implement it is a follow-up, not created by this
  doc-only lane.
- No code changes ship from this ADR itself (doc-only lane, FEAT-497's stated scope). The
  `consent_disclosed` schema field is FEAT-496's implementation, guided by decision 6.

**Acceptance checklist — should be satisfied before this ADR moves `proposed → accepted`:**

1. Product owner reviews the caption-vs-audio disposition (decision 2) and either confirms or
   overrides it — this is the one judgment call in this ADR that a differently-risk-tolerant
   owner could reasonably take the other way.
2. Confirm the canonical disclosure copy (decision 3) is acceptable as user-facing product copy,
   or have it rewritten by whoever owns product copy — the text above is a functional draft, not
   final marketing/legal-reviewed language.
3. Decide whether counsel review (decision 4) is a hard prerequisite for *any* ship (including a
   default-OFF, single-developer-opt-in v1) or only for the broader-rollout triggers listed —
   this ADR assumes the latter (v1 ships without counsel review, since it is default-OFF and
   individually opted-in) but that assumption should be explicitly confirmed, not inherited
   silently.
4. Confirm FEAT-496 will carry the `consent_disclosed` field (decision 6) as an in-scope addition,
   not a separately-scheduled follow-up that could let FEAT-489/491 ship without server-side
   enforcement.
5. Flag decision 5 (astramem-plugin binding) to whoever owns that repo's backlog so a tracking
   item exists there before FEAT-491 build dispatch — this ADR cannot create that item itself.

## Open questions for ratification

- Is the "same tier for audio and captions" call (decision 2) the one the product owner wants, or
  is the lighter-weight caption path (FEAT-491's original framing) worth keeping for a narrower
  v1 — e.g., captions ship first under a lighter gate, audio waits for the full gate? This ADR's
  position is that splitting them undersells the persistence argument, but it is a judgment call,
  not a fact.
- Is v1 (default-OFF, single-operator opt-in, no org rollout) acceptable to ship without prior
  counsel review, or does the product owner want a legal pass before *any* code ships, even under
  those constraints?
- Does the product owner want the disclosure copy to link to a real jurisdiction-guidance page, or
  is a generic in-product warning (no link) sufficient for v1? A link implies an ongoing
  maintenance commitment to keep that page accurate.
