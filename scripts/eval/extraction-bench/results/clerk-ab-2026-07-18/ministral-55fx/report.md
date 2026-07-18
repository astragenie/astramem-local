# Extraction-bench results

| Model | Recall | Precision | F1 | Junk rate | Type acc | Evidence acc | Over-extract (nothing fx) | Avg s/session | Failed fixtures | Azure $ | Pass A atoms | Pass B atoms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen2.5:7b | 72% | 90% | 80% | 9% | 56% | 15% | 0 | 46.1s | 0 | $0.0000 | — | — |

_Judge: Azure gpt-5-mini (reasoning_effort=low). Estimated judge spend this run: ~$0.058._

## Judge self-agreement

_Same (model, fixture) extracted-atom set re-judged N times unchanged — variance here is JUDGE noise, not model/extraction noise._

| Fixture | Repeats | Recall | Precision | F1 |
|---|---|---|---|---|
| fx01-clean-decision | 3 | 75% ± 0% | 100% ± 0% | 86% ± 0% |
| fx02-debugging-race-condition | 3 | 20% ± 0% | 25% ± 0% | 22% ± 0% |

## Gates

- qwen2.5:7b — local-viable: FAIL (F1 80% < 80%, typeAcc 56% < 60%, evidenceAcc 15% < 90%); production-preferred: FAIL (F1 80% < 88%, typeAcc 56% < 75%, evidenceAcc 15% < 95%)