import { z } from 'zod';

export type JobState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'poison'
  | 'paused';

export type JobKind = 'distill' | 'reembed' | 'cleanup';

export const DistillPayloadSchema = z.object({
  kind: z.literal('distill'),
  transcript_id: z.string().min(1),
  session_id: z.string().min(1)
});

export const ReembedPayloadSchema = z.object({
  kind: z.literal('reembed'),
  memory_id: z.string().min(1)
});

export const CleanupPayloadSchema = z.object({
  kind: z.literal('cleanup'),
  older_than_days: z.number().int().min(1).default(30)
});

export const JobPayloadSchema = z.discriminatedUnion('kind', [
  DistillPayloadSchema,
  ReembedPayloadSchema,
  CleanupPayloadSchema
]);

export type DistillPayload = z.infer<typeof DistillPayloadSchema>;
export type ReembedPayload = z.infer<typeof ReembedPayloadSchema>;
export type CleanupPayload = z.infer<typeof CleanupPayloadSchema>;
export type JobPayload = z.infer<typeof JobPayloadSchema>;

export interface Job {
  id: string;
  kind: JobKind;
  payload_json: string;
  state: JobState;
  attempts: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}
