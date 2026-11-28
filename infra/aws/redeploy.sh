#!/usr/bin/env bash
# Re-runs host-deploy.sh on the EC2 host through SSM (pull main, refresh .env from Secrets Manager,
# rebuild and restart). No SSH needed.
#   AWS_PROFILE=... ./infra/aws/redeploy.sh
set -euo pipefail
export AWS_REGION="${AWS_REGION:-ap-southeast-2}"
STACK="${STACK:-vaultchain}"
IID=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='InstanceId'].OutputValue" --output text)
CID=$(aws ssm send-command --instance-ids "$IID" --document-name AWS-RunShellScript \
  --comment "vaultchain redeploy" --timeout-seconds 3600 \
  --parameters 'commands=["/opt/vaultchain/infra/aws/host-deploy.sh"],executionTimeout=["3600"]' \
  --query Command.CommandId --output text)
echo "SSM command $CID on $IID, waiting…"
until s=$(aws ssm get-command-invocation --command-id "$CID" --instance-id "$IID" --query Status --output text 2>/dev/null) \
  && [[ "$s" != Pending && "$s" != InProgress && "$s" != Delayed ]]; do sleep 10; done
aws ssm get-command-invocation --command-id "$CID" --instance-id "$IID" \
  --query '[Status,StandardOutputContent,StandardErrorContent]' --output text | tail -40
[ "$s" = Success ]
