#!/usr/bin/env bash
# Shared config + helpers for the astramem-local AWS testbed.
# SOURCED by spin.sh / run-tests.sh / destroy.sh — not executed directly.
#
# All AWS coordinates default to the existing self-hosted runner's VPC so a new
# box inherits SSM access via the same instance profile. Override any via env.
#
# shellcheck disable=SC2034  # these are consumed by the scripts that source this
set -euo pipefail

REGION="${AWS_TESTBED_REGION:-us-east-2}"
AZ="${AWS_TESTBED_AZ:-us-east-2c}"
SUBNET_ID="${AWS_TESTBED_SUBNET:-subnet-077c62662f339a0df}"
SECURITY_GROUP="${AWS_TESTBED_SG:-sg-054b72e1b969fecec}"
IAM_PROFILE="${AWS_TESTBED_IAM_PROFILE:-profile-runner-aws}"   # grants SSM access
KEY_NAME="${AWS_TESTBED_KEY:-kp-runner-aws}"

LINUX_TYPE="${AWS_TESTBED_LINUX_TYPE:-c6a.2xlarge}"   # 8 vCPU — steady for perf
MAC_TYPE="${AWS_TESTBED_MAC_TYPE:-mac2.metal}"        # arm64 Apple Silicon (M1)

TAG_KEY="Project"
TAG_VALUE="astramem-testbed"

REPO_URL="${AWS_TESTBED_REPO_URL:-https://github.com/astragenie/astramem-local.git}"

aws_() { aws --region "$REGION" "$@"; }
log()  { printf '\033[1;36m[testbed]\033[0m %s\n' "$*" >&2; }
err()  { printf '\033[1;31m[testbed:ERROR]\033[0m %s\n' "$*" >&2; }

resolve_linux_ami() {
  aws_ ec2 describe-images --owners 099720109477 \
    --filters "Name=name,Values=ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" \
              "Name=state,Values=available" \
    --query "reverse(sort_by(Images,&CreationDate))[0].ImageId" --output text
}

resolve_mac_ami() {
  aws_ ec2 describe-images --owners amazon \
    --filters "Name=name,Values=amzn-ec2-macos-14*" \
              "Name=architecture,Values=arm64_mac" \
              "Name=state,Values=available" \
    --query "reverse(sort_by(Images,&CreationDate))[0].ImageId" --output text
}

# wait_ssm_online <instance-id> — block until SSM agent registers (mac: ~5-10 min).
wait_ssm_online() {
  local iid="$1" i st
  log "waiting for SSM agent on $iid ..."
  for i in $(seq 1 48); do
    st=$(aws_ ssm describe-instance-information \
      --filters "Key=InstanceIds,Values=$iid" \
      --query "InstanceInformationList[0].PingStatus" --output text 2>/dev/null || true)
    [ "$st" = "Online" ] && { log "SSM online: $iid"; return 0; }
    sleep 15
  done
  err "SSM did not come online for $iid within ~12 min"; return 1
}

# ssm_run_script <instance-id> <local-script> [args...]
# base64-ships the script, runs it under bash on the box, streams its output,
# returns the box's exit status.
ssm_run_script() {
  local iid="$1" script="$2"; shift 2
  local args="$*" b64 cmd_id i st
  b64=$(base64 -w0 "$script" 2>/dev/null || base64 "$script" | tr -d '\n')
  cmd_id=$(aws_ ssm send-command \
    --instance-ids "$iid" \
    --document-name "AWS-RunShellScript" \
    --comment "astramem-testbed $(basename "$script")" \
    --timeout-seconds 3600 \
    --parameters "commands=[\"echo $b64 | base64 --decode > /tmp/tb.sh\",\"bash /tmp/tb.sh $args\"]" \
    --query "Command.CommandId" --output text)
  log "SSM $cmd_id running $(basename "$script") ..."
  for i in $(seq 1 240); do
    st=$(aws_ ssm get-command-invocation --command-id "$cmd_id" --instance-id "$iid" \
      --query "Status" --output text 2>/dev/null || echo Pending)
    case "$st" in Success|Failed|Cancelled|TimedOut) break ;; esac
    sleep 15
  done
  aws_ ssm get-command-invocation --command-id "$cmd_id" --instance-id "$iid" \
    --query "StandardOutputContent" --output text
  local errout
  errout=$(aws_ ssm get-command-invocation --command-id "$cmd_id" --instance-id "$iid" \
    --query "StandardErrorContent" --output text)
  [ -n "$errout" ] && [ "$errout" != "None" ] && printf '\n--- stderr ---\n%s\n' "$errout" >&2
  [ "$st" = "Success" ] || { err "$(basename "$script") -> $st"; return 1; }
}

account_id() { aws_ sts get-caller-identity --query Account --output text; }
