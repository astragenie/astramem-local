# Extraction-bench results

| Model | Recall | Precision | F1 | Junk rate | Type acc | Evidence acc | Over-extract (nothing fx) | Avg s/session | Failed fixtures | Azure $ | Pass A atoms | Pass B atoms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| qwen2.5:7b | 79% | 78% | 78% | 21% | 44% | 17% | 0 | 44.5s | 0 | $0.0000 | — | — |

_Judge: Azure gpt-5-mini (reasoning_effort=low). Estimated judge spend this run: ~$0.060._

## Judge self-agreement

_Same (model, fixture) extracted-atom set re-judged N times unchanged — variance here is JUDGE noise, not model/extraction noise._

| Fixture | Repeats | Recall | Precision | F1 |
|---|---|---|---|---|
| fx01-clean-decision | 3 | 100% ± 0% | 100% ± 0% | 100% ± 0% |
| fx02-debugging-race-condition | 3 | 80% ± 0% | 57% ± 0% | 67% ± 0% |

## Gates

- qwen2.5:7b — local-viable: FAIL (F1 78% < 80%, typeAcc 44% < 60%, junk 21% > 20%, evidenceAcc 17% < 90%); production-preferred: FAIL (F1 78% < 88%, typeAcc 44% < 75%, junk 21% > 10%, evidenceAcc 17% < 95%)