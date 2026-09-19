#!/usr/bin/env bash
#
# YourCRM Wave-2 agent launcher.
#
#   ./launch.sh preflight        probe the model pool, keep only models that answer
#   ./launch.sh up               create a git worktree + install deps per module
#   ./launch.sh run              render prompts and run every agent headless
#   ./launch.sh status           summarize what each agent reported
#   ./launch.sh tmux             interactive TUI panes instead of headless
#   ./launch.sh down             remove the worktrees
#
# Common flags:
#   -j N          max agents in parallel (default 3)
#   -m MODELS     comma-separated model pool, overrides preflight results
#   -o SLUGS      comma-separated module slugs, default: all of Wave 2
#
# WHY PREFLIGHT EXISTS: `opencode run` exits 0 even when the model is locked,
# out of quota, or unsupported. Without probing first you get N sessions that
# silently did nothing and reported success.

set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
KIT="$REPO/docs/agent-prompts"
RUNS="$REPO/.agent-runs"
POOL_FILE="$RUNS/model-pool.txt"

# Candidate models, verified-first. Preflight filters this down.
# opencode/muse-spark-1.3-contributor-free is the confirmed free workhorse.
CANDIDATES=(
  "opencode/muse-spark-1.3-contributor-free"
  "opencode/muse-spark-1.2-contributor-free"
  "explabs/deepseek-v4-flash"
  "explabs/deepseek-v4.1-flash"
  "explabs/qwen3.8-27b"
  "opencode-zen/deepseek-v4-flash"
  "minimax/MiniMax-M3"
)

# Pinned by the project owner. Override with -m.
PINNED_MODEL="opencode/muse-spark-1.3-contributor-free"
JOBS=0                 # 0 = no cap, launch every agent at once
MODELS_OVERRIDE=""
ONLY=""
WAVE="${WAVE:-2}"

cmd="${1:-help}"; shift || true
while getopts ":j:m:o:w:" opt; do
  case "$opt" in
    j) JOBS="$OPTARG" ;;
    m) MODELS_OVERRIDE="$OPTARG" ;;
    o) ONLY="$OPTARG" ;;
    w) WAVE="$OPTARG" ;;
    *) ;;
  esac
done

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m fail\033[0m %s\n' "$*" >&2; }
strip_ansi() { sed -r 's/\x1B\[[0-9;]*[mGKHF]//g'; }

modules() {
  if [[ -n "$ONLY" ]]; then
    tr ',' '\n' <<<"$ONLY"
  elif [[ "$WAVE" != "2" ]]; then
    find "$KIT/wave$WAVE" -name '*.md' ! -name '_shared.md' -printf '%f\n' | sed 's/\.md$//' | sort
  else
    bun run "$KIT/render.ts" --slugs
  fi
}

# Wave 1 prompts are bespoke markdown + shared ground rules.
# Wave 2 prompts are rendered from the template + registry.
make_prompt() {
  local slug="$1" out="$2"
  if [[ "$WAVE" != "2" ]]; then
    local shared="$KIT/wave$WAVE/_shared.md"
    [[ -f "$shared" ]] || shared="$KIT/wave1/_shared.md"
    { cat "$KIT/wave$WAVE/$slug.md"; echo; cat "$shared"; } >"$out"
  else
    bun run "$KIT/render.ts" "$slug" >"$out"
  fi
}

# --- preflight -------------------------------------------------------------
# A model passes only if it emits the sentinel. Anything else - lock message,
# quota message, empty output - is a fail, regardless of exit status.
preflight() {
  mkdir -p "$RUNS"
  local probe_dir="$RUNS/.probe"; mkdir -p "$probe_dir"
  : >"$POOL_FILE"
  log "probing ${#CANDIDATES[@]} models in parallel (45s cap each)"
  # Probed concurrently: they are independent network calls, and a locked or
  # retry-looping provider otherwise burns the whole timeout serially.
  local tmp="$RUNS/.probe-results"; : >"$tmp"
  for m in "${CANDIDATES[@]}"; do
    (
      local out
      out="$(cd "$probe_dir" && timeout 45 opencode run --model "$m" --auto \
              'Reply with exactly: PREFLIGHT_OK' 2>&1 | strip_ansi || true)"
      if grep -q 'PREFLIGHT_OK' <<<"$out"; then
        printf 'ok\t%s\t\n' "$m" >>"$tmp"
      else
        printf 'no\t%s\t%s\n' "$m" \
          "$(grep -m1 -oE 'Error:.*' <<<"$out" | cut -c1-80)" >>"$tmp"
      fi
    ) &
  done
  wait

  sort "$tmp" | while IFS=$'\t' read -r st m note; do
    if [[ "$st" == ok ]]; then printf '  \033[1;32mok\033[0m    %s\n' "$m"
    else printf '  \033[1;31mno\033[0m    %-45s %s\n' "$m" "$note"; fi
  done
  # Preserve CANDIDATES order so the preferred model is assigned first.
  for m in "${CANDIDATES[@]}"; do
    grep -qP "^ok\t\Q$m\E\t" "$tmp" && printf '%s\n' "$m" >>"$POOL_FILE"
  done || true

  local n; n=$(wc -l <"$POOL_FILE")
  [[ "$n" -eq 0 ]] && { err "no usable models. top up credits or add models to CANDIDATES."; exit 1; }
  log "$n usable model(s) written to $POOL_FILE"
}

load_pool() {
  if [[ -n "$MODELS_OVERRIDE" ]]; then
    tr ',' '\n' <<<"$MODELS_OVERRIDE" | grep -v '^$'
  else
    printf '%s\n' "$PINNED_MODEL"
  fi
}

# --- worktrees -------------------------------------------------------------

# Agents are weak models and forget instructions; a hook they cannot bypass is
# the only reliable way to keep provenance on machine-written commits.
# Worktrees share the common git dir, so installing once covers every branch.
install_coauthor_hook() {
  local hook="$REPO/.git/hooks/prepare-commit-msg"
  cat >"$hook" <<'HOOK'
#!/usr/bin/env bash
set -euo pipefail
MSG_FILE="$1"
LINE="Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
grep -qF "$LINE" "$MSG_FILE" && exit 0
printf '\n%s\n' "$LINE" >>"$MSG_FILE"
HOOK
  chmod +x "$hook"
  log "co-authorship hook installed (covers all worktrees)"
}

up() {
  if [[ ! -d "$REPO/.git" ]]; then
    log "initializing git repo (worktrees require one)"
    git -C "$REPO" init -q
    git -C "$REPO" add -A
    git -C "$REPO" -c user.email=agent@local -c user.name=agent \
      commit -qm "chore: foundation baseline before wave-2 fan-out"
  fi
  install_coauthor_hook
  while read -r slug; do
    local wt="$REPO/../yourcrm-$slug"
    if [[ -d "$wt" ]]; then
      log "worktree exists: $wt"
    else
      log "worktree: $wt (branch agent/$slug)"
      git -C "$REPO" worktree add -q "$wt" -b "agent/$slug"
    fi
    # Give each agent its own database — see README "infrastructure is shared".
    local dbname="yourcrm_${slug//-/_}"
    if [[ -f "$REPO/.env" ]]; then
      sed -E "s#^(DATABASE_URL=.*)/[a-zA-Z0-9_]+(\"?)\$#\\1/$dbname\\2#" "$REPO/.env" >"$wt/.env"
      docker compose -f "$REPO/docker-compose.yml" exec -T postgres \
        psql -U yourcrm -d postgres -c "CREATE DATABASE $dbname" >/dev/null 2>&1 \
        && log "created database $dbname" || true
    fi
    if [[ ! -d "$wt/node_modules" ]]; then
      log "installing deps in $slug"
      (cd "$wt" && bun install --frozen-lockfile >/dev/null 2>&1) \
        || warn "bun install failed in $slug"
    fi
  done < <(modules)
}

# --- run -------------------------------------------------------------------
run_one() {
  local slug="$1" model="$2"
  local wt="$REPO/../yourcrm-$slug"
  local prompt="$RUNS/$slug.prompt.md"
  local logf="$RUNS/$slug.log"

  [[ -d "$wt" ]] || { err "$slug: no worktree, run './launch.sh up' first"; return 1; }

  make_prompt "$slug" "$prompt"

  printf '\033[1;34m==>\033[0m launching %-14s %s\n' "$slug" "$model"
  (cd "$wt" && timeout 7200 opencode run \
      --model "$model" \
      --agent build \
      --auto \
      --title "yourcrm/$slug" \
      "$(cat "$prompt")" 2>&1) | strip_ansi >"$logf" || true

  # opencode exits 0 on provider errors, so classify from the transcript.
  if grep -qE '^Error:' "$logf"; then
    printf '  \033[1;31mFAILED\033[0m %-14s %s\n' "$slug" \
      "$(grep -m1 -oE 'Error:.*' "$logf" | cut -c1-80)"
  elif grep -q '## Status' "$logf"; then
    printf '  \033[1;32mdone\033[0m   %-14s %s\n' "$slug" \
      "$(grep -A1 '## Status' "$logf" | tail -1)"
  else
    printf '  \033[1;33mUNCLEAR\033[0m %-14s no report section emitted\n' "$slug"
  fi
}

run_all() {
  mkdir -p "$RUNS"
  mapfile -t pool < <(load_pool)
  log "model pool: ${pool[*]}"
  log "parallelism: $([[ $JOBS -eq 0 ]] && echo unlimited || echo "$JOBS")  wave: $WAVE"

  local i=0
  while read -r slug; do
    local model="${pool[$(( i % ${#pool[@]} ))]}"
    i=$(( i + 1 ))
    run_one "$slug" "$model" &
    if (( JOBS > 0 )); then
      while (( $(jobs -rp | wc -l) >= JOBS )); do wait -n; done
    fi
  done < <(modules)
  wait
  log "all agents finished — ./launch.sh status"
}

# --- tmux ------------------------------------------------------------------
tmux_mode() {
  command -v tmux >/dev/null || { err "tmux not installed"; exit 1; }
  mkdir -p "$RUNS"
  mapfile -t pool < <(load_pool)
  local sess="yourcrm" i=0
  tmux has-session -t "$sess" 2>/dev/null && { err "tmux session '$sess' exists"; exit 1; }
  while read -r slug; do
    local wt="$REPO/../yourcrm-$slug"
    local model="${pool[$(( i % ${#pool[@]} ))]}"
    make_prompt "$slug" "$RUNS/$slug.prompt.md"
    if [[ $i -eq 0 ]]; then
      tmux new-session -d -s "$sess" -n "$slug" -c "$wt"
    else
      tmux new-window -t "$sess" -n "$slug" -c "$wt"
    fi
    tmux send-keys -t "$sess:$slug" \
      "opencode --model '$model' --auto --prompt \"\$(cat '$RUNS/$slug.prompt.md')\"" C-m
    i=$(( i + 1 ))
  done < <(modules)
  log "attach with: tmux attach -t $sess    (one window per module)"
}

# --- status ----------------------------------------------------------------
status() {
  [[ -d "$RUNS" ]] || { err "no runs yet"; exit 1; }
  printf '%-16s %-9s %-7s %s\n' MODULE STATUS FILES NOTE
  while read -r slug; do
    local logf="$RUNS/$slug.log"
    [[ -f "$logf" ]] || { printf '%-16s %-9s\n' "$slug" "-"; continue; }
    local st note files
    if grep -qE '^Error:' "$logf"; then
      st="PROVIDER"; note="$(grep -m1 -oE 'Error:.*' "$logf" | cut -c1-60)"
    else
      st="$(grep -A1 '## Status' "$logf" | tail -1 | tr -d ' ')"
      [[ -z "$st" ]] && st="UNCLEAR"
      note="$(sed -n '/## Blockers/,/^## /p' "$logf" | sed -n '2p' | cut -c1-60)"
    fi
    files="$(git -C "$REPO/../yourcrm-$slug" diff --name-only HEAD 2>/dev/null | wc -l || echo 0)"
    printf '%-16s %-9s %-7s %s\n' "$slug" "$st" "$files" "$note"
  done < <(modules)
}

down() {
  while read -r slug; do
    local wt="$REPO/../yourcrm-$slug"
    [[ -d "$wt" ]] && { log "removing $wt"; git -C "$REPO" worktree remove --force "$wt" || true; }
  done < <(modules)
}

case "$cmd" in
  preflight) preflight ;;
  up)        up ;;
  run)       run_all ;;
  tmux)      tmux_mode ;;
  status)    status ;;
  down)      down ;;
  *) sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \?//' ;;
esac
