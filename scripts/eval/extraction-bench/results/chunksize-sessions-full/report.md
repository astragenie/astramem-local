# #273 chunk-size sweep — real LoCoMo sessions (codex-subscription)

Model: gpt-5.4-mini (compaction + extraction, both cloud). Sizes: 3200, 2400, 1600, 1200, 800.

| Session | maxChunkChars | chunks | atoms | wallMs | facts recovered |
|---|---|---|---|---|---|
| conv-26/s10 | 3200 | 2 | 0 | 15504 | ❌ beach-frequency ("once or twice a year"); ❌ meteor-shower awe ("tiny", "awe of the universe") |
| conv-44/s18 | 3200 | 2 | 0 | 10890 | ❌ dog-bed quote ("Super cozy and comfy"); ❌ hiking sunset photo; ❌ daily self-care habit |
| conv-47/s22 | 3200 | 1 | 4 | 19691 | — |
| conv-30/s13 | 3200 | 1 | 2 | 15991 | — |
| conv-48/s20 | 3200 | 1 | 6 | 12473 | — |
| conv-43/s2 | 3200 | 1 | 6 | 13652 | — |
| conv-26/s10 | 2400 | 2 | 0 | 14202 | ❌ beach-frequency ("once or twice a year"); ❌ meteor-shower awe ("tiny", "awe of the universe") |
| conv-44/s18 | 2400 | 2 | 0 | 22205 | ❌ dog-bed quote ("Super cozy and comfy"); ❌ hiking sunset photo; ❌ daily self-care habit |
| conv-47/s22 | 2400 | 2 | 5 | 19947 | — |
| conv-30/s13 | 2400 | 2 | 6 | 28597 | — |
| conv-48/s20 | 2400 | 2 | 4 | 17343 | — |
| conv-43/s2 | 2400 | 2 | 0 | 11930 | — |
| conv-26/s10 | 1600 | 3 | 5 | 30215 | ❌ beach-frequency ("once or twice a year"); ❌ meteor-shower awe ("tiny", "awe of the universe") |
| conv-44/s18 | 1600 | 3 | 0 | 22105 | ❌ dog-bed quote ("Super cozy and comfy"); ❌ hiking sunset photo; ❌ daily self-care habit |
| conv-47/s22 | 1600 | 3 | 5 | 29453 | — |
| conv-30/s13 | 1600 | 2 | 0 | 14426 | — |
| conv-48/s20 | 1600 | 3 | 2 | 30291 | — |
| conv-43/s2 | 1600 | 2 | 1 | 17257 | — |
| conv-26/s10 | 1200 | 4 | 8 | 57568 | ✅ beach-frequency ("once or twice a year"); ✅ meteor-shower awe ("tiny", "awe of the universe") |
| conv-44/s18 | 1200 | 4 | 2 | 34285 | ❌ dog-bed quote ("Super cozy and comfy"); ❌ hiking sunset photo; ❌ daily self-care habit |
| conv-47/s22 | 1200 | 3 | 6 | 34562 | — |
| conv-30/s13 | 1200 | 3 | 3 | 24429 | — |
| conv-48/s20 | 1200 | 3 | 0 | 22840 | — |
| conv-43/s2 | 1200 | 3 | 1 | 20802 | — |
| conv-26/s10 | 800 | 7 | 2 | 62744 | ❌ beach-frequency ("once or twice a year"); ❌ meteor-shower awe ("tiny", "awe of the universe") |
| conv-44/s18 | 800 | 5 | 0 | 25881 | ❌ dog-bed quote ("Super cozy and comfy"); ❌ hiking sunset photo; ❌ daily self-care habit |
| conv-47/s22 | 800 | 5 | 6 | 39710 | — |
| conv-30/s13 | 800 | 5 | 6 | 40931 | — |
| conv-48/s20 | 800 | 5 | 0 | 27533 | — |
| conv-43/s2 | 800 | 5 | 3 | 32318 | — |

## Per-session yield curve (atoms vs. maxChunkChars)

**conv-26/s10**: 3200→0atoms/2chunks  |  2400→0atoms/2chunks  |  1600→5atoms/3chunks  |  1200→8atoms/4chunks  |  800→2atoms/7chunks
**conv-44/s18**: 3200→0atoms/2chunks  |  2400→0atoms/2chunks  |  1600→0atoms/3chunks  |  1200→2atoms/4chunks  |  800→0atoms/5chunks
**conv-47/s22**: 3200→4atoms/1chunks  |  2400→5atoms/2chunks  |  1600→5atoms/3chunks  |  1200→6atoms/3chunks  |  800→6atoms/5chunks
**conv-30/s13**: 3200→2atoms/1chunks  |  2400→6atoms/2chunks  |  1600→0atoms/2chunks  |  1200→3atoms/3chunks  |  800→6atoms/5chunks
**conv-48/s20**: 3200→6atoms/1chunks  |  2400→4atoms/2chunks  |  1600→2atoms/3chunks  |  1200→0atoms/3chunks  |  800→0atoms/5chunks
**conv-43/s2**: 3200→6atoms/1chunks  |  2400→0atoms/2chunks  |  1600→1atoms/2chunks  |  1200→1atoms/3chunks  |  800→3atoms/5chunks

## Cost

Total extraction runs: 30. Total chunk-level LLM calls (compact+extract): ~176. Total usageUsd reported: $0.0000 (codex-subscription — quota-metered, not per-token billed the same way; usageUsd may read 0).