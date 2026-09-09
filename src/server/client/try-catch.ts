/** Keep browser operations usable when platform access throws. */
export function tryCatch<TValue>(
  read: () => TValue,
): readonly [Error, undefined] | readonly [undefined, TValue] {
  try {
    return [undefined, read()];
  } catch (error) {
    return [error instanceof Error ? error : new Error("Browser operation failed"), undefined];
  }
}
