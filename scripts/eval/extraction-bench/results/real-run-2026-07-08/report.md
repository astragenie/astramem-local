# Extraction-bench results

| Model | Recall | Precision | F1 | Junk rate | Type acc | Over-extract (nothing fx) | Avg s/session | Failed fixtures | Azure $ |
|---|---|---|---|---|---|---|---|---|---|
| qwen2.5-coder:7b | 43% | 87% | 57% | 12% | 31% | 0 | 9.9s | 0 | $0.0000 |
| llama3.1:8b | 53% | 87% | 66% | 10% | 37% | 2 | 29.8s | 0 | $0.0000 |
| qwen2.5-coder:14b | 41% | 95% | 57% | 3% | 42% | 0 | 72.7s | 3 | $0.0000 |
| azure:gpt-5-mini | 55% | 86% | 67% | 13% | 57% | 1 | 8.7s | 0 | $0.0132 |

_Judge: Azure gpt-5-mini (reasoning_effort=minimal). Estimated judge spend this run: ~$0.058._