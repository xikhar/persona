import { describe, expect, it } from 'vitest';
import { groupVroidCharacters } from './vroid-characters';

function character(
  id: string,
  origin: PersonaVroidHubCharacter['origin'],
): PersonaVroidHubCharacter {
  return {
    id,
    character_id: `owner-${id}`,
    name: `Character ${id}`,
    is_downloadable: true,
    portrait_url: null,
    origin,
    license: null,
  };
}

describe('groupVroidCharacters', () => {
  it('separates the account’s own characters from the ones it hearted', () => {
    const groups = groupVroidCharacters([
      character('a', 'own'),
      character('b', 'hearted'),
      character('c', 'own'),
    ]);

    expect(groups.own.map(({ id }) => id)).toEqual(['a', 'c']);
    expect(groups.hearted.map(({ id }) => id)).toEqual(['b']);
  });

  it('keeps the order the Hub listed them in', () => {
    const groups = groupVroidCharacters([
      character('z', 'own'),
      character('a', 'own'),
    ]);

    expect(groups.own.map(({ id }) => id)).toEqual(['z', 'a']);
  });

  it('returns empty groups before a list has been fetched', () => {
    // The picker renders its group headings either way, so neither side of the
    // split may be undefined while the account is still loading.
    expect(groupVroidCharacters(null)).toEqual({ hearted: [], own: [] });
    expect(groupVroidCharacters(undefined)).toEqual({ hearted: [], own: [] });
    expect(groupVroidCharacters([])).toEqual({ hearted: [], own: [] });
  });
});
