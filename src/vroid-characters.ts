/**
 * The Models section shows a connected VRoid Hub account's own characters
 * apart from the ones it has hearted: they carry different conditions of use,
 * and mixing them would leave the user guessing which rules a card is under.
 */
export interface VroidCharacterGroups {
  hearted: PersonaVroidHubCharacter[];
  own: PersonaVroidHubCharacter[];
}

export function groupVroidCharacters(
  characters: readonly PersonaVroidHubCharacter[] | null | undefined,
): VroidCharacterGroups {
  return {
    hearted:
      characters?.filter((character) => character.origin === 'hearted') ?? [],
    own: characters?.filter((character) => character.origin === 'own') ?? [],
  };
}
