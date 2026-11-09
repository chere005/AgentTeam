#!/usr/bin/env bash
# PREFLIGHT: run the "Desktop checks" jobs (macOS, Windows, Linux) on GitHub against the commit
# about to go to main or a release tag. It pushes HEAD to preflight/<branch>; the push's run hands
# the jobs to github-actions[bot] (so nothing can mail anyone), and this waits for the bot's run,
# reads each job's conclusion and deletes that branch.
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

# Two minutes of slack: this machine's clock runs ahead of GitHub's, and a run created "before" `before` was never found.
before="$(date -u -d '-120 seconds' +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -v-120S +%Y-%m-%dT%H:%M:%SZ)"
echo "preflight: pushing ${sha:0:7} to ${target}"
git push -q --force origin "HEAD:refs/heads/${target}"
cleanup() { git push -q origin --delete "${target}" > /dev/null 2>&1 || true; }
trap cleanup EXIT

# The push starts a run of ours that only hands the work to github-actions[bot] (quiet CI: GitHub mails the person who
# triggered a run, and the bot's run is nobody's). The bot's run is the one to read.
run=""
for _ in $(seq 1 60); do
  run="$(gh api "repos/${REPO}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=20" \
    --jq "[.workflow_runs[] | select(.triggering_actor.login == \"github-actions[bot]\" and .head_branch == \"${target}\" and .created_at >= \"${before}\")][0].id // empty")"
  [ -n "$run" ] && break
  sleep 5
done
if [ -z "$run" ]; then echo "preflight: the bot's run did not appear (the Actions tab shows why the handoff failed)" >&2; exit 1; fi
echo "preflight: https://github.com/${REPO}/actions/runs/${run}"
# Wait for the deciding jobs only; optional ones (Windows, Linux) can take far longer and
# are cancelled once the verdict is in (the bot's run: nobody is mailed).
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
