# Mem0 + Zep LoCoMo harness extraction — verbatim prompts, judge models, methodology gaps

**Date:** 2026-07-23
**Type:** Read-only web/source research (no code changes)
**Purpose:** Extract the exact answer-generation + LLM-judge harness Mem0 and Zep used to produce
their published LoCoMo numbers, so our own harness can replicate each methodology and separate
"answer format + judge rubric" effects from actual memory-quality effects. Requested by team-lead
for a cross-harness A/B.

## Headline finding — read this before quoting either vendor's number

The two headline numbers in the request (**Mem0 ≈0.66–0.68 J**, **Zep ≈0.947**) are **not
apples-to-apples with each other or internally consistent with each vendor's own published
methodology**:

- **Mem0's ~0.66–0.68 J** is directly reproducible from Mem0's own open-sourced prompts + code
  (below) — `gpt-4o-mini` judge, single-run-able, category 5 excluded. This is the most trustworthy
  number of the two because the harness that produced it is fully public and unchanged in spirit
  since the paper.
- **Zep's ~0.947** does **not** come from the arXiv paper (2501.13956) — that paper only reports
  **DMR** (94.8%) and **LongMemEval** (63.8%/71.2%), and never mentions LoCoMo at all. The 94.7%
  LoCoMo figure comes from Zep's own marketing research page
  (`getzep.com/research/`), which states the judge was **`gpt-5.4` with "chain-of-thought
  grading"** over a richer "multi-scope retrieval" (20 edges, 10 nodes, 10 episodes, 5 thread
  summaries, 5 observations, cross-encoder reranking) — a config that **does not exist** in Zep's
  own open-sourced `benchmarks/locomo` harness (which only models edges + nodes). When I ran the
  numbers on Zep's own checked-in harness config (`gpt-4o-mini` judge + `gpt-4o-mini` responder,
  cross-encoder rerank, 30/30 edge/node limit — the most recent experiment logged in-repo,
  2025-12-07), the **measured mean accuracy across 10 runs was 0.803 ± 0.004**, not 0.947. See §B4.
  **The prompt text and exact retrieval config behind the 94.7% figure is not published anywhere I
  could find** — it is a claimed number, not a reproducible one.
- Separately, Zep's LoCoMo claims have a documented history of methodology disputes with Mem0
  (84% → corrected 58.44% → Zep counter-claim 75.14%; see §B2–B3) that predate the 94.7%/gpt-5.4
  figure. Three different Zep LoCoMo numbers exist in the wild (84%, 58.44%/75.14% disputed
  pair, 94.7%) from three different harnesses/judges. None of them is the one in the Jan-2025
  arXiv paper.

**Practical implication for our A/B:** we can faithfully replicate Mem0's harness (verbatim source
below). We can also faithfully replicate Zep's two *open-sourced* harnesses (the disputed
2025-04 one and the current `benchmarks/locomo` one) — both land Zep in the 58–80% band with
`gpt-4o-mini`, nowhere near 94.7%. We **cannot** faithfully replicate the 94.7% figure itself
because its prompt text, judge chain-of-thought instructions, and "episodes/thread
summaries/observations" retrieval config are unpublished. Any claim we make about "the Zep
harness" should cite which of the three Zep harnesses we mean.

---

## A. Mem0 — fully reproducible, verbatim from source

Source: [`mem0ai/mem0`](https://github.com/mem0ai/mem0), directory `evaluation/` **at commit
[`aae5989e78`](https://github.com/mem0ai/mem0/commit/aae5989e78)** (2025-07-08) — the last commit
before `evaluation/` was retired to a submodule pointing at the unrelated
[`mem0ai/memory-benchmarks`](https://github.com/mem0ai/memory-benchmarks) Next.js dashboard repo
(`chore: retire in-repo evaluation/ in favor of mem0ai/memory-benchmarks (#5520)`, 2026-06-13) —
**that submodule repo does NOT contain the original eval scripts**; go to the pinned commit above
for the real code. Cross-checked against the paper's Appendix A
([arXiv 2504.19413](https://arxiv.org/abs/2504.19413), "Mem0: Building Production-Ready AI Agents
with Scalable Long-Term Memory") — the two match verbatim except the code has a couple of
straight-vs-curly-quote and minor whitespace differences from the LaTeX rendering.

### A1. Answer-generation prompt

Source: [`evaluation/prompts.py`](https://github.com/mem0ai/mem0/blob/aae5989e78/evaluation/prompts.py)

```text
ANSWER_PROMPT = """
    You are an intelligent memory assistant tasked with retrieving accurate information from conversation memories.

    # CONTEXT:
    You have access to memories from two speakers in a conversation. These memories contain 
    timestamped information that may be relevant to answering the question.

    # INSTRUCTIONS:
    1. Carefully analyze all provided memories from both speakers
    2. Pay special attention to the timestamps to determine the answer
    3. If the question asks about a specific event or fact, look for direct evidence in the memories
    4. If the memories contain contradictory information, prioritize the most recent memory
    5. If there is a question about time references (like "last year", "two months ago", etc.), 
       calculate the actual date based on the memory timestamp. For example, if a memory from 
       4 May 2022 mentions "went to India last year," then the trip occurred in 2021.
    6. Always convert relative time references to specific dates, months, or years. For example, 
       convert "last year" to "2022" or "two months ago" to "March 2023" based on the memory 
       timestamp. Ignore the reference while answering the question.
    7. Focus only on the content of the memories from both speakers. Do not confuse character 
       names mentioned in memories with the actual users who created those memories.
    8. The answer should be less than 5-6 words.

    # APPROACH (Think step by step):
    1. First, examine all memories that contain information related to the question
    2. Examine the timestamps and content of these memories carefully
    3. Look for explicit mentions of dates, times, locations, or events that answer the question
    4. If the answer requires calculation (e.g., converting relative time references), show your work
    5. Formulate a precise, concise answer based solely on the evidence in the memories
    6. Double-check that your answer directly addresses the question asked
    7. Ensure your final answer is specific and avoids vague time references

    Memories for user {{speaker_1_user_id}}:

    {{speaker_1_memories}}

    Memories for user {{speaker_2_user_id}}:

    {{speaker_2_memories}}

    Question: {{question}}

    Answer:
    """
```

**Answer format:** free-text, explicitly capped at **"less than 5-6 words"** — this is the single
biggest lever separating Mem0's number from a token-F1-style harness: a 5-6 word answer format is
tuned to make the generous CORRECT/WRONG judge (below) easy to satisfy, and is a poor fit for a
strict token-F1 metric.

A `Mem0^g` (graph) variant adds a step 9 ("Use the knowledge graph relations...") and interleaves
`Relations for user {{speaker_N_user_id}}:` blocks between each speaker's memories — same
answer-format constraint. A third `ANSWER_PROMPT_ZEP` variant (single `{{memories}}` block, no
per-speaker split) is what Mem0's own harness used to prompt a downstream LLM when evaluating
**Zep** as a baseline inside Mem0's harness — i.e. this is Mem0's code for querying Zep, not Zep's
own harness (see §B for Zep's own).

### A2. LLM-judge prompt

Source: [`evaluation/metrics/llm_judge.py`](https://github.com/mem0ai/mem0/blob/aae5989e78/evaluation/metrics/llm_judge.py)
(also embedded verbatim in [`evaluation/generate_scores.py`](https://github.com/mem0ai/mem0/blob/aae5989e78/evaluation/generate_scores.py) callers)

```python
ACCURACY_PROMPT = """
Your task is to label an answer to a question as ’CORRECT’ or ’WRONG’. You will be given the following data:
    (1) a question (posed by one user to another user), 
    (2) a ’gold’ (ground truth) answer, 
    (3) a generated answer
which you will score as CORRECT/WRONG.

The point of the question is to ask about something one user should know about the other user based on their prior conversations.
The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
Question: Do you remember what I got the last time I went to Hawaii?
Gold answer: A shell necklace
The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT. 

For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.

Now it's time for the real question:
Question: {question}
Gold answer: {gold_answer}
Generated answer: {generated_answer}

First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG. 
Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.

Just return the label CORRECT or WRONG in a json format with the key as "label".
"""


def evaluate_llm_judge(question, gold_answer, generated_answer):
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[{"role": "user", "content": ACCURACY_PROMPT.format(
            question=question, gold_answer=gold_answer, generated_answer=generated_answer)}],
        response_format={"type": "json_object"},
        temperature=0.0,
    )
    label = json.loads(extract_json(response.choices[0].message.content))["label"]
    return 1 if label == "CORRECT" else 0
```

**Judge model:** `gpt-4o-mini`, `temperature=0.0`, forced JSON object output, single user-turn
message (no system prompt). Note the prompt is a single OpenAI **user** message, not
system+user — the Mem0 paper's Appendix A credits this rubric as adapted from Packer et al. 2023
(the MemGPT paper).

**Output format:** binary label, `{"label": "CORRECT" | "WRONG"}`, plus a free-text one-sentence
reasoning field that is generated but not stored/used beyond the label extraction (`extract_json`
pulls just the label key). No 1-5 scale, no partial credit — pure binary accuracy.

The rubric is explicitly **generous**: "as long as it touches on the same topic... CORRECT" and
for dates "even if the format differs... consider it CORRECT if it's the same date." This is a
deliberately loose bar, not a strict-match judge.

### A3. Per-category handling — adversarial (category 5) is excluded

Verbatim from [`evaluation/metrics/llm_judge.py`](https://github.com/mem0ai/mem0/blob/aae5989e78/evaluation/metrics/llm_judge.py) (`generate_scores.py` driver):

```python
# Skip category 5
if int(category) == 5:
    continue
```

and from [`evaluation/evals.py`](https://github.com/mem0ai/mem0/blob/aae5989e78/evaluation/evals.py):

```python
# Skip category 5
if category == "5":
    continue
```

Matches the paper body verbatim (§3.1 Dataset):

> "The dataset originally included an adversarial question category, which was designed to test
> systems' ability to recognize unanswerable questions. However, this category was excluded from
> our evaluation because ground truth answers were unavailable, and the expected behavior for this
> question type is that the agent should recognize them as unanswerable."

Four categories are scored: single-hop, multi-hop, temporal, open-domain.

### A4. Metric definition — J score

From the paper (§3.2 Evaluation Metrics), verbatim:

> "we use LLM-as-a-Judge (J) as a complementary evaluation metric... Due to the stochastic nature
> of J evaluations, we conducted 10 independent runs for each method on the entire dataset and
> report the mean scores along with ± 1 standard deviation."

`evaluation/generate_scores.py` (pandas aggregation) computes the **overall** mean by flattening
every question-level record across all (non-category-5) categories into one DataFrame and taking
`df["llm_score"].mean()` — i.e. it is a **pooled per-question mean**, not an average-of-per-category-
averages (those two differ whenever category sizes are unequal, which they are in LoCoMo). Report
also breaks out `groupby("category")` means separately. Also computes F1 and BLEU-1 the same way
for comparison, explicitly noting (verbatim, §3.2):

> "Consider a scenario where the ground truth answer is 'Alice was born in March' and a system
> generates 'Alice is born in July.' Despite containing a critical factual error... traditional
> metrics would assign relatively high scores due to lexical overlap."

— i.e. Mem0's own paper argues F1/BLEU-1 are unreliable for this task, motivating J as the
headline metric.

---

## B. Zep — three different harnesses, three different numbers, none matching 0.947 reproducibly

Zep's LoCoMo story is **not one harness** — it's at least three, over roughly a year, each
producing a different headline number. None of the three has a source I could confirm produces
0.947 end-to-end.

### B1. Timeline

| Date (approx) | Source | Claimed LoCoMo score | Judge | Status |
|---|---|---|---|---|
| ~2025-01 (arXiv 2501.13956 "Zep: A Temporal KG Architecture for Agent Memory") | paper | **not reported** — paper covers DMR (94.8%) and LongMemEval only | n/a | LoCoMo isn't in this paper at all |
| ~2025-04 (blog + `zep-papers` repo, disputed) | `getzep/zep-papers` | **84%** claimed by Zep → Mem0 re-ran and got **58.44% ± 0.20** (vs 65.99% for Zep's prior algorithm) → Zep counter-claimed **75.14%** | `gpt-4o-mini` | disputed, see §B2 |
| 2025-12 (current, in-repo) | `getzep/zep` `benchmarks/locomo/` | **not marketed**, but I ran the numbers from the repo's own logged experiment: **0.803 mean ± 0.004** (10 runs, 2025-12-07 config) | `gpt-4o-mini` | reproducible, see §B3 |
| current marketing (`getzep.com/research/`) | blog/landing page only, no repo | **94.7%** (1,459/1,540 correct) | **`gpt-5.4`, "chain-of-thought grading"** | **not reproducible** — no prompt/config published, see §B4 |

### B2. The disputed 2025-04 harness (84% → 58.44%/75.14%)

Source: [`getzep/zep-papers`](https://github.com/getzep/zep-papers), directory
`kg_architecture_agent_memory/locomo_eval/` — files `zep_locomo_responses.py` (answer generation)
and `zep_locomo_eval.py` (judge), plus the dispute writeup in
[getzep/zep-papers#5 "Revisiting Zep's 84% LoCoMo Claim: Corrected Evaluation & 58.44% Accuracy"](https://github.com/getzep/zep-papers/issues/5).

**Answer-generation prompt** (verbatim, `zep_locomo_responses.py`):

```python
system_prompt = """
    You are a helpful expert assistant answering questions from lme_experiment users based on the provided context.
    """

prompt = f"""
# CONTEXT:
You have access to facts and entities from a conversation.

# INSTRUCTIONS:
1. Carefully analyze all provided memories
2. Pay special attention to the timestamps to determine the answer
3. If the question asks about a specific event or fact, look for direct evidence in the memories
4. If the memories contain contradictory information, prioritize the most recent memory
5. Always convert relative time references to specific dates, months, or years.
6. Be as specific as possible when talking about people, places, and events
7. Timestamps in memories represent the actual time the event occurred, not the time the event was mentioned in a message.

Clarification:
When interpreting memories, use the timestamp to determine when the described event happened, not when someone talked about the event.

Example:

Memory: (2023-03-15T16:33:00Z) I went to the vet yesterday.
Question: What day did I go to the vet?
Correct Answer: March 15, 2023
Explanation:
Even though the phrase says "yesterday," the timestamp shows the event was recorded as happening on March 15th. Therefore, the actual vet visit happened on that date, regardless of the word "yesterday" in the text.

# APPROACH (Think step by step):
1. First, examine all memories that contain information related to the question
2. Examine the timestamps and content of these memories carefully
3. Look for explicit mentions of dates, times, locations, or events that answer the question
4. If the answer requires calculation (e.g., converting relative time references), show your work
5. Formulate a precise, concise answer based solely on the evidence in the memories
6. Double-check that your answer directly addresses the question asked
7. Ensure your final answer is specific and avoids vague time references

Context:

{context}

Question: {question}
Answer:
"""
# model='gpt-4o-mini', temperature=0
```

This is the prompt [Mem0's github issue critique](https://github.com/getzep/zep-papers/issues/5)
calls out for containing a worked timestamp-interpretation example ("Timestamps... represent the
actual time the event occurred, not the time the event was mentioned") that the other baselines'
prompts didn't get — confirmed present verbatim above. **Note: no explicit word-count cap** here
(unlike Mem0's "5-6 words"), which matters for F1-style comparison.

**Judge prompt** (verbatim, `zep_locomo_eval.py`) — near-identical to Mem0's `ACCURACY_PROMPT`
(same Hawaii-necklace example, same date-format leniency language) but wrapped with a system
message and structured-output `Grade` pydantic model instead of Mem0's raw JSON-object parsing:

```python
class Grade(BaseModel):
  is_correct: str = Field(description='CORRECT or WRONG')
  reasoning: str = Field(description='Explain why the answer is correct or incorrect.')

system_prompt = """
    You are an expert grader that determines if answers to questions match a gold standard answer
    """

ACCURACY_PROMPT = f"""
Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given the following data:
    (1) a question (posed by one user to another user), 
    (2) a 'gold' (ground truth) answer, 
    (3) a generated answer
which you will score as CORRECT/WRONG.
[... identical body to Mem0's ACCURACY_PROMPT, Hawaii/shell-necklace example, date-leniency clause ...]
Now it's time for the real question:
Question: {question}
Gold answer: {gold_answer}
Generated answer: {response}

First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG. 
Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.
"""

# model='gpt-4o-mini', response_format=Grade, temperature=0
print('SCORE: ', score / 1540)
```

**Category handling:** `qa_set_filtered = [qa for qa in qa_set if qa.get('category') != 5]` —
category 5 excluded, same as Mem0. **1540** is the fixed denominator (10 conversations × ~154
non-adversarial questions average).

### B3. Current open-source harness (`getzep/zep` `benchmarks/locomo/`) — measured 0.803, not 0.947

Source: [`getzep/zep`](https://github.com/getzep/zep), directory `benchmarks/locomo/` (current
`main`, actively maintained — has its own README, Makefile, pytest suite).

**Answer-generation prompt** (verbatim, `benchmarks/locomo/prompts.py`):

```python
RESPONSE_SYSTEM_PROMPT = """
You are a helpful expert assistant answering questions based on the provided context.
"""

RESPONSE_PROMPT = """
# CONTEXT:
You have access to facts and entities from a conversation.

# INSTRUCTIONS:
1. Carefully analyze all provided memories
2. Pay special attention to the timestamps to determine the answer
3. If the question asks about a specific event or fact, look for direct evidence in the memories
4. If the memories contain contradictory information, prioritize the most recent memory
5. Always convert relative time references to specific dates, months, or years.
6. Be as specific as possible when talking about people, places, and events
7. Timestamps in memories represent the actual time the event occurred, not the time the event was mentioned in a message.

Clarification:
When interpreting memories, use the timestamp to determine when the described event happened, not when someone talked about the event.

Example:

Memory: (2023-03-15T16:33:00Z) I went to the vet yesterday.
Question: What day did I go to the vet?
Correct Answer: March 15, 2023
Explanation:
Even though the phrase says "yesterday," the timestamp shows the event was recorded as happening on March 15th. Therefore, the actual vet visit happened on that date, regardless of the word "yesterday" in the text.

# APPROACH (Think step by step):
1. First, examine all memories that contain information related to the question
2. Examine the timestamps and content of these memories carefully
3. Look for explicit mentions of dates, times, locations, or events that answer the question
4. If the answer requires calculation (e.g., converting relative time references), show your work
5. Formulate a precise, concise answer based solely on the evidence in the memories
6. Double-check that your answer directly addresses the question asked
7. Ensure your final answer is specific and avoids vague time references

Context:

{context}

Question: {question}
Answer:
"""
```

Essentially unchanged from the 2025-04 disputed version (§B2), still no word-count cap, still the
"Timestamps... not the time mentioned" clarification example.

**Judge prompt** (verbatim, `benchmarks/locomo/prompts.py`):

```python
GRADER_SYSTEM_PROMPT = """
You are an expert grader that determines if answers to questions match a gold standard answer.
"""

GRADER_PROMPT = """
Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given the following data:
    (1) a question (posed by one user to another user),
    (2) a 'gold' (ground truth) answer,
    (3) a generated answer
which you will score as CORRECT/WRONG.

The point of the question is to ask about something one user should know about the other user based on their prior conversations.
The gold answer will usually be a concise and short answer that includes the referenced topic, for example:
Question: Do you remember what I got the last time I went to Hawaii?
Gold answer: A shell necklace
The generated answer might be much longer, but you should be generous with your grading - as long as it touches on the same topic as the gold answer, it should be counted as CORRECT.

For time related questions, the gold answer will be a specific date, month, year, etc. The generated answer might be much longer or use relative time references (like "last Tuesday" or "next month"), but you should be generous with your grading - as long as it refers to the same date or time period as the gold answer, it should be counted as CORRECT. Even if the format differs (e.g., "May 7th" vs "7 May"), consider it CORRECT if it's the same date.

Now it's time for the real question:
Question: {question}
Gold answer: {gold_answer}
Generated answer: {response}

First, provide a short (one sentence) explanation of your reasoning, then finish with CORRECT or WRONG.
Do NOT include both CORRECT and WRONG in your response, or it will break the evaluation script.
"""
```

**Judge model + defaults** (`benchmarks/locomo/config.py`, `ModelConfig`):

```python
response_model: str = Field(default="gpt-4o-mini")
response_temperature: float = Field(default=0.0)
grader_model: str = Field(default="gpt-4o-mini")
grader_temperature: float = Field(default=0.0)
```

Output format is `response_format=Grade` (structured `is_correct: "CORRECT"|"WRONG"` +
`reasoning`), via `openai.beta.chat.completions.parse(...)` — same binary scheme as Mem0, plus an
**additional, separate** "context completeness" grade (`COMPLETE`/`PARTIAL`/`INSUFFICIENT`) that
judges whether the *retrieved context* (not the final answer) contained enough information — this
second grader is diagnostic and is not what produces the headline accuracy number, but it's mixed
into the same `BenchmarkMetrics` output, so don't confuse `completeness_complete_rate` with
`accuracy` when reading a results.json.

**Category handling** (`evaluation.py`): `if qa.get("category") == 5: continue  # Skip category 5
as golds are not provided for this category` — same convention as Mem0 and the 2025-04 harness.

**Measured result** — I pulled the most recent logged experiment in-repo,
[`experiments/experiment_20251207_215609/experiment_summary.json`](https://github.com/getzep/zep/blob/main/benchmarks/locomo/experiments/experiment_20251207_215609/experiment_summary.json),
config: `edge_limit=30, node_limit=30, edge_reranker=cross_encoder, node_reranker=cross_encoder,
response_model=gpt-4o-mini, grader_model=gpt-4o-mini` — **10 runs, mean accuracy 0.8032, std
0.0043 (range 0.798–0.812)**. This is Zep's own code, own config, own judge, checked into their own
repo, most recent available. It is nowhere near 0.947.

### B4. The marketed 94.7% — not reproducible from any published source

[`getzep.com/research/`](https://www.getzep.com/research/) states (verbatim, per fetch):

> "Judge: gpt-5.4 with chain-of-thought grading"
> "Accuracy 94.7% — 1,459 / 1,540 correct"
> "Multi-scope retrieval depth: 20 edges, 10 nodes, 10 episodes, 5 thread summaries, 5
> observations, cross-encoder reranking"
> "Run on 1,540 LoCoMo questions" / "0 failed tests"

None of the following is published anywhere I could find, in the repo or the blog:
- The exact answer-generation prompt used for this specific run.
- The exact "chain-of-thought grading" judge prompt/rubric for `gpt-5.4` (the checked-in
  `GRADER_PROMPT` in §B3 has no chain-of-thought instruction at all — "provide a short **one
  sentence** explanation," which is the opposite of CoT).
- A config for "episodes," "thread summaries," or "observations" as retrieval scopes — the
  open-sourced `GraphParams` model (§B3) only has `edge_limit`/`node_limit` with `edge_reranker`/
  `node_reranker`; it has no field for episodes/thread-summaries/observations at all, meaning this
  number was produced by a newer/private product surface not reflected in the public repo.

1,540 matches the same denominator as the disputed 2025-04 harness (§B2), so category-5 exclusion
is consistent across all Zep numbers.

**Bottom line for B4:** treat 94.7% as a claimed marketing number with a named judge model and
named retrieval-breadth parameters, but **not a reproducible harness** — there is no prompt text
to replicate.

---

## C. Comparison to the original LoCoMo paper's own scoring

Original benchmark: Maharana et al. 2024, ["Evaluating Very Long-Term Conversational Memory of LLM
Agents"](https://arxiv.org/abs/2402.17753) (arXiv 2402.17753), code at
[snap-research/locomo](https://github.com/snap-research/locomo).

- The original paper's own QA scoring is **token-level F1 / BLEU-1 / ROUGE-style lexical-overlap
  metrics** against the gold answer — not an LLM-as-judge accuracy for the QA task. (The paper
  does use LLM-based scoring elsewhere, for the separate event-summarization/FActScore subtask,
  not for QA.)
- The QA split has the same five categories (single-hop, multi-hop, temporal, commonsense/world
  knowledge or "open-domain," and adversarial/unanswerable); the adversarial category is
  conventionally excluded from headline QA metrics industry-wide (both Mem0 and Zep do this, per
  §A3/§B2/§B3), because it has no gold answer and the correct behavior is refusal, which a
  lexical-overlap or generous-LLM-judge metric can't score the same way.
- **The methodology delta that matters most for our A/B:** both Mem0 and Zep replaced the
  original paper's strict lexical metric with a **generous binary LLM judge** (near-identical
  rubric, explicitly instructed to count topic-matching or date-format-differing answers as
  CORRECT) **and** an answer-generation prompt that caps responses at ~5-6 words (Mem0) or leaves
  them a few sentences (Zep) rather than the fuller responses a raw F1 metric tends to reward.
  Swapping strict-F1 for generous-binary-judge, on its own, is very likely to move a score by
  double-digit points regardless of retrieval quality — this is the core hypothesis worth testing
  in our own harness A/B.

---

## D. What's verbatim vs. reconstructed — summary table

| Artifact | Status | Source |
|---|---|---|
| Mem0 `ANSWER_PROMPT` / `ANSWER_PROMPT_GRAPH` / `ANSWER_PROMPT_ZEP` | **verbatim**, from source + cross-checked against paper Appendix A | `evaluation/prompts.py` @ `aae5989e78` |
| Mem0 `ACCURACY_PROMPT` (judge) | **verbatim**, from source + paper Appendix A | `evaluation/metrics/llm_judge.py` @ `aae5989e78` |
| Mem0 judge model/params (`gpt-4o-mini`, temp 0, json_object) | **verbatim** | same file |
| Mem0 category-5 exclusion | **verbatim** code + verbatim paper quote | `evaluation/metrics/llm_judge.py`, `evaluation/evals.py`, paper §3.1 |
| Mem0 J metric definition (10 runs, mean ± 1 SD, pooled overall mean) | **verbatim** paper quote + verbatim aggregation code | paper §3.2, `evaluation/generate_scores.py` |
| Zep 2025-04 disputed `zep_locomo_responses.py` / `zep_locomo_eval.py` | **verbatim**, from source | `getzep/zep-papers` `kg_architecture_agent_memory/locomo_eval/` |
| Zep current `RESPONSE_PROMPT` / `GRADER_PROMPT` (`benchmarks/locomo`) | **verbatim**, from source | `getzep/zep` `benchmarks/locomo/prompts.py` |
| Zep current judge model default + measured 0.803 result | **verbatim** config + **verbatim** logged experiment JSON | `getzep/zep` `benchmarks/locomo/config.py`, `experiments/experiment_20251207_215609/` |
| Zep 94.7% judge model name + retrieval-breadth description | **verbatim quote** from marketing page | `getzep.com/research/` |
| Zep 94.7% actual prompt text / CoT instructions / episodes-thread-summaries-observations config | **not found anywhere** — flagged as unreproducible, not reconstructed | n/a |
| Zep arXiv paper (2501.13956) LoCoMo methodology | **does not exist** — paper covers DMR + LongMemEval only, no LoCoMo section | arXiv 2501.13956 full text (fetched, verified absent) |
| Original LoCoMo (Maharana 2024) scoring method | reconstructed from paper description (F1/BLEU/lexical, not LLM-judge for QA) — not re-extracted verbatim, out of scope per brief ("briefly note") | arXiv 2402.17753 |

## Recommended next step (not executed — read-only research task)

Implement two harness variants against our own retrieval output: (1) Mem0's exact `ANSWER_PROMPT` +
`ACCURACY_PROMPT` + `gpt-4o-mini`, 10 runs mean±SD, category-5 excluded — this is the most legit,
fully-reproducible external reference point; (2) Zep's current `benchmarks/locomo` `RESPONSE_PROMPT`
+ `GRADER_PROMPT` + `gpt-4o-mini` as a second reference point. Do **not** attempt to reproduce
"0.947" as a target — no one outside Zep can, including apparently Zep's own public repo.
