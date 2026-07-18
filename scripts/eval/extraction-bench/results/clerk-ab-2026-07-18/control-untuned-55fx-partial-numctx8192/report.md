# Extraction-bench results

| Model | Recall | Precision | F1 | Junk rate | Type acc | Evidence acc | Over-extract (nothing fx) | Avg s/session | Failed fixtures | Azure $ | Pass A atoms | Pass B atoms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen2.5:7b | 78% | 79% | 79% | 20% | 44% | 17% | 0 | 37.1s | 0 | $0.0000 | — | — |

_Judge: Azure gpt-5-mini (reasoning_effort=low). Estimated judge spend this run: ~$0.060._

## Judge self-agreement

_Same (model, fixture) extracted-atom set re-judged N times unchanged — variance here is JUDGE noise, not model/extraction noise._

| Fixture | Repeats | Recall | Precision | F1 |
|---|---|---|---|---|
| fx01-clean-decision | 3 | 100% ± 0% | 100% ± 0% | 100% ± 0% |
| fx02-debugging-race-condition | 3 | 100% ± 0% | 71% ± 14% | 82% ± 9% |

## Gates

- qwen2.5:7b — local-viable: FAIL (F1 79% < 80%, typeAcc 44% < 60%, junk 20% > 20%, evidenceAcc 17% < 90%); production-preferred: FAIL (F1 79% < 88%, typeAcc 44% < 75%, junk 20% > 10%, evidenceAcc 17% < 95%)