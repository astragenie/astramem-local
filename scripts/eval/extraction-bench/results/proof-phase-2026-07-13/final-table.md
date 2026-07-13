| Config | F1 range | Recall range | Precision range | Atoms (avg) | Relations (avg) | Cost (total) | Latency (avg/session) |
|---|---|---|---|---|---|---|---|
| A (qwen2.5-coder:7b + OLD prompt (v1 rollback)) | 66%–66% | 58%–58% | 75%–75% | 11.0 | 0.0 | $0.0000 | 28.3s |
| B (codex-subscription gpt-5.4-mini + v3) | 78%–80% | 67%–67% | 94%–100% | 9.0 | 17.0 | $0.0000 | 18.3s |
| C (codex-subscription gpt-5.5 + v3) | 59%–67% | 42%–50% | 100%–100% | 9.5 | 14.5 | $0.0000 | 19.3s |
| D (qwen2.5-coder:7b + NEW prompt (v3, current default)) | 64%–71% | 58%–67% | 70%–75% | 10.0 | 2.5 | $0.0000 | 28.5s |