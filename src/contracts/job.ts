export type JobState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'poison'
  | 'paused';

export type JobKind = 'distill' | 'reembed' | 'cleanup';

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
