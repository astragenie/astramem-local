# Extraction-bench results

| Model | Recall | Precision | F1 | Junk rate | Type acc | Over-extract (nothing fx) | Avg s/session | Failed fixtures | Azure $ |
|---|---|---|---|---|---|---|---|---|---|
| qwen3.5:4b (n=3) | 54% ± 4% | 93% ± 4% | 68% ± 2% | 5% | 60% ± 4% | 0 | 49.4s | 1 | $0.0000 |

_Judge: Azure gpt-5-mini (reasoning_effort=low). Estimated judge spend this run: ~$0.128._

## Judge self-agreement

_Same (model, fixture) extracted-atom set re-judged N times unchanged — variance here is JUDGE noise, not model/extraction noise._

| Fixture | Repeats | Recall | Precision | F1 |
|---|---|---|---|---|
| fx01-clean-decision | 3 | 75% ± 0% | 100% ± 0% | 86% ± 0% |
| fx02-debugging-race-condition | 3 | 60% ± 0% | 100% ± 0% | 75% ± 0% |