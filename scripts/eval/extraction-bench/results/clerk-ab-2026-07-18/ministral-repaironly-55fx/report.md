# Extraction-bench results

| Model | Recall | Precision | F1 | Junk rate | Type acc | Evidence acc | Over-extract (nothing fx) | Avg s/session | Failed fixtures | Azure $ | Pass A atoms | Pass B atoms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen2.5:7b | 74% | 77% | 76% | 21% | 61% | 22% | 0 | 60.3s | 2 | $0.0000 | — | — |

_Judge: Azure gpt-5-mini (reasoning_effort=low). Estimated judge spend this run: ~$0.060._

## Judge self-agreement

_Same (model, fixture) extracted-atom set re-judged N times unchanged — variance here is JUDGE noise, not model/extraction noise._

| Fixture | Repeats | Recall | Precision | F1 |
|---|---|---|---|---|
| fx01-clean-decision | 3 | 100% ± 0% | 100% ± 0% | 100% ± 0% |
| fx02-debugging-race-condition | 3 | 60% ± 0% | 62% ± 33% | 58% ± 14% |

## Gates

- qwen2.5:7b — local-viable: FAIL (F1 76% < 80%, junk 21% > 20%, evidenceAcc 22% < 90%); production-preferred: FAIL (F1 76% < 88%, typeAcc 61% < 75%, junk 21% > 10%, evidenceAcc 22% < 95%)