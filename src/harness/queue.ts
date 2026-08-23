/**
 * A single-consumer async queue: push from the pump, iterate from one
 * consumer, close to end iteration.
 *
 * The hcn adapter needs this twice - once for the stream of turns, once for
 * each turn's events - because hcn's stdout is flat and lucid's host consumes
 * nested iterables.
 *
 * It has no backpressure, and the reason is narrower than it first looks.
 * hcn's own channel stalls the HARNESS when hcn's consumer stops reading, but
 * lucid's adapter never stops reading: it drains hcn's stdout in a tight loop
 * and pushes here without awaiting. So hcn's channel does not bound this one.
 * Nor does the credit ledger, which gates what the sequencer FORWARDS to the
 * host and sits downstream of this queue entirely.
 *
 * What actually bounds it is that the consumer never awaits. The host pump
 * calls `sequencer.emit`, which is synchronous, into a store whose
 * `handleFrame` is synchronous, so this queue is drained as fast as it is
 * filled and holds a handful of events at most.
 *
 * That is a real bound and a fragile one. The day the store write becomes
 * asynchronous - a socket transport, an awaited fsync - this queue becomes
 * the unbounded one, and it will need a high-water mark that propagates back
 * by not reading hcn's stdout. Change that and change this.
 *
 * What it is NOT: it is not the protocol's credit ledger and it does not
 * coalesce droppable events. That policy lives in the reducer.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private closed = false;
  private wake: (() => void) | null = null;
  private consuming = false;

  push(item: T): void {
    if (this.closed) return;
    this.items.push(item);
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    if (this.consuming) {
      throw new Error("AsyncQueue is single-consumer; a second iterator would strand the first");
    }
    this.consuming = true;
    while (true) {
      if (this.items.length > 0) {
        yield this.items.shift() as T;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}
