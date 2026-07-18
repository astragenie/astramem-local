# Extraction-bench results

| Model | Recall | Precision | F1 | Junk rate | Type acc | Evidence acc | Over-extract (nothing fx) | Avg s/session | Failed fixtures | Azure $ | Pass A atoms | Pass B atoms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen2.5:7b | 70% | 81% | 75% | 19% | 42% | 0% | — | 48.4s | 0 | $0.0000 | — | — |

_Judge: Azure gpt-5-mini (reasoning_effort=low). Estimated judge spend this run: ~$0.011._

## Judge self-agreement

_Same (model, fixture) extracted-atom set re-judged N times unchanged — variance here is JUDGE noise, not model/extraction noise._

| Fixture | Repeats | Recall | Precision | F1 |
|---|---|---|---|---|
| fx01-clean-decision | 3 | 75% ± 0% | 100% ± 0% | 86% ± 0% |
| fx02-debugging-race-condition | 3 | 53% ± 12% | 75% ± 25% | 62% ± 16% |

## Gates

_gates calibrated against 55 fixtures; 5 present — floors may not reflect current corpus difficulty._

- qwen2.5:7b — local-viable: FAIL (F1 75% < 80%, typeAcc 42% < 60%, evidenceAcc 0% < 90%); production-preferred: FAIL (F1 75% < 88%, typeAcc 42% < 75%, junk 19% > 10%, evidenceAcc 0% < 95%)