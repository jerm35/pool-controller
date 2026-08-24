#!/usr/bin/env bash
#
# sync-drive-backup.sh — mirror the Google Drive copy of this repo to origin/<branch>.
#
# Why this exists
# ---------------
# `git push` fails from the Google Drive mount (mmap timeout), so work is
# committed and pushed from a local clone outside Drive:
#
#     local clone:  ~/Documents/Local Clones/<repo>        (commit + push here)
#     Drive copy:   .../Claude/github/<repo>               (browse + backup only)
#
# Left alone, the Drive copy silently rots. It keeps looking authoritative while
# drifting behind, and can even report "unpushed" commits that already landed
# upstream under different SHAs. `git fetch` DOES work from the mount, only push
# is broken, so the Drive copy can be kept as a true mirror of origin.
#
# Run this after every push.
#
# Usage (in a project repo):  .github/scripts/sync-drive-backup.sh [--force]
#   --force   reset even if the Drive copy has local commits or dirty tracked files
#
# PLACEMENT — the two paths below are not a contradiction:
#   in a project repo   -> .github/scripts/   (NOT scripts/)
#   in ctl-playbooks    -> scripts/           (canonical home)
# The fleet's denylist Pages workflows strip .github/ wholesale but do NOT strip
# .sh files, so a copy at scripts/<name>.sh in a project with a public Pages site
# is served at ctlnet.github.io/<repo>/scripts/<name>.sh. ctl-playbooks has no
# Pages site and nothing it holds is ever published, so scripts/ is fine there.
# Repo-agnostic either way: the path is derived from this file's own location.
#
# Config (env overrides, all optional):
#   DRIVE_ROOT   parent dir holding Drive repo copies
#   DRIVE_REPO   full path to the Drive copy (overrides DRIVE_ROOT + repo name)
#   BRANCH       branch to mirror (default: main)
#
# Gitignored scratch dirs (.wrangler/, .claude/, node_modules/, ...) are left
# untouched: `reset --hard` does not remove ignored files.

set -euo pipefail

# Repo name: prefer the name from origin's URL, fall back to the working-tree
# directory name. The Drive folders are named after the GitHub REPO, which is not
# always what the clone directory is called -- CTLNET/warranty-fixablyorders is
# checked out as `fixablyorders`, so the directory name alone sends this script
# looking for a Drive folder that does not exist. Identical result whenever the
# two agree, which is the normal case.
SCRIPT_DIR="$(dirname "${BASH_SOURCE[0]}")"
REPO_NAME="$(basename -s .git "$(git -C "$SCRIPT_DIR" remote get-url origin 2>/dev/null)" 2>/dev/null || true)"
[[ -z "$REPO_NAME" ]] && REPO_NAME="$(basename "$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)")"
# This repo is personal (jerm35/*), so its Drive mirror lives under "Claude Personal/Pool"
# rather than the fleet's "Claude/github". Only this default differs from the canonical
# copy in ctl-playbooks; DRIVE_ROOT / DRIVE_REPO env overrides still work as documented.
DRIVE_ROOT="${DRIVE_ROOT:-/Users/jeremy/Library/CloudStorage/GoogleDrive-Jburnett@ctl.net/My Drive/Claude Personal/Pool}"
DRIVE_REPO="${DRIVE_REPO:-$DRIVE_ROOT/$REPO_NAME}"
BRANCH="${BRANCH:-main}"
FORCE=0
[[ "${1:-}" == "--force" ]] && FORCE=1

if [[ ! -d "$DRIVE_REPO/.git" ]]; then
  echo "error: no git repo at $DRIVE_REPO" >&2
  exit 1
fi

cd "$DRIVE_REPO"
before="$(git rev-parse --short HEAD)"

# Refuse to clobber real work unless explicitly forced.
if [[ $FORCE -eq 0 ]]; then
  if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
    echo "error: Drive copy has uncommitted changes to tracked files." >&2
    echo "       Inspect them, then re-run with --force to discard." >&2
    git status --short --untracked-files=no >&2
    exit 1
  fi
fi

echo "==> fetching origin (this works from the Drive mount; push does not)"
git fetch origin "$BRANCH"

target="$(git rev-parse --short "origin/$BRANCH")"

if [[ $FORCE -eq 0 ]]; then
  # Local commits not contained in origin/BRANCH mean divergence, not staleness.
  ahead="$(git rev-list --count "origin/$BRANCH..HEAD")"
  if [[ "$ahead" -gt 0 ]]; then
    echo "error: Drive copy has $ahead commit(s) not on origin/$BRANCH." >&2
    echo "       These are usually already-landed commits under different SHAs," >&2
    echo "       but check before discarding. Re-run with --force to reset." >&2
    git log --oneline "origin/$BRANCH..HEAD" >&2
    exit 1
  fi
fi

if [[ "$before" == "$target" ]]; then
  echo "==> already in sync at $target — nothing to do"
  exit 0
fi

echo "==> resetting Drive copy: $before -> $target"
git reset --hard "origin/$BRANCH"

echo "==> done. Drive backup now matches origin/$BRANCH at $(git rev-parse --short HEAD)"
