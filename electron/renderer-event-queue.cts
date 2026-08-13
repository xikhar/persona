import type { AvatarRendererEvent } from './types.cjs';

/**
 * The slot an event occupies while it waits for a renderer.
 *
 * `expression-hold` and `expression-release` deliberately share one slot. They
 * are two halves of a single piece of state, and `Map.set` on an existing key
 * updates the value but keeps the key's original insertion position — so kept
 * apart, a hold/release/hold burst replays as hold then release and resolves to
 * *released* when the caller asked for *held*.
 */
export function pendingRendererEventKey(event: AvatarRendererEvent): string {
  return event.type === 'expression-hold' || event.type === 'expression-release'
    ? 'expression'
    : event.type;
}

/**
 * Events buffered for an avatar window that does not exist yet or is still
 * loading. Only the latest event per slot is kept: the renderer is starting
 * from nothing, so it needs the current state rather than the history.
 */
export class PendingRendererEvents {
  readonly #events = new Map<string, AvatarRendererEvent>();

  add(event: AvatarRendererEvent): string {
    const key = pendingRendererEventKey(event);
    this.#events.set(key, event);
    return key;
  }

  delete(key: string): void {
    this.#events.delete(key);
  }

  clear(): void {
    this.#events.clear();
  }

  /** Returns the buffered events in replay order and empties the queue. */
  drain(): AvatarRendererEvent[] {
    const events = [...this.#events.values()];
    this.#events.clear();
    return events;
  }
}
