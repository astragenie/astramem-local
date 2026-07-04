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
