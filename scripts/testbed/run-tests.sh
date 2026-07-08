#!/usr/bin/env bash
# Run install-smoke and/or perf on an already-spun testbed box.
# Usage: ./run-tests.sh <instance-id> [install|perf|all] [pkg-version] [git-ref]
#   pkg-version : astramem-local version for install-smoke (default: latest)
#   git-ref     : ref to build for perf; must exist in your LOCAL repo
#                 (default: origin/main). Private repo -> shipped via S3 tarball.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; source "$here/config.sh"

iid="${1:?usage: run-tests.sh <instance-id> [install|perf|all] [pkg-version] [git-ref]}"
suite="${2:-all}"; ver="${3:-latest}"; ref="${4:-origin/main}"
repo_root="$(cd "$here/../.." && pwd)"

if [ "$suite" = install ] || [ "$suite" = all ]; then
  log "=== INSTALL-SMOKE (astramem-local@$ver) ==="
  ssm_run_script "$iid" "$here/remote/install-smoke.sh" "$ver"
fi

if [ "$suite" = perf ] || [ "$suite" = all ]; then
  log "=== PERF BASELINE (ref $ref) ==="
  # astramem-local is PRIVATE; the box has no git creds. Ship the tree as a
  # tarball via S3 + a short-lived presigned URL (box curls it, no box IAM S3
  # dependency). The control machine's local repo must contain <ref>.
  acct="$(account_id)"; bucket="astramem-testbed-${acct}-${REGION}"
  if ! aws_ s3api head-bucket --bucket "$bucket" >/dev/null 2>&1; then
    log "creating private bucket $bucket"
    if [ "$REGION" = us-east-1 ]; then
      aws_ s3api create-bucket --bucket "$bucket" >/dev/null
    else
      aws_ s3api create-bucket --bucket "$bucket" \
        --create-bucket-configuration "LocationConstraint=$REGION" >/dev/null
    fi
    aws_ s3api put-public-access-block --bucket "$bucket" \
      --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null
  fi
  tgz="$(mktemp).tgz"; key="perf-src/$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || echo run)-$$.tgz"
  log "archiving $ref from $repo_root -> $tgz"
  git -C "$repo_root" archive --format=tar.gz -o "$tgz" "$ref"
  aws_ s3 cp "$tgz" "s3://$bucket/$key" >/dev/null
  url=$(aws_ s3 presign "s3://$bucket/$key" --expires-in 3600)
  log "shipping perf run (presigned tarball, 1h TTL)"
  ssm_run_script "$iid" "$here/remote/perf.sh" "'$url'" || true
  aws_ s3 rm "s3://$bucket/$key" >/dev/null 2>&1 || true
  rm -f "$tgz"
fi

log "done. Destroy when finished:  ./destroy.sh --tag"
