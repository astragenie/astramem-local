# LoCoMo oracle factorial

Cell = llm-judge cat-avg (token-F1 cat-avg). `n/a` = cell not run this invocation.

| source \ answerer | strong | zep-match |
|---|---|---|
| gold-turns | 0.4169 (0.4071) | 0.5349 (0.4994) |
| retrieved-atoms | 0.3995 (0.3736) | 0.4260 (0.3928) |

## Per-category detail

### gold-turns x strong

| category | f1 | llm-judge | n |
|---|---|---|---|
| 1 (multi-hop) | 0.3980 | 0.4375 | 32 |
| 2 (temporal) | 0.4831 | 0.5676 | 37 |
| 3 (open-domain) | 0.2143 | 0.0769 | 13 |
| 4 (single-hop) | 0.5332 | 0.5857 | 70 |
| 5 (adversarial) | n/a | n/a | 0 |

### gold-turns x zep-match

| category | f1 | llm-judge | n |
|---|---|---|---|
| 1 (multi-hop) | 0.4769 | 0.5313 | 32 |
| 2 (temporal) | 0.5069 | 0.4865 | 37 |
| 3 (open-domain) | 0.3886 | 0.3077 | 13 |
| 4 (single-hop) | 0.6253 | 0.8143 | 70 |
| 5 (adversarial) | n/a | n/a | 0 |

### retrieved-atoms x strong

| category | f1 | llm-judge | n |
|---|---|---|---|
| 1 (multi-hop) | 0.3029 | 0.2813 | 32 |
| 2 (temporal) | 0.5512 | 0.6486 | 37 |
| 3 (open-domain) | 0.2436 | 0.1538 | 13 |
| 4 (single-hop) | 0.3965 | 0.5143 | 70 |
| 5 (adversarial) | n/a | n/a | 0 |

### retrieved-atoms x zep-match

| category | f1 | llm-judge | n |
|---|---|---|---|
| 1 (multi-hop) | 0.2746 | 0.2500 | 32 |
| 2 (temporal) | 0.5707 | 0.5946 | 37 |
| 3 (open-domain) | 0.2949 | 0.2308 | 13 |
| 4 (single-hop) | 0.4311 | 0.6286 | 70 |
| 5 (adversarial) | n/a | n/a | 0 |
