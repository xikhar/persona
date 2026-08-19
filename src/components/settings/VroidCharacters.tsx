import { useEffect, useState } from 'react';
import { vroidLicenseRows } from '../../vroid-license-fields';
import {
  cachedVroidPortrait,
  hasCachedVroidPortrait,
  requestVroidPortrait,
} from '../../vroid-portraits';

function VroidCharacterPortrait({
  character,
}: {
  character: PersonaVroidHubCharacter;
}) {
  const [portrait, setPortrait] = useState<string | null>(() =>
    cachedVroidPortrait(character.id),
  );

  useEffect(() => {
    const bridge = window.personaVroidHub;
    // No portrait_url means VRoid Hub has no image for this model, so there's
    // nothing to ask the main process for.
    if (!bridge || character.portrait_url == null) {
      setPortrait(null);
      return;
    }
    if (hasCachedVroidPortrait(character.id)) {
      setPortrait(cachedVroidPortrait(character.id));
      return;
    }
    let cancelled = false;
    void requestVroidPortrait(bridge, character.id).then((dataUrl) => {
      if (!cancelled) setPortrait(dataUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [character.id, character.portrait_url]);

  if (portrait == null) {
    return (
      <span aria-hidden="true" className="asset-portrait asset-portrait-empty">
        VRM
      </span>
    );
  }
  return (
    <img
      alt={`${character.name} portrait`}
      className="asset-portrait"
      src={portrait}
    />
  );
}

function VroidCharacterCard({
  busy,
  character,
  onSelect,
  portraitEpoch,
}: {
  busy: boolean;
  character: PersonaVroidHubCharacter;
  onSelect: () => void;
  // Used as the portrait's key: a refresh remounts it to retry a failed load.
  portraitEpoch: number;
}) {
  return (
    <article className="asset-card">
      <VroidCharacterPortrait character={character} key={portraitEpoch} />
      <span className="asset-card-main">
        <span>
          <strong>{character.name}</strong>
          <small>
            {character.is_downloadable ? 'Downloadable on Hub' : 'Hub only'}
          </small>
        </span>
      </span>
      <div className="asset-card-footer">
        <button disabled={busy} onClick={onSelect} type="button">
          Use this character
        </button>
      </div>
    </article>
  );
}

export function VroidCharacterGroup({
  busy,
  characters,
  emptyNote,
  note,
  onSelect,
  portraitEpoch,
  title,
}: {
  busy: boolean;
  characters: PersonaVroidHubCharacter[];
  emptyNote: string;
  note?: string;
  onSelect: (character: PersonaVroidHubCharacter) => void;
  portraitEpoch: number;
  title: string;
}) {
  return (
    <div className="vroid-character-group">
      <h3>
        {title}
        <span className="count-badge">{characters.length}</span>
      </h3>
      {characters.length === 0 ? (
        <p className="desktop-note">{emptyNote}</p>
      ) : (
        <>
          {note && <p className="desktop-note">{note}</p>}
          <div className="asset-grid">
            {characters.map((character) => (
              <VroidCharacterCard
                busy={busy}
                character={character}
                key={character.id}
                onSelect={() => onSelect(character)}
                portraitEpoch={portraitEpoch}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The confirmation body VRoid Hub's third-party integration guidelines require
 * before Persona downloads a model the connected account does not own.
 */
export function VroidConditionsOfUse({
  character,
  onOpenHubPage,
}: {
  character: PersonaVroidHubCharacter;
  onOpenHubPage: (() => void) | null;
}) {
  const rows = vroidLicenseRows(character.license);

  return (
    <>
      <p>
        {character.name} belongs to another VRoid Hub creator, not your
        connected account. Review its conditions of use before Persona
        downloads and uses it.
      </p>
      {rows.length > 0 ? (
        <dl className="vroid-license-terms">
          {rows.map((row) => (
            <div key={row.label}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p>
          Persona could not read this character&rsquo;s conditions of use from
          VRoid Hub.
        </p>
      )}
      {/* Only offered when VRoid Hub gave us the owning character's id: the
          model's page lives under it, so without it there's no address to
          open and a link would only lead to a 404. */}
      {onOpenHubPage && (
        <p>
          <button
            className="link-button"
            onClick={onOpenHubPage}
            type="button"
          >
            View {character.name} on VRoid Hub
          </button>
        </p>
      )}
    </>
  );
}
