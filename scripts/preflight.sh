#!/usr/bin/env bash
# PREFLIGHT: run the "Desktop checks" jobs (macOS, Windows, Linux) on GitHub against the commit
# about to go to main or a release tag, without a failing job failing the run, so no failure mail
# is sent. It pushes HEAD to preflight/<branch>, where .github/workflows/ci.yml marks every job
# continue-on-error, waits for the run, reads each job's conclusion and deletes that branch.
#
#   scripts/preflight.sh        the current branch's HEAD (commit first)
#
# Pass: the commit is recorded as preflighted (<git common dir>/preflight/<sha>), which
# .githooks/pre-push asks for before main or a v* tag is pushed. Fail: the failing jobs and steps
# are named and the exit status is 1. Never run it on main itself.
set -euo pipefail

REPO="${AGENTTEAM_REPO:-chere005/AgentTeam}"
WORKFLOW="Desktop checks"

branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$branch" = "HEAD" ] || [ "$branch" = "main" ]; then
  echo "preflight: run it on a work branch, not on ${branch} (main is what it protects)" >&2
  exit 2
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "preflight: commit first; what is checked is the commit, and the working tree has changes" >&2
  exit 2
fi
sha="$(git rev-parse HEAD)"
target="preflight/${branch}"

before="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "preflight: pushing ${sha:0:7} to ${target}"
git push -q --force origin "HEAD:refs/heads/${target}"
cleanup() { git push -q origin --delete "${target}" > /dev/null 2>&1 || true; }
trap cleanup EXIT

run=""
for _ in $(seq 1 45); do
  run="$(gh run list --repo "$REPO" --workflow "$WORKFLOW" --branch "$target" --limit 5 \
    --json databaseId,headSha,createdAt \
    --jq "[.[] | select(.headSha == \"${sha}\" and .createdAt >= \"${before}\")][0].databaseId // empty")"
  [ -n "$run" ] && break
  sleep 4
done
if [ -z "$run" ]; then echo "preflight: the run did not appear" >&2; exit 1; fi
echo "preflight: https://github.com/${REPO}/actions/runs/${run}"
# Wait for the deciding jobs only; optional ones (Windows, Linux) can take far longer and
# are cancelled once the verdict is in, which never mails.
while :; do
  pending="$(gh run view "$run" --repo "$REPO" --json jobs \
    --jq '[.jobs[] | select((.name | test("optional") | not) and .status != "completed")] | length')"
  [ "$pending" = "0" ] && break
  sleep 30
done
gh run cancel "$run" --repo "$REPO" > /dev/null 2>&1 || true

jobs="$(gh run view "$run" --repo "$REPO" --json jobs --jq '.jobs[] | [.name, .conclusion] | @tsv')"
echo "$jobs" | sed 's/^/  /'
# Jobs named "optional" (Windows, Linux for now) report but never decide.
failed="$(echo "$jobs" | awk -F'\t' '$1 !~ /optional/ && $2 != "success" && $2 != "skipped" { print $1 }')"
if [ -n "$failed" ]; then
  echo "preflight: FAIL"
  gh run view "$run" --repo "$REPO" --json jobs \
    --jq '.jobs[] | select(.conclusion == "failure") | .name as $j | .steps[] | select(.conclusion == "failure") | "  failed: \($j) > \(.name)"'
  echo "  logs: gh run view ${run} --repo ${REPO} --log-failed"
  exit 1
fi
mark="$(git rev-parse --git-common-dir)/preflight"
mkdir -p "$mark"
echo "$run" > "${mark}/${sha}"
echo "preflight: PASS (${sha:0:7} may go to main and be tagged)"
