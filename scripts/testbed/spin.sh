#!/usr/bin/env bash
# Spin up a fresh testbed box, wait for SSM, install the toolchain.
# Usage: ./spin.sh linux | mac
# Prints the instance id on the last line. Does NOT run tests (run-tests.sh)
# and does NOT destroy (destroy.sh).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; source "$here/config.sh"

os="${1:-}"
[ "$os" = linux ] || [ "$os" = mac ] || { err "usage: spin.sh linux|mac"; exit 2; }

tags="ResourceType=instance,Tags=[{Key=$TAG_KEY,Value=$TAG_VALUE},{Key=os,Value=$os},{Key=Name,Value=astramem-testbed-$os}]"

if [ "$os" = linux ]; then
  ami=$(resolve_linux_ami); log "Ubuntu AMI $ami, type $LINUX_TYPE"
  iid=$(aws_ ec2 run-instances \
    --image-id "$ami" --instance-type "$LINUX_TYPE" \
    --subnet-id "$SUBNET_ID" --security-group-ids "$SECURITY_GROUP" \
    --iam-instance-profile "Name=$IAM_PROFILE" --key-name "$KEY_NAME" \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=60,VolumeType=gp3}' \
    --tag-specifications "$tags" \
    --query "Instances[0].InstanceId" --output text)
  log "launched linux instance $iid"
else
  log "allocating $MAC_TYPE Dedicated Host — NOTE: 24-HOUR MINIMUM billing (~\$15.60 for mac2.metal)"
  hid=$(aws_ ec2 allocate-hosts --instance-type "$MAC_TYPE" \
    --availability-zone "$AZ" --auto-placement on --quantity 1 \
    --tag-specifications "ResourceType=dedicated-host,Tags=[{Key=$TAG_KEY,Value=$TAG_VALUE},{Key=os,Value=mac}]" \
    --query "HostIds[0]" --output text)
  log "allocated dedicated host $hid"
  ami=$(resolve_mac_ami); log "macOS AMI $ami, type $MAC_TYPE"
  iid=$(aws_ ec2 run-instances \
    --image-id "$ami" --instance-type "$MAC_TYPE" \
    --placement "Tenancy=host,HostId=$hid,AvailabilityZone=$AZ" \
    --subnet-id "$SUBNET_ID" --security-group-ids "$SECURITY_GROUP" \
    --iam-instance-profile "Name=$IAM_PROFILE" --key-name "$KEY_NAME" \
    --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=100,VolumeType=gp3}' \
    --tag-specifications "$tags" \
    --query "Instances[0].InstanceId" --output text)
  log "launched mac instance $iid on host $hid"
fi

log "waiting for instance-running ..."
aws_ ec2 wait instance-running --instance-ids "$iid"
wait_ssm_online "$iid"

log "bootstrapping toolchain (node 20 / bun / git) ..."
ssm_run_script "$iid" "$here/remote/bootstrap.sh"

log "READY. instance id below. Next: ./run-tests.sh $iid all"
echo "$iid"
