#!/usr/bin/env bash
# PREFLIGHT: run the "Desktop checks" jobs (macOS, Windows, Linux) AND the Release workflow in preflight mode (every
# installer built, nothing created, uploaded or published) on GitHub against the commit about to go to main or a release tag,
# without a failing job failing the run, so no failure mail is sent. It pushes HEAD to preflight/<branch>, where
# .github/workflows/ci.yml marks every job continue-on-error, starts release.yml there with preflight=true (its jobs are
# continue-on-error too), waits for both runs, reads each job's conclusion and deletes that branch.
#
#   scripts/preflight.sh        the current branch's HEAD (commit first)
#
# Pass: the commit is recorded as preflighted (<git common dir>/preflight/<sha>), which
# .githooks/pre-push asks for before main or a v* tag is pushed. Fail: the failing jobs and steps
# are named and the exit status is 1. Never run it on main itself.
#
# Release preflight checks that package.json and package-lock.json agree and builds the installers with the same gates as a
# real release. It cannot check that the tag will equal the version unless you tag the commit you preflighted: bump the
# version first, commit, preflight, then tag that commit.
set -euo pipefail

REPO="${AGENTTEAM_REPO:-chere005/AgentTeam}"
CI_WORKFLOW="Desktop checks"
RELEASE_WORKFLOW="release.yml"

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

# Two minutes of slack: a machine's clock is rarely GitHub's (one ran 17 s ahead, and the run it had just started was taken for
# an older one and never found). The run is still this branch, this commit and made after `before`.
before="$(date -u -d '-120 seconds' +%Y-%m-%dT%H:%M:%SZ 2> /dev/null || date -u -v-120S +%Y-%m-%dT%H:%M:%SZ)"
echo "preflight: pushing ${sha:0:7} to ${target}"
git push -q origin "HEAD:refs/heads/${target}"
cleanup() { git push -q origin --delete "${target}" > /dev/null 2>&1 || true; }
trap cleanup EXIT

# The Release workflow only reacts to tags and manual runs, so the branch push above starts nothing of it.
gh workflow run "$RELEASE_WORKFLOW" --repo "$REPO" --ref "$target" -f preflight=true > /dev/null

# find_run <workflow> <event>: the run of this branch and commit, started after `before`.
find_run() {
  local found=""
  for _ in $(seq 1 45); do
    found="$(gh run list --repo "$REPO" --workflow "$1" --branch "$target" --event "$2" --limit 10 \
      --json databaseId,headSha,createdAt \
      --jq "[.[] | select(.headSha == \"${sha}\" and .createdAt >= \"${before}\")][0].databaseId // empty")"
    [ -n "$found" ] && break
    sleep 4
  done
  echo "$found"
}

ci_run="$(find_run "$CI_WORKFLOW" push)"
release_run="$(find_run "$RELEASE_WORKFLOW" workflow_dispatch)"
if [ -z "$ci_run" ]; then echo "preflight: the Desktop checks run did not appear" >&2; exit 1; fi
if [ -z "$release_run" ]; then echo "preflight: the Release run did not appear" >&2; exit 1; fi
echo "preflight: checks   https://github.com/${REPO}/actions/runs/${ci_run}"
echo "preflight: release  https://github.com/${REPO}/actions/runs/${release_run}"

# Jobs that report but never decide: the optional ones (Windows, Linux), the publish job (skipped in preflight, but it waits
# for them) and the summary.
undeciding='optional|publish|summary'

# wait_deciding <run> <minimum number of deciding jobs>: until every deciding job has completed (and, because a job waiting
# for another may not be listed yet, at least that many are listed), or the run is over.
wait_deciding() {
  local run="$1" min="$2" state
  while :; do
    state="$(gh run view "$run" --repo "$REPO" --json status,jobs \
      --jq "[.status, ([.jobs[] | select(.name | test(\"${undeciding}\") | not)] | length), ([.jobs[] | select((.name | test(\"${undeciding}\") | not) and .status != \"completed\")] | length)] | @tsv")"
    case "$state" in
      completed$'\t'*) return 0 ;;
    esac
    local total pending
    total="$(echo "$state" | cut -f2)"
    pending="$(echo "$state" | cut -f3)"
    if [ "$pending" = "0" ] && [ "${total:-0}" -ge "$min" ]; then return 0; fi
    sleep 30
  done
}
# The desktop checks retain their documented optional platforms. Every installer must finish before a release is allowed.
wait_deciding "$ci_run" 1
gh run watch "$release_run" --repo "$REPO" --interval 20 > /dev/null 2>&1 || true
gh run cancel "$ci_run" --repo "$REPO" > /dev/null 2>&1 || true

failed_total=""
report() {
  local label="$1" run="$2" ignored="$3" jobs failed failed_steps
  echo "preflight: ${label}"
  jobs="$(gh run view "$run" --repo "$REPO" --json jobs --jq '.jobs[] | [.name, .conclusion] | @tsv')"
  echo "$jobs" | sed 's/^/  /'
  failed="$(echo "$jobs" | awk -F'\t' -v re="$ignored" '$1 !~ re && $2 != "success" { print $1 }')"
  failed_steps="$(gh run view "$run" --repo "$REPO" --json jobs \
    --jq ".jobs[] | select(.name | test(\"${ignored}\") | not) | .name as \$j | .steps[] | select(.conclusion == \"failure\") | \"  failed: \(\$j) > \(.name)\"")"
  if [ -n "$failed" ] || [ -n "$failed_steps" ]; then
    failed_total="yes"
    echo "preflight: ${label} FAIL"
    [ -z "$failed" ] || echo "$failed" | sed 's/^/  failed job: /'
    [ -z "$failed_steps" ] || echo "$failed_steps"
    echo "  logs: gh run view ${run} --repo ${REPO} --log-failed"
  fi
}
report "Desktop checks" "$ci_run" 'optional'
report "Release (preflight mode)" "$release_run" '^publish$'
if [ -n "$failed_total" ]; then
  echo "preflight: FAIL"
  exit 1
fi
mark="$(git rev-parse --git-common-dir)/preflight"
mkdir -p "$mark"
echo "${ci_run} ${release_run}" > "${mark}/${sha}"
echo "preflight: PASS (${sha:0:7} may go to main and be tagged)"
