# Handoff smoke - baton-pass - handoff-1786458852101

```
# Handoff smoke - baton-pass - conversation handoff-1786458852101
record: /var/folders/tw/f14p0yj14539tbphfm20yc340000gn/T/lucid-handoff-PD05lu/handoff-1786458852101
incumbent presence presence.acquire
incumbent acquired presence lock
incumbent attached, seq 1
incumbent enqueued inc-0, seq 2
incumbent enqueued inc-1, seq 3
incumbent enqueued inc-2, seq 4
second participant sent: send-1786458852109-1kgofi
incumbent presence presence.released
incumbent yielded (presence lock freed)
successor presence presence.acquire
successor acquired presence lock
successor folded, seq 5, inputs 4
transcript ids: inc-0, inc-1, inc-2, send-1786458852109-1kgofi
✓ handoff ordered and at-least-once (no lost input)
✓ deduped on replay (D-020)
successor enqueued succ-0, seq 6
final transcript inputs: 5, seq 6
reopened fold matches live: true
```

Verdict: PASS
