"""
evaluate_qa_azure.py — Azure-OpenAI-aware fork of the official LongMemEval
judge script (xiaowu0162/LongMemEval, src/evaluation/evaluate_qa.py, MIT
licensed). A pristine, unmodified copy of the upstream repo is cloned
alongside this file at .eval-data/LongMemEval (see judge.mts's
ensureRepoCloned) so this fork's diff against upstream is always inspectable
via `git diff --no-index`.

WHY a fork instead of pointing the unmodified script at Azure via env vars
alone (as originally hoped in docs/eval/longmemeval-plan.md section 2):
verified against the upstream source on 2026-07-08 —

  1. `model_zoo` is hardcoded to {'llama-3.1-70b-instruct', 'gpt-4o-mini',
     'gpt-4o'} only. It exits immediately on any other metric_model_short,
     so 'gpt-5-mini' cannot even be passed through unmodified.
  2. The script builds a plain `OpenAI(api_key=..., base_url=...)` client.
     Azure requires the `api-key` header (not `Authorization: Bearer`) and a
     mandatory `api-version` query param — the vanilla OpenAI() client with
     base_url pointed at an Azure endpoint does not produce a working
     request; you need `AzureOpenAI`.
  3. gpt-5-mini is a reasoning model: it takes `max_completion_tokens` (not
     `max_tokens`) and accepts `reasoning_effort`, and (verified live) does
     not accept an explicit `temperature` override — the script's fixed
     `temperature=0, max_tokens=10` kwargs would be rejected outright for
     that deployment.

Every other line — prompt templates in get_anscheck_prompt, the backoff
decorator, hypothesis/reference loading, per-entry result-file writing —
is UNCHANGED from upstream. Only three things differ:
  - imports: `AzureOpenAI` in addition to `OpenAI`/`openai`.
  - `model_zoo`: two entries mapping to our two real Azure deployment names
    instead of upstream's OpenAI-public-API model ids.
  - client construction + per-call kwargs: Azure auth, and reasoning-model
    kwargs when metric_model_short == 'gpt-5-mini'.

NOTE ON `autoeval_label.model`: upstream's own print_qa_metrics.py has a
hard `assert entry['autoeval_label']['model'] == 'gpt-4o-2024-08-06'`. Our
Azure gpt-4o deployment is snapshot 2024-11-20, not 2024-08-06 — forging the
literal OpenAI string here to dodge that assert would misrepresent which
model actually judged the run, so this fork records the true model_zoo
value and does NOT attempt to satisfy that assert. Use
judge/metrics.mts (not upstream's print_qa_metrics.py) to aggregate results
from this script's output.
"""
import os
import sys
import json
from tqdm import tqdm
import backoff
import openai
from openai import AzureOpenAI
import numpy as np


# short name -> (model string sent in the request body / used as the Azure
# deployment name — our two deployments are literally named this).
model_zoo = {
    'gpt-5-mini': 'gpt-5-mini',
    'gpt-4o': 'gpt-4o',
}

# Reasoning models (gpt-5 family) need max_completion_tokens + reasoning_effort
# and reject an explicit temperature override (verified live 2026-07-08).
REASONING_MODELS = {'gpt-5-mini'}


@backoff.on_exception(backoff.expo, (openai.RateLimitError, openai.APIError))
def chat_completions_with_backoff(client, **kwargs):
    return client.chat.completions.create(**kwargs)


def get_anscheck_prompt(task, question, answer, response, abstention=False):
    # Verbatim from upstream evaluate_qa.py — do not diverge from the
    # published methodology's prompt wording.
    if not abstention:
        if task in ['single-session-user', 'single-session-assistant', 'multi-session']:
            template = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."
            prompt = template.format(question, answer, response)
        elif task == 'temporal-reasoning':
            template = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no. In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. \n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."
            prompt = template.format(question, answer, response)
        elif task == 'knowledge-update':
            template = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no. If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.\n\nQuestion: {}\n\nCorrect Answer: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."
            prompt = template.format(question, answer, response)
        elif task == 'single-session-preference':
            template = "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly.\n\nQuestion: {}\n\nRubric: {}\n\nModel Response: {}\n\nIs the model response correct? Answer yes or no only."
            prompt = template.format(question, answer, response)
        else:
            raise NotImplementedError
    else:
        template = "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. The model could say that the information is incomplete, or some other information is given but the asked information is not.\n\nQuestion: {}\n\nExplanation: {}\n\nModel Response: {}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only."
        prompt = template.format(question, answer, response)
    return prompt


if __name__ == '__main__':
    if len(sys.argv) != 4:
        print('Usage: python evaluate_qa_azure.py metric_model hyp_file ref_file')
        exit()

    metric_model_short = sys.argv[1]
    hyp_file = sys.argv[2]
    ref_file = sys.argv[3]
    verbose = True

    result_file = hyp_file + '.eval-results-{}'.format(metric_model_short)

    if metric_model_short not in model_zoo:
        print('Requested metric model is not supported:', metric_model_short, '— known:', list(model_zoo.keys()))
        exit()
    metric_model = model_zoo[metric_model_short]

    azure_endpoint = os.environ['AZURE_OPENAI_ENDPOINT']
    azure_api_key = os.environ['AZURE_OPENAI_API_KEY']
    azure_api_version = os.environ['AZURE_OPENAI_API_VERSION']
    metric_client = AzureOpenAI(
        api_key=azure_api_key,
        azure_endpoint=azure_endpoint,
        api_version=azure_api_version,
    )

    try:
        hypotheses = [json.loads(line) for line in open(hyp_file).readlines()]
    except Exception:
        hypotheses = json.load(open(hyp_file))
    try:
        references = json.load(open(ref_file))
    except Exception:
        references = [json.loads(line) for line in open(ref_file).readlines()]
    qid2qdata = {entry['question_id']: entry for entry in references}
    qid2qtype = {entry['question_id']: entry['question_type'] for entry in references}
    qtypes = set(list(qid2qtype.values()))
    qtype2acc = {t: [] for t in qtypes}

    with open(result_file, 'w') as out_f:
        logs = []
        for entry in tqdm(hypotheses):

            if entry['question_id'] not in qid2qtype:
                print('Warning: skipping {} as it is not in reference data.'.format(entry['question_id']))
                continue

            qtype = qid2qtype[entry['question_id']]
            q = qid2qdata[entry['question_id']]['question']
            ans = qid2qdata[entry['question_id']]['answer']
            hyp = entry['hypothesis']

            prompt = get_anscheck_prompt(qtype, q, ans, hyp, abstention='_abs' in entry['question_id'])
            kwargs = {
                'model': metric_model,
                'messages': [
                    {"role": "user", "content": prompt}
                ],
                'n': 1,
            }
            if metric_model_short in REASONING_MODELS:
                kwargs['max_completion_tokens'] = 200
                kwargs['reasoning_effort'] = 'minimal'
            else:
                kwargs['temperature'] = 0
                kwargs['max_tokens'] = 10

            completion = chat_completions_with_backoff(metric_client, **kwargs)
            eval_response = completion.choices[0].message.content.strip()
            label = 'yes' in eval_response.lower()
            entry['autoeval_label'] = {
                'model': metric_model_short,
                'label': label
            }
            logs.append(entry)
            if verbose:
                print(json.dumps({
                    'question': q,
                    'answer': ans,
                    'hypothesis': hyp,
                    'autoeval_label': label
                }, indent=4), flush=True)
            print(json.dumps(entry), file=out_f)
            qtype2acc[qid2qtype[entry['question_id']]].append(1 if label else 0)

    print('Accuracy:', round(np.mean([1 if x['autoeval_label']['label'] else 0 for x in logs]).item(), 4))
    for k, v in qtype2acc.items():
        print('\t{}: {} ({})'.format(k, round(np.mean(v), 4), len(v)))

    print('Saved to', result_file)
