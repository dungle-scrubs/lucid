#!/bin/zsh
# Read-only transcript observer. Raw event JSONL and observation timestamps stay
# separate so the event source remains independently inspectable.
set -u
out_dir="$1"
slug_dir="$HOME/.claude/projects/-Users-kevin-dev-lucid-v2-spikes-a003-bare"
baseline="$out_dir/transcripts-before.txt"
arrivals="$out_dir/arrivals.ndjson"
raw="$out_dir/raw-events.jsonl"
: > "$arrivals"
: > "$raw"
while true; do
  candidate=$(find "$slug_dir" -maxdepth 1 -type f -name '*.jsonl' 2>/dev/null | while IFS= read -r f; do
    if ! grep -Fxq "$f" "$baseline" 2>/dev/null; then print -r -- "$f"; fi
  done | head -n 1)
  if [[ -n "$candidate" ]]; then break; fi
  sleep 0.1
done
print -r -- "$candidate" > "$out_dir/transcript-path.txt"
offset=0
while true; do
  size=$(wc -c < "$candidate")
  if (( size > offset )); then
    new=$(tail -c +$((offset + 1)) "$candidate")
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      observed=$(perl -MTime::HiRes=time -e 'printf "%.6f", time')
      print -r -- "$line" >> "$raw"
      jq -cn --arg observed_at "$observed" --argjson event "$line" '{observed_at: ($observed_at|tonumber), event: $event}' >> "$arrivals"
    done <<< "$new"
    offset=$size
  fi
  sleep 0.1
done
