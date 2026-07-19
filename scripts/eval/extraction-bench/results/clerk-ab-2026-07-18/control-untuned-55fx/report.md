# Extraction-bench results

| Model | Recall | Precision | F1 | Junk rate | Type acc | Evidence acc | Over-extract (nothing fx) | Avg s/session | Failed fixtures | Azure $ | Pass A atoms | Pass B atoms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen2.5:7b | 77% | 81% | 79% | 19% | 44% | 25% | 0 | 31.8s | 0 | $0.0000 | — | — |

_Judge: Azure gpt-5-mini (reasoning_effort=low). Estimated judge spend this run: ~$0.060._

## Judge self-agreement

_Same (model, fixture) extracted-atom set re-judged N times unchanged — variance here is JUDGE noise, not model/extraction noise._

| Fixture | Repeats | Recall | Precision | F1 |
|---|---|---|---|---|
| fx01-clean-decision | 3 | 92% ± 14% | 93% ± 12% | 92% ± 13% |
| fx02-debugging-race-condition | 3 | 80% ± 0% | 87% ± 12% | 83% ± 5% |

## Gates

- qwen2.5:7b — local-viable: FAIL (F1 79% < 80%, typeAcc 44% < 60%, evidenceAcc 25% < 90%); production-preferred: FAIL (F1 79% < 88%, typeAcc 44% < 75%, junk 19% > 10%, evidenceAcc 25% < 95%)