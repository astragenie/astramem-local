# Extraction-bench results

| Model | Recall | Precision | F1 | Junk rate | Type acc | Evidence acc | Over-extract (nothing fx) | Avg s/session | Failed fixtures | Azure $ | Pass A atoms | Pass B atoms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen2.5:7b | 80% | 82% | 81% | 18% | 53% | 18% | 0 | 41.6s | 0 | $0.0000 | — | — |

_Judge: Azure gpt-5-mini (reasoning_effort=low). Estimated judge spend this run: ~$0.060._

## Judge self-agreement

_Same (model, fixture) extracted-atom set re-judged N times unchanged — variance here is JUDGE noise, not model/extraction noise._

| Fixture | Repeats | Recall | Precision | F1 |
|---|---|---|---|---|
| fx01-clean-decision | 3 | 100% ± 0% | 100% ± 0% | 100% ± 0% |
| fx02-debugging-race-condition | 3 | 100% ± 0% | 100% ± 0% | 100% ± 0% |

## Gates

- qwen2.5:7b — local-viable: FAIL (typeAcc 53% < 60%, evidenceAcc 18% < 90%); production-preferred: FAIL (F1 81% < 88%, typeAcc 53% < 75%, junk 18% > 10%, evidenceAcc 18% < 95%)