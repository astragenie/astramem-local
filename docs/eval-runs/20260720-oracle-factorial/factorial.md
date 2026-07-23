# LoCoMo oracle factorial

Cell = llm-judge cat-avg (token-F1 cat-avg). `n/a` = cell not run this invocation.

| source \ answerer | canonical | current |
|---|---|---|
| gold-atoms | 0.4519 (0.4612) | 0.4683 (0.4319) |
| gold-turns | 0.5260 (0.5311) | 0.5022 (0.4582) |
| retrieved-atoms | 0.4605 (0.4020) | 0.4459 (0.3997) |
| retrieved-spans | 0.4563 (0.3938) | 0.4467 (0.4076) |

## Per-category detail

### gold-atoms x canonical

| category | f1 | llm-judge | n |
|---|---|---|---|
| 1 (multi-hop) | 0.3848 | 0.3125 | 32 |
| 2 (temporal) | 0.5641 | 0.5676 | 37 |
| 3 (open-domain) | 0.4453 | 0.3846 | 13 |
| 4 (single-hop) | 0.4507 | 0.5429 | 70 |
| 5 (adversarial) | n/a | n/a | 0 |

### gold-atoms x current

| category | f1 | llm-judge | n |
|---|---|---|---|
| 1 (multi-hop) | 0.3265 | 0.3438 | 32 |
| 2 (temporal) | 0.5911 | 0.6216 | 37 |
| 3 (open-domain) | 0.3168 | 0.3077 | 13 |
| 4 (single-hop) | 0.4933 | 0.6000 | 70 |
| 5 (adversarial) | n/a | n/a | 0 |

### gold-turns x canonical

| category | f1 | llm-judge | n |
|---|---|---|---|
| 1 (multi-hop) | 0.5206 | 0.4375 | 32 |
| 2 (temporal) | 0.5763 | 0.5676 | 37 |
| 3 (open-domain) | 0.4606 | 0.3846 | 13 |
| 4 (single-hop) | 0.5669 | 0.7143 | 70 |
| 5 (adversarial) | n/a | n/a | 0 |

### gold-turns x current

| category | f1 | llm-judge | n |
|---|---|---|---|
| 1 (multi-hop) | 0.4262 | 0.5625 | 32 |
| 2 (temporal) | 0.4387 | 0.3243 | 37 |
| 3 (open-domain) | 0.2756 | 0.3077 | 13 |
| 4 (single-hop) | 0.6922 | 0.8143 | 70 |
| 5 (adversarial) | n/a | n/a | 0 |

### retrieved-atoms x canonical

| category | f1 | llm-judge | n |
|---|---|---|---|
| 1 (multi-hop) | 0.3042 | 0.2813 | 32 |
| 2 (temporal) | 0.4824 | 0.5135 | 37 |
| 3 (open-domain) | 0.3904 | 0.4615 | 13 |
| 4 (single-hop) | 0.4312 | 0.5857 | 70 |
| 5 (adversarial) | n/a | n/a | 0 |

### retrieved-atoms x current

| category | f1 | llm-judge | n |
|---|---|---|---|
| 1 (multi-hop) | 0.2698 | 0.2188 | 32 |
| 2 (temporal) | 0.5477 | 0.5946 | 37 |
| 3 (open-domain) | 0.3476 | 0.3846 | 13 |
| 4 (single-hop) | 0.4337 | 0.5857 | 70 |
| 5 (adversarial) | n/a | n/a | 0 |

### retrieved-spans x canonical

| category | f1 | llm-judge | n |
|---|---|---|---|
| 1 (multi-hop) | 0.2891 | 0.2500 | 32 |
| 2 (temporal) | 0.4374 | 0.5135 | 37 |
| 3 (open-domain) | 0.3705 | 0.4615 | 13 |
| 4 (single-hop) | 0.4782 | 0.6000 | 70 |
| 5 (adversarial) | n/a | n/a | 0 |

### retrieved-spans x current

| category | f1 | llm-judge | n |
|---|---|---|---|
| 1 (multi-hop) | 0.2394 | 0.2188 | 32 |
| 2 (temporal) | 0.5451 | 0.5405 | 37 |
| 3 (open-domain) | 0.3449 | 0.3846 | 13 |
| 4 (single-hop) | 0.5012 | 0.6429 | 70 |
| 5 (adversarial) | n/a | n/a | 0 |
