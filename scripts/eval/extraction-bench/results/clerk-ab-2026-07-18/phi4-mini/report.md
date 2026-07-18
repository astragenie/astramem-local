# Extraction-bench results

| Model | Recall | Precision | F1 | Junk rate | Type acc | Evidence acc | Over-extract (nothing fx) | Avg s/session | Failed fixtures | Azure $ | Pass A atoms | Pass B atoms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen2.5:7b | 49% | 90% | 63% | 10% | 43% | 0% | — | 49.1s | 0 | $0.0000 | — | — |

_Judge: Azure gpt-5-mini (reasoning_effort=low). Estimated judge spend this run: ~$0.011._

## Judge self-agreement

_Same (model, fixture) extracted-atom set re-judged N times unchanged — variance here is JUDGE noise, not model/extraction noise._

| Fixture | Repeats | Recall | Precision | F1 |
|---|---|---|---|---|
| fx01-clean-decision | 3 | 50% ± 0% | 100% ± 0% | 67% ± 0% |
| fx02-debugging-race-condition | 3 | 80% ± 0% | 100% ± 0% | 89% ± 0% |

## Gates

_gates calibrated against 55 fixtures; 5 present — floors may not reflect current corpus difficulty._

- qwen2.5:7b — local-viable: FAIL (F1 63% < 80%, typeAcc 43% < 60%, evidenceAcc 0% < 90%); production-preferred: FAIL (F1 63% < 88%, typeAcc 43% < 75%, evidenceAcc 0% < 95%)