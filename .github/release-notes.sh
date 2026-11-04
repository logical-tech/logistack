#!/usr/bin/env bash
# Release notes in Markdown from the conventional commits between the previous stable v* tag and $1,
# so a stable release lists everything its betas carried, and each beta everything since stable.
#   bash .github/release-notes.sh v0.2.0 > notes.md
# Breaking changes (`type!:` or a BREAKING CHANGE footer) come first, then features, fixes and
# performance. Other types (docs, test, chore, ci, refactor, merges) stay out of the notes.
set -euo pipefail

tag=${1:?usage: release-notes.sh <tag>}
repo=${GITHUB_REPOSITORY:-logical-tech/logistack}
prev=$(git describe --tags --abbrev=0 --match 'v*' --exclude '*-*' "$tag^" 2>/dev/null || true)
range=${prev:+$prev..}$tag

declare -A section=([breaking]="" [feat]="" [fix]="" [perf]="")
while IFS=$'\x1f' read -r -d $'\x1e' sha subject body; do
	sha=${sha//[$'\n ']/}
	[[ $subject =~ ^([a-z]+)(\(([^\)]+)\))?(!)?:\ (.+)$ ]] || continue
	type=${BASH_REMATCH[1]} scope=${BASH_REMATCH[3]} bang=${BASH_REMATCH[4]} text=${BASH_REMATCH[5]}
	line="- ${scope:+**$scope:** }$text (${sha:0:7})"$'\n'
	if [ -n "$bang" ] || [[ $body == *"BREAKING CHANGE"* ]]; then
		section[breaking]+=$line
	elif [ -n "${section[$type]+set}" ]; then
		section[$type]+=$line
	fi
done < <(git log --no-merges --reverse --format='%H%x1f%s%x1f%b%x1e' "$range")

for entry in "breaking:Breaking changes" "feat:Features" "fix:Fixes" "perf:Performance"; do
	key=${entry%%:*}
	[ -n "${section[$key]}" ] || continue
	printf '## %s\n\n%s\n' "${entry#*:}" "${section[$key]}"
done

version=${tag#v}
printf '## Upgrade\n\n'
printf 'In the dashboard, open **Settings > Updates** and choose **Update to %s**. From the server:\n\n' "$tag"
# shellcheck disable=SC2016 # the backticks are Markdown, not a command
printf '```sh\ncurl -fsSL https://github.com/%s/releases/download/%s/install.sh | sudo bash -s -- --version %s\n```\n\n' "$repo" "$tag" "$version"
if [ -n "$prev" ]; then
	printf '**Full changelog:** https://github.com/%s/compare/%s...%s\n' "$repo" "$prev" "$tag"
fi
