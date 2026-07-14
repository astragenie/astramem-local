# Extraction-bench results

| Model | Recall | Precision | F1 | Junk rate | Type acc | Over-extract (nothing fx) | Avg s/session | Failed fixtures | Azure $ |
|---|---|---|---|---|---|---|---|---|---|
| chunkChars=3200 | 61% | 97% | 75% | 2% | 56% | 0 | 9.6s | 0 | $0.0000 |
| chunkChars=2400 | 67% | 90% | 77% | 8% | 64% | 0 | 10.3s | 0 | $0.0000 |
| chunkChars=1600 | 61% | 93% | 74% | 5% | 67% | 0 | 10.6s | 0 | $0.0000 |
| chunkChars=1200 | 63% | 94% | 76% | 4% | 58% | 0 | 12.8s | 0 | $0.0000 |
| chunkChars=800 | 70% | 92% | 79% | 6% | 75% | 0 | 19.1s | 0 | $0.0000 |

_Judge: Azure gpt-5-mini (reasoning_effort=low). Estimated judge spend this run: ~$0.061._