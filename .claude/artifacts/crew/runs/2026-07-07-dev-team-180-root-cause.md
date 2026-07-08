# dev-team#180 root cause - prod deploy reports SUCCESS but image doesn't roll

Repo of the actual bug: astragenie/memory (local path C:\work\mega\memory).
Read-only investigation. No code changed.

## TL;DR

The deploy-azure-prod.yml pipeline has no assertion that a roll actually
happened - it only checks that the target ACR tag exists and that the
currently-active ACA revision is Healthy/Provisioned. If the resolved
IMAGE_TAG happens to point at bits that are already running (a stale
mutable alias tag, or any tag whose digest didn't change), az containerapp
update --image ... --no-wait submits a no-op PATCH, the readiness loop
trivially passes against the unchanged revision, and the whole run reports
green with zero code change. That is what happened on run 28865663580
(a73c7a84 at 12:20): the operator's workflow_dispatch supplied
image_tag: prod, a mutable alias this workflow's own header docs say is
"published when a v* git tag lands" - and no v-tag had been pushed that day,
so :prod in ACR still pointed at the pre-U7 51f9b03f digest.

PR #673 is a different, unrelated masked-output bug (Redis connection
string nulled by GitHub secret-masking across job outputs). It does not fix
#180, but its fix cannot take effect without a verified, real roll - so
Redis L2 is practically gated on #180 even though #673 doesn't address
#180's mechanism.

## Evidence

### 1. Issue #180 body/comments (gh issue view 180 --repo astragenie/dev-team)

- Confirmed DB/app skew: live /version gitSha 51f9b03f (builtAt
  2026-07-06T23:03, pre-U7) while prod Postgres CHECK constraints are
  post-U7/post-U4 (migrations DID apply via the pre-deploy psql step).
- A manual workflow_dispatch with skip_terraform=true and no
  image_tag override (defaults to sha-<dispatch commit>) DID roll:
  new revision ca-memory-api-prod--0000084, image
  memory-api:sha-977f12a693b8..., served gitSha advanced to 977f12a6.
- Two earlier "successful" runs - 64d07f35 at 09:55 and a73c7a84 at 12:20 -
  did not roll. Issue author's hypothesis: those runs left the revision on
  the mutable :prod tag.

### 2. Direct run-log evidence (gh run view <id> --repo astragenie/memory --log)

Run 28865663580 (a73c7a84, workflow_dispatch, branch
fix/memory-api-redis-secretref-prod, 2026-07-07T12:21):

```
INPUT_TAG: prod
EVENT_NAME: workflow_dispatch
WORKFLOW_HEAD_BRANCH:
REF_TYPE: branch
REF_NAME: fix/memory-api-redis-secretref-prod
```
-> resolved image_tag=prod (confirmed downstream: every job env shows
IMAGE_TAG: prod). This confirms the operator (or a stale saved dispatch
form value) passed the literal string "prod" as the image_tag input.

Cross-checked against Build and Push run history
(gh run list --workflow="Build and Push"): every run in the visible
history that day is a push/pull_request event against main or a
feature branch - zero are v* tag pushes. Per
deploy-azure-prod.yml lines 6-10 (header comment) and build-push.yml, the
mutable :prod ACR tag is only rewritten on a v* tag push. With no tag
push that day, :prod in ACR still pointed at the old pre-U7 digest, so
"az containerapp update --image acrastrageniehub.azurecr.io/memory-api:prod"
re-applied unchanged bits.

Run 28857544254 (64d07f35, workflow_dispatch, branch main, 09:55):
```
INPUT_TAG:
EVENT_NAME: workflow_dispatch
REF_TYPE: branch
REF_NAME: main
GITHUB_SHA: 64d07f355fee6db4de1fee56373a8e0a223ea533
```
-> resolved image_tag=sha-64d07f35..., an immutable tag matching the actual
main-tip commit at trigger time (git log confirms 64d07f35 =
"feat(memory-type): U4-cloud ..." (#670), pushed to main at 09:51, 4 min
before this dispatch). This tag reference is NOT the "wrong tag" case -
the underlying non-roll mechanism for this specific run is not fully
isolated by this investigation (see Open Questions); it is possible the ACA
image digest for sha-64d07f35 was in fact byte-identical to the
already-running image for other reasons, or that a prior dispatch had
already advanced to that same commit. What is common to both non-roll
runs and structurally explains both is the missing verification step
described below.

### 3. Workflow source (deploy-azure-prod.yml, astragenie/memory)

- resolve job, lines 93-109: precedence is
  workflow_dispatch input > workflow_run.head_branch > tag ref > sha-<sha>
  fallback - an arbitrary free-text image_tag operator input always
  wins, with no format validation and no cross-check against what's
  actually different from the currently-running image.
- wait-for-image job, lines 251-269: only checks the tag exists in
  ACR (az acr repository show-tags ... | grep -q .). A pre-existing,
  stale, unrelated-to-current-work tag passes this check trivially.
- deploy job (lines 369-403) calls the reusable
  astragenie/common/.github/workflows/reusable-deploy-aca-image-roll.yml@v1.

### 4. Reusable workflow (astragenie/common reusable-deploy-aca-image-roll.yml)

- Image-roll step: az containerapp update --image "$ACR_SERVER/$IMAGE:$IMAGE_TAG" --no-wait --output none
  - fire-and-forget; does not wait for the ARM operation, does not check
  whether ACA actually created a new revision or whether the resolved
  digest changed.
- Readiness loop (the section right after): queries
  az containerapp revision list --query "[?properties.active]|[0].properties.{health,provision,replicas}"
  and asserts only healthState/provisioningState (plus replica count for
  scale-to-zero mode) of whatever revision is currently active - old or
  new. It never compares the active revision's image/tag/digest against
  $IMAGE_TAG, and never diffs against the pre-deploy active revision.
  If containerapp update was a no-op (unchanged digest -> ACA does not
  necessarily even mint a new revision), the old revision is trivially
  Healthy + Provisioned, the loop reports ready immediately, the job exits
  0, and the whole GitHub Actions run reports SUCCESS - with the served
  code unchanged. This is the "masked/empty-input, silent no-op, still
  green" mechanism named in the issue title.

## Root cause (one sentence)

The prod deploy pipeline treats "ACR tag exists" + "the currently-active
ACA revision is healthy" as proof of a successful roll, but neither check
verifies that the resolved image_tag actually differs from what was
already running - so an operator-supplied (or stale) mutable/no-op tag
(prod, confirmed via run log for a73c7a84) causes a real no-op deploy
that still reports green.

## Recommended fix

1. Kill the free-text mutable-tag footgun at the source. In resolve
   (deploy-azure-prod.yml lines ~93-109), validate INPUT_TAG against
   a pattern equivalent to: sha-<7 to 40 hex chars>, OR vX.Y(.Z) - before
   accepting it; reject and fail the job on anything else
   (explicitly including bare "prod"/"dev"/"latest"). Forces every dispatch
   to name an immutable artifact.
2. Add a real post-deploy roll assertion in
   reusable-deploy-aca-image-roll.yml, after the image-update step and
   before/alongside the readiness loop:
   - Capture the active revision's image reference (or digest) BEFORE
     calling containerapp update (az containerapp revision list --query
     "[?properties.active]|[0].properties.template.containers[0].image").
   - After update + readiness pass, re-query and require the image
     reference actually changed (or, if the caller expects a legitimate
     no-op redeploy, require an explicit allow-noop: true input).
   - Fail the job loudly (exit 1 with ::error::) if the "new" active
     revision's image reference equals the pre-deploy one when a change was
     expected.
3. Assert served version, not just Azure resource state, as the issue
   author already proposed ("post-deploy /version-assertion guard"): after
   readiness passes, curl the app's public GET /version, compare the
   returned gitSha (or equivalent) against the short SHA embedded in
   $IMAGE_TAG (for sha-* tags) or against the pre-deploy /version
   result (for tag-alias deploys) - fail if unchanged/mismatched. This is
   the strongest, most direct evidence a roll actually happened, and is
   exactly the signal that resolved this incident manually.

## How to verify a real roll (repeatable check)

- Image digest: az acr repository show-manifests --name <acr> --repository memory-api --query "[?tags[?@=='<resolved-tag>']]" before vs. the digest ACA is actually running
  (az containerapp revision show --name ca-memory-api-prod --resource-group <rg> --revision <active> --query properties.template.containers[0].image).
- Served build: GET /version on the public endpoint - gitSha must
  equal (or be a descendant, chronologically newer than) the pre-deploy
  value, and specifically must advance past 51f9b03f for this incident.
- Revision identity: a brand-new revision suffix appearing
  (ca-memory-api-prod--0000084 was the corroborating signal in this
  incident) is necessary-but-not-sufficient corroboration - combine with
  the digest/version checks above, since ACA can mint a new revision
  pointing at unchanged bits.

## #673 vs #180 relationship

They are unrelated bugs that happen to share the phrase "masked output."

- #180 (this issue): no digest/version verification after
  containerapp update, so a stale/no-op image_tag resolves silently to
  a "successful" non-roll. Root cause lives in deploy-azure-prod.yml's
  resolve job + the reusable workflow's readiness loop.
- PR #673 (fix(deploy): Redis L2 as KV secretRef (dev+prod), not
  masked CI job-output (devops#70), state OPEN, mergedAt null):
  a GitHub Actions secret-masking bug. The pre-deploy job fetches
  redis-connection-string from Key Vault, calls ::add-mask:: on it, and
  exports it as a job OUTPUT (redis_conn) for the deploy job to
  consume. GitHub Actions silently strips masked values when they cross a
  job boundary (the run logged: "Skip output 'redis_conn' since it may
  contain secret."), so needs.pre-deploy.outputs.redis_conn arrives as ""
  in the deploy job, which then injects ConnectionStrings__Redis="" via
  --set-env-vars - silently disabling Redis L2 in prod. #673's fix routes
  the Redis connection string through Terraform as a KV-referenced ACA
  secret (mirroring how ConnectionStrings__Postgres is already handled),
  removing the cross-job-output path entirely.

Does #673 fix #180? No - #673 doesn't touch the resolve job's tag
precedence or the readiness loop; it only changes how one specific env var
is plumbed into the container app.

Is Redis effectively gated on #180? Practically, yes, for two reasons:
- #673's infra/envs/{dev,prod}/main.tf changes are Terraform, and
  deploy-azure-prod.yml's terraform job only runs when
  skip_terraform != 'true' - the OPPOSITE of the current default
  (skip_terraform defaults to "true" for prod, "image-only redeploy is
  the common case"). Landing #673 requires a deploy dispatched with
  skip_terraform=false to actually apply the new secretRef.
- Even with skip_terraform=false, the same pipeline's deploy job is the
  one with the unverified-no-op weakness described above. Until fix #2/#3
  above lands, a redeploy for #673 could itself report green without
  actually creating a revision that has the new secretRef bound (e.g., if
  the resolved image_tag for that dispatch happens to match what's
  already running). The team should not merge+redeploy #673 blind - either
  land the #180 verification fix first, or manually confirm post-deploy
  that ConnectionStrings__Redis is non-empty on the live revision
  (az containerapp revision show ... --query
  "properties.template.containers[0].env") rather than trusting the green
  checkmark.

## Confidence

High on: the a73c7a84/run 28865663580 mechanism (directly observed in
run logs - INPUT_TAG: prod -> IMAGE_TAG: prod throughout), the absence of
any digest/version verification in either workflow (read directly from
source), and the #673-vs-#180 independence (read directly from PR body +
diff).

Medium on: whether the 64d07f35/run 28857544254 non-roll has the exact
same "stale mutable tag" flavor - that run resolved a fresh, correct
immutable sha- tag matching main tip at trigger time, so its failure mode
is not fully explained by "wrong tag" and may be a separate manifestation
of the same underlying gap (no post-deploy verification), or an artifact
of dispatch ordering/timing not visible in the log excerpts pulled here.

## Open questions / suggested next step

- Pull the full job log (not just grep hits) for run 28857544254's
  deploy job + reusable workflow's "Update container apps + jobs +
  readiness" step to see the actual pre/post revision state and confirm or
  rule out the "digest was already identical" explanation for that run too.
- Confirm whether build-push.yml in fact tags every push to main
  with sha-<full sha> (not just tag pushes) - this investigation inferred
  it from the fact that sha-64d07f35... was immediately found in ACR by
  the wait-for-image polling step (no 10-minute wait), but did not read
  build-push.yml directly.
- Suggested next handoff: crew:release-engineer (or a PR against
  astragenie/memory) to implement fix items 1-3 above in
  deploy-azure-prod.yml / deploy-azure-dev.yml and the shared
  astragenie/common reusable workflow.
