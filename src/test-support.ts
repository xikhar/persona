/**
 * Assertions the type checker understands, for tests that read into results
 * whose shape is part of what is being asserted.
 *
 * Under `noUncheckedIndexedAccess` an indexed read is `T | undefined`, and a
 * test that goes straight on to a property of it is claiming the element exists
 * without saying so. These make the claim explicit and fail with a useful
 * message instead of `Cannot read properties of undefined`.
 */

export function assertDefined<T>(
  value: T,
  what = 'value',
): asserts value is NonNullable<T> {
  if (value == null) {
    throw new Error(`Expected ${what} to be present, got ${String(value)}.`);
  }
}

/** `assertDefined` where the value is more convenient returned than narrowed. */
export function definedAt<T>(
  values: readonly T[],
  index: number,
  what = 'element',
): NonNullable<T> {
  const value = values[index];
  assertDefined(value, `${what} at index ${index}`);
  return value;
}
