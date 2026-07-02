/**
 * Stage-0 secret redaction (spec docs/specs/2026-07-02-encryption-and-secret-redaction.md
 * §4.2/§4.3, SEC-3..6/SEC-9).
 *
 * Single entry point: `redactText(input, opts)`. Invoked at the ingest choke
 * point (POST /ingest/transcript, before the `transcripts` INSERT) and on the
 * `/remember` manual-write path (spec OQ-2: yes). Downstream pipeline stages
 * inherit already-redacted text — there is no second redaction pass.
 *
 * Placeholder format: `[REDACTED:<type>:<hash8>]` where hash8 = first 8 hex
 * chars of SHA-256(secret value). Same secret -> same placeholder (dedup-safe
 * across a transcript); the raw value is NEVER stored or logged (SEC-5).
 *
 * Detection order (never redact inside an already-inserted placeholder):
 *   1. PEM private-key blocks (multiline, whole block)
 *   2. Vendor/pattern detectors (AWS, GitHub, Azure, GCP, Slack, generic
 *      key=value, JWT, connection-string userinfo) + config custom patterns
 *   3. Shannon-entropy detector over whatever text remains
 */

import { createHash } from 'node:crypto';
import { PEM_DETECTOR, PATTERN_DETECTORS, customDetector, type PatternDetector } from './detectors.js';
import { findEntropySecrets } from './entropy.js';
import type { Config } from '../config/config.js';

export interface RedactionEvent {
  type: string;
  hash8: string;
  /** Offset of the redacted span within the text snapshot at detection time. */
  offset: number;
}

export interface RedactOptions {
  /** Shannon-entropy threshold in bits/char. Default 4.0. */
  entropyThreshold?: number;
  /** Additional regex sources (as strings) from config, type 'custom'. */
  customPatterns?: string[];
}

export interface RedactResult {
  text: string;
  events: RedactionEvent[];
}

const PLACEHOLDER_RE_G = /\[REDACTED:[^\]]+\]/g;

function hash8(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

function placeholder(type: string, digest: string): string {
  return `[REDACTED:${type}:${digest}]`;
}

/** Spans already occupied by a previously-inserted placeholder in `text`. */
function protectedRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  PLACEHOLDER_RE_G.lastIndex = 0;
  while ((m = PLACEHOLDER_RE_G.exec(text)) !== null) {
    ranges.push([m.index, m.index + m[0].length]);
  }
  return ranges;
}

function overlapsAny(start: number, end: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([rs, re]) => start < re && end > rs);
}

interface Span {
  type: string;
  start: number;
  end: number;
  value: string;
}

/** Run one PatternDetector over `text`, returning non-overlapping-with-protected spans. */
function runDetector(text: string, detector: PatternDetector, guard: Array<[number, number]>): Span[] {
  const flags = detector.flags.includes('g') ? detector.flags : `${detector.flags}g`;
  const re = new RegExp(detector.source, flags.includes('d') ? flags : `${flags}d`);
  const spans: Span[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let start: number;
    let end: number;
    let value: string;
    const indices = (m as unknown as { indices?: Array<[number, number]> }).indices;
    const groupRange = detector.valueGroup !== undefined ? indices?.[detector.valueGroup] : undefined;
    if (groupRange !== undefined) {
      [start, end] = groupRange;
      value = m[detector.valueGroup as number] as string;
    } else {
      start = m.index;
      end = m.index + m[0].length;
      value = m[0];
    }
    if (end > start && !overlapsAny(start, end, guard)) {
      spans.push({ type: detector.type, start, end, value });
    }
    if (re.lastIndex === m.index) re.lastIndex++; // guard zero-length matches
  }
  return spans;
}

/** Drop spans that overlap an earlier (higher-priority) span from the same batch. */
function dedupeOverlaps(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const kept: Span[] = [];
  let lastEnd = -1;
  for (const s of sorted) {
    if (s.start >= lastEnd) {
      kept.push(s);
      lastEnd = s.end;
    }
  }
  return kept;
}

/** Replace `spans` (non-overlapping, sorted or not) in `text` with placeholders. */
function applySpans(text: string, spans: Span[]): { text: string; events: RedactionEvent[] } {
  if (spans.length === 0) return { text, events: [] };
  const sorted = dedupeOverlaps(spans);
  let out = '';
  let cursor = 0;
  const events: RedactionEvent[] = [];
  for (const s of sorted) {
    out += text.slice(cursor, s.start);
    const digest = hash8(s.value);
    out += placeholder(s.type, digest);
    events.push({ type: s.type, hash8: digest, offset: s.start });
    cursor = s.end;
  }
  out += text.slice(cursor);
  return { text: out, events };
}

/**
 * Redact secrets from `input`. Pure function — no I/O, no DB writes (callers
 * aggregate `events` into `redaction_log` themselves).
 */
export function redactText(input: string, opts: RedactOptions = {}): RedactResult {
  const threshold = opts.entropyThreshold ?? 4.0;
  const allEvents: RedactionEvent[] = [];

  // ---- Stage 1: PEM blocks (multiline, first) ----
  let text = input;
  {
    const guard = protectedRanges(text);
    const spans = runDetector(text, PEM_DETECTOR, guard);
    const applied = applySpans(text, spans);
    text = applied.text;
    allEvents.push(...applied.events);
  }

  // ---- Stage 2: vendor/pattern detectors + custom config patterns ----
  {
    const guard = protectedRanges(text);
    const detectors: PatternDetector[] = [
      ...PATTERN_DETECTORS,
      ...(opts.customPatterns ?? []).map(customDetector),
    ];
    let spans: Span[] = [];
    for (const detector of detectors) {
      try {
        spans = spans.concat(runDetector(text, detector, guard));
      } catch {
        // Invalid custom regex from config — skip it rather than crash ingest.
      }
    }
    const applied = applySpans(text, spans);
    text = applied.text;
    allEvents.push(...applied.events);
  }

  // ---- Stage 3: entropy detector over what remains ----
  {
    const guard = protectedRanges(text);
    const entropySpans = findEntropySecrets(text, threshold)
      .filter(m => !overlapsAny(m.start, m.end, guard))
      .map(m => ({ type: 'high_entropy', start: m.start, end: m.end, value: m.value }));
    const applied = applySpans(text, entropySpans);
    text = applied.text;
    allEvents.push(...applied.events);
  }

  return { text, events: allEvents };
}

/**
 * Choke-point helper for route handlers: applies config (enabled flag,
 * entropy threshold, custom patterns) and is a no-op passthrough when
 * `security.redaction.enabled` is false (SEC-9).
 */
export function redactIfEnabled(input: string, config: Config): RedactResult {
  if (!config.security.redaction.enabled) {
    return { text: input, events: [] };
  }
  return redactText(input, {
    entropyThreshold: config.security.redaction.entropyThreshold,
    customPatterns: config.security.redaction.customPatterns,
  });
}
