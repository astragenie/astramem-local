/**
 * Round-robin shard partitioning for the LongMemEval question sample, per
 * docs/eval/longmemeval-plan.md section 4 lever 2 ("shard the 500 questions
 * across [daemon instances] (round-robin by question_id)"). The sampler
 * (dataset.ts sampleStratified) already returns questions sorted by
 * question_id, so round-robin here is itself deterministic given the same
 * sample + shard count — reruns produce identical shard membership.
 */
export function partitionRoundRobin<T>(items: T[], shards: number): T[][] {
  if (!Number.isInteger(shards) || shards < 1) {
    throw new Error(`shards must be a positive integer, got ${shards}`);
  }
  const buckets: T[][] = Array.from({ length: shards }, () => []);
  items.forEach((item, i) => { buckets[i % shards]!.push(item); });
  return buckets;
}
