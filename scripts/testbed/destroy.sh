#!/usr/bin/env bash
# Terminate testbed instances and release mac Dedicated Hosts.
# Usage:
#   ./destroy.sh --tag            # everything tagged Project=astramem-testbed
#   ./destroy.sh --instance <id>  # one instance (+ its mac host if any)
#
# NOTE: a mac Dedicated Host is billed for a 24-HOUR MINIMUM. Releasing before
# 24h elapses does not refund it; AWS also blocks release until the host has
# been allocated for >=24h — this script warns and continues in that case.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; source "$here/config.sh"

mode="${1:---tag}"
if [ "$mode" = --instance ]; then
  ids="${2:?instance id required}"
else
  ids=$(aws_ ec2 describe-instances \
    --filters "Name=tag:$TAG_KEY,Values=$TAG_VALUE" \
              "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query "Reservations[].Instances[].InstanceId" --output text)
fi

[ -z "${ids:-}" ] && log "no running testbed instances found"

for iid in $ids; do
  hid=$(aws_ ec2 describe-instances --instance-ids "$iid" \
    --query "Reservations[0].Instances[0].Placement.HostId" --output text 2>/dev/null || true)
  log "terminating instance $iid ${hid:+(host $hid)}"
  aws_ ec2 terminate-instances --instance-ids "$iid" >/dev/null
  aws_ ec2 wait instance-terminated --instance-ids "$iid"
  if [ -n "${hid:-}" ] && [ "$hid" != "None" ]; then
    log "releasing dedicated host $hid"
    aws_ ec2 release-hosts --host-ids "$hid" \
      || err "release-hosts $hid failed (likely <24h since allocation) — re-run destroy after 24h to release."
  fi
done

# Sweep any idle testbed dedicated hosts with no running instance.
for h in $(aws_ ec2 describe-hosts \
    --filter "Name=tag:$TAG_KEY,Values=$TAG_VALUE" "Name=state,Values=available" \
    --query "Hosts[].HostId" --output text 2>/dev/null || true); do
  log "releasing idle dedicated host $h"
  aws_ ec2 release-hosts --host-ids "$h" \
    || err "release $h failed (likely <24h) — re-run destroy after 24h."
done

log "destroy complete. Verify no lingering hosts:  aws ec2 describe-hosts --region $REGION --filter Name=tag:$TAG_KEY,Values=$TAG_VALUE"
