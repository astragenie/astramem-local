# Extraction-bench results

| Model | Recall | Precision | F1 | Junk rate | Type acc | Over-extract (nothing fx) | Avg s/session | Failed fixtures | Azure $ |
|---|---|---|---|---|---|---|---|---|---|
| qwen2.5-coder:7b | 44% | 90% | 59% | 8% | 40% | 0 | 8.7s | 0 | $0.0000 |
| qwen2.5:7b | 51% | 99% | 67% | 1% | 51% | 0 | 21.6s | 1 | $0.0000 |
| qwen3:8b | 48% | 98% | 65% | 1% | 31% | 0 | 52.3s | 1 | $0.0000 |
| phi4-mini | 37% | 100% | 54% | 0% | 56% | 0 | 28.8s | 0 | $0.0000 |
| nuextract:adapted | 0% | — | — | 0% | — | 0 | 17.9s | 0 | $0.0000 |
| azure:gpt-5-mini | 68% | 100% | 81% | 0% | 55% | 0 | 8.5s | 0 | $0.0146 |

_Judge: Azure gpt-5-mini (reasoning_effort=minimal). Estimated judge spend this run: ~$0.084._