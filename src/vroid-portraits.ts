/**
 * Character portraits, fetched one at a time through the main process and
 * remembered for the window's lifetime.
 *
 * Module scope rather than component state so the cache survives leaving and
 * re-entering the Models section, and so a portrait is only ever in flight
 * once no matter how many cards ask for it.
 */

// Portraits arrive from the main process as data: URLs. They're immutable
// enough that re-downloading them on every "Refresh list" would only cost time.
const portraitCache = new Map<string, string | null>();
// In-flight requests, so the same model is only ever fetched once at a time.
// Without this, StrictMode's double-mounted effects in development — and any
// future card that repeats a model — would each open their own request.
const portraitRequests = new Map<string, Promise<string | null>>();

export function cachedVroidPortrait(characterId: string): string | null {
  return portraitCache.get(characterId) ?? null;
}

export function hasCachedVroidPortrait(characterId: string): boolean {
  return portraitCache.has(characterId);
}

export function requestVroidPortrait(
  bridge: NonNullable<Window['personaVroidHub']>,
  characterId: string,
): Promise<string | null> {
  const pending = portraitRequests.get(characterId);
  if (pending) return pending;
  const request = bridge
    .getCharacterPortrait(characterId)
    // A portrait that won't load is cosmetic, so a failure settles the card on
    // its placeholder rather than surfacing an error. The miss is remembered
    // only until the next "Refresh list", which clears misses so a transient
    // failure — or a portrait the main process hadn't listed yet — isn't
    // remembered for the window's lifetime.
    .catch(() => null)
    .then((dataUrl) => {
      portraitCache.set(characterId, dataUrl);
      return dataUrl;
    })
    .finally(() => portraitRequests.delete(characterId));
  portraitRequests.set(characterId, request);
  return request;
}

/**
 * Drops remembered misses while keeping portraits that already loaded, so a
 * refresh is also the user's "try again" for cards stuck on the placeholder.
 * Deleting during iteration is well defined for a Map.
 */
export function forgetMissingVroidPortraits(): void {
  for (const [characterId, portrait] of portraitCache) {
    if (portrait == null) portraitCache.delete(characterId);
  }
}
