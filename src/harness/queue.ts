/**
 * A single-consumer async queue: push from the pump, iterate from one
 * consumer, close to end iteration.
 *
 * The hcn adapter needs this twice - once for the stream of turns, once for
 * each turn's events - because hcn's stdout is flat and lucid's host consumes
 * nested iterables. Kept deliberately small: no backpressure, because the
 * bounding happens in hcn (its channel stalls the harness) and in lucid's own
 * credit ledger. A second bound here would be a third opinion about the same
 * flow.
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
