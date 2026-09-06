# Handoff smoke - baton-pass - handoff-1788667821302

```
# Handoff smoke - baton-pass - conversation handoff-1788667821302
record: /var/folders/tw/f14p0yj14539tbphfm20yc340000gn/T/lucid-handoff-aQJRsF/handoff-1788667821302
incumbent presence presence.acquire
incumbent acquired presence lock
incumbent attached, seq 1
incumbent enqueued inc-0, seq 2
incumbent enqueued inc-1, seq 3
incumbent enqueued inc-2, seq 4
second participant sent: send-1788667821307-jhwsut
incumbent presence presence.released
incumbent yielded (presence lock freed)
successor presence presence.acquire
successor acquired presence lock
successor folded, seq 5, inputs 4
transcript ids: inc-0, inc-1, inc-2, send-1788667821307-jhwsut
✓ handoff ordered and at-least-once (no lost input)
✓ deduped on replay (D-020)
successor enqueued succ-0, seq 6
final transcript inputs: 5, seq 6
reopened fold matches live: true
```

Verdict: PASS
