# Extraction-bench results

| Model | Recall | Precision | F1 | Junk rate | Type acc | Evidence acc | Over-extract (nothing fx) | Avg s/session | Failed fixtures | Azure $ | Pass A atoms | Pass B atoms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen2.5:7b | 67% | 100% | 80% | 0% | 59% | 0% | — | 67.8s | 0 | $0.0000 | — | — |

_Judge: Azure gpt-5-mini (reasoning_effort=low). Estimated judge spend this run: ~$0.011._

## Judge self-agreement

_Same (model, fixture) extracted-atom set re-judged N times unchanged — variance here is JUDGE noise, not model/extraction noise._

| Fixture | Repeats | Recall | Precision | F1 |
|---|---|---|---|---|
| fx01-clean-decision | 3 | 75% ± 0% | 83% ± 14% | 79% ± 6% |
| fx02-debugging-race-condition | 3 | 100% ± 0% | 100% ± 0% | 100% ± 0% |

## Gates

_gates calibrated against 55 fixtures; 5 present — floors may not reflect current corpus difficulty._

- qwen2.5:7b — local-viable: FAIL (typeAcc 59% < 60%, evidenceAcc 0% < 90%); production-preferred: FAIL (F1 80% < 88%, typeAcc 59% < 75%, evidenceAcc 0% < 95%)