/* eslint-disable */
/**
 * GENERATED — do not edit. Source: contracts/schemas/capture-envelope.v1.schema.json
 * Regenerate: node contracts/generate-types.mjs
 */

/**
 * Formalizes docs/capture-protocol.md (ADR-008). POST /ingest/transcript accepts one astramem-capture@1 envelope per session boundary, in one of two kinds: 'transcript' (raw turns, runs the full 8-stage pipeline) or 'events' (pre-typed atom candidates, skips stages 1-5). kind defaults to 'transcript' when omitted.
 */
export type CaptureEnvelopeV1 = {
  [k: string]: unknown;
} & {
  event: 'pre_compact' | 'session_end' | 'subagent_stop';
  session_id: string;
  project_id: string;
  agent_type?: string;
  cwd?: string;
  captured_at: string;
  kind?: 'transcript' | 'events';
  /**
   * Provenance — no default, record what the adapter sends.
   */
  tool?: string;
  client_scrub_applied: boolean;
  client_scrub_hits: number;
  client_version: string;
  client_scrub_version: string;
  /**
   * Per-label scrubber hit counts (e.g. {"aws_key": 2, "jwt": 1}) across all turns. Additive minor over the original v1 shape — cloud (IngestTranscriptRequest) and the plugin (TranscriptIngestPayloadSchema) both already send it; the schema was missing it. Optional so pre-existing writers stay valid.
   */
  client_scrub_hits_by_label?: {
    [k: string]: number;
  };
  /**
   * M-R7 tightened pattern (astragenie/memory IngestTranscriptRequest.cs:65): ASCII digits only, no leading zeros in either the major or minor component, so "v01.0" / "v1.01" are both rejected. Mirrors WIRE_VERSION_PATTERN in contracts/wire.ts.
   */
  wire_version: string;
  /**
   * @minItems 1
   */
  turns?: [
    {
      role: 'user' | 'assistant';
      text: string;
      ts?: string;
    },
    ...{
      role: 'user' | 'assistant';
      text: string;
      ts?: string;
    }[]
  ];
  /**
   * @minItems 1
   * @maxItems 500
   */
  events?: [
    {
      type: 'decision' | 'fact' | 'lesson' | 'command' | 'todo' | 'note' | 'event';
      text: string;
      importance?: number;
      confidence?: number;
      evidence?: string;
      /**
       * Epoch ms — when the event happened, vs. captured_at (when it was captured).
       */
      occurred_at?: number;
    },
    ...{
      type: 'decision' | 'fact' | 'lesson' | 'command' | 'todo' | 'note' | 'event';
      text: string;
      importance?: number;
      confidence?: number;
      evidence?: string;
      /**
       * Epoch ms — when the event happened, vs. captured_at (when it was captured).
       */
      occurred_at?: number;
    }[]
  ];
};
