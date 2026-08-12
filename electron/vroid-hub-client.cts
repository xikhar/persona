import type { VroidHubAccessToken } from './vroid-hub-auth.cjs';
import { isRecord } from './types.cjs';
import type {
  PersonaVroidHubCharacter as VroidCharacterSummary,
  PersonaVroidHubCharacterLicense as VroidCharacterLicense,
  PersonaVroidHubCharacterLicenseV0,
  PersonaVroidHubCharacterLicenseV1,
} from '../shared/persona-api.js';

export const DEFAULT_BASE_URL = 'https://hub.vroid.com';
const API_VERSION = '11';
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const API_REQUEST_TIMEOUT_MS = 15 * 1000;
const PORTRAIT_TIMEOUT_MS = 20 * 1000;
const MAX_PORTRAIT_BYTES = 2 * 1024 * 1024;
const PORTRAIT_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
const MAX_CONCURRENT_PORTRAITS = 6;
const DOWNLOAD_TIMEOUT_MS = 120 * 1000;

export type VroidCharacterOrigin = 'own' | 'hearted';
export type { VroidCharacterLicense, VroidCharacterSummary };

export interface VroidHubClientOptions {
  applicationId?: string | null;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface VroidHubClient {
  listCharacters(token: VroidHubAccessToken): Promise<VroidCharacterSummary[]>;
  loadCharacterModel(
    token: VroidHubAccessToken,
    characterId: unknown,
  ): Promise<Buffer>;
  loadCharacterPortrait(characterId: string): Promise<string | null>;
}

class HttpStatusError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export function characterModelPageUrl(
  characterId: unknown,
  characterModelId: unknown,
): string {
  if (typeof characterId !== 'string' || characterId === '') {
    throw new Error('A character id is required.');
  }
  if (typeof characterModelId !== 'string' || characterModelId === '') {
    throw new Error('A character model id is required.');
  }
  return (
    `${DEFAULT_BASE_URL}/characters/${encodeURIComponent(characterId)}` +
    `/models/${encodeURIComponent(characterModelId)}`
  );
}

function httpError(message: string, status: number): HttpStatusError {
  return new HttpStatusError(message, status);
}

function authorizedHeaders(
  token: Partial<VroidHubAccessToken> = {},
  extra: Record<string, string> = {},
): Record<string, string> {
  const { accessToken, tokenType = 'Bearer' } = token;
  if (typeof accessToken !== 'string' || accessToken === '') {
    throw new Error('A VRoid Hub access token is required.');
  }
  return {
    Authorization: `${tokenType} ${accessToken}`,
    'X-Api-Version': API_VERSION,
    ...extra,
  };
}

function childRecord(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> | null {
  return isRecord(value[field]) ? value[field] : null;
}

function allowedString<const TValue extends string>(
  value: unknown,
  allowed: readonly TValue[],
): TValue | undefined {
  if (typeof value !== 'string') return undefined;
  return allowed.find((candidate) => candidate === value);
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function setOptional<TKey extends string, TValue>(
  target: Partial<Record<TKey, TValue>>,
  key: TKey,
  value: TValue | undefined,
): void {
  if (value !== undefined) target[key] = value;
}

function vroid1License(
  vrmMeta: Record<string, unknown>,
): PersonaVroidHubCharacterLicenseV1 {
  const license: PersonaVroidHubCharacterLicenseV1 = { spec_version: '1.0' };
  setOptional(
    license,
    'avatarPermission',
    allowedString(vrmMeta.avatarPermission, [
      'onlyAuthor',
      'onlySeparatelyLicensedPerson',
      'everyone',
    ]),
  );
  setOptional(
    license,
    'allowExcessivelyViolentUsage',
    optionalBoolean(vrmMeta.allowExcessivelyViolentUsage),
  );
  setOptional(
    license,
    'allowExcessivelySexualUsage',
    optionalBoolean(vrmMeta.allowExcessivelySexualUsage),
  );
  setOptional(
    license,
    'commercialUsage',
    allowedString(vrmMeta.commercialUsage, [
      'personalNonProfit',
      'personalProfit',
      'corporation',
    ]),
  );
  setOptional(
    license,
    'allowPoliticalOrReligiousUsage',
    optionalBoolean(vrmMeta.allowPoliticalOrReligiousUsage),
  );
  setOptional(
    license,
    'allowAntisocialOrHateUsage',
    optionalBoolean(vrmMeta.allowAntisocialOrHateUsage),
  );
  setOptional(
    license,
    'creditNotation',
    allowedString(vrmMeta.creditNotation, ['required', 'unnecessary']),
  );
  setOptional(
    license,
    'allowRedistribution',
    optionalBoolean(vrmMeta.allowRedistribution),
  );
  setOptional(
    license,
    'modification',
    allowedString(vrmMeta.modification, [
      'prohibited',
      'allowModification',
      'allowModificationRedistribution',
    ]),
  );
  return license;
}

function vroid0License(
  source: Record<string, unknown>,
): PersonaVroidHubCharacterLicenseV0 {
  const license: PersonaVroidHubCharacterLicenseV0 = { spec_version: '0.0' };
  setOptional(
    license,
    'characterization_allowed_user',
    allowedString(source.characterization_allowed_user, [
      'default',
      'author',
      'everyone',
    ]),
  );
  setOptional(
    license,
    'personal_commercial_use',
    allowedString(source.personal_commercial_use, [
      'default',
      'disallow',
      'profit',
      'nonprofit',
    ]),
  );
  for (const key of [
    'corporate_commercial_use',
    'modification',
    'redistribution',
    'violent_expression',
    'sexual_expression',
  ] as const) {
    setOptional(
      license,
      key,
      allowedString(source[key], ['default', 'disallow', 'allow']),
    );
  }
  setOptional(
    license,
    'credit',
    allowedString(source.credit, ['default', 'necessary', 'unnecessary']),
  );
  return license;
}

function characterLicense(
  model: Record<string, unknown>,
): VroidCharacterLicense | null {
  const latest = childRecord(model, 'latest_character_model_version');
  if (latest?.spec_version === '1.0') {
    const vrmMeta = childRecord(latest, 'vrm_meta');
    if (!vrmMeta) return null;
    return vroid1License(vrmMeta);
  }
  const license = childRecord(model, 'license');
  return license ? vroid0License(license) : null;
}

const PORTRAIT_VARIANTS = [
  'sq300',
  'sq150',
  'sq600',
  'w300',
  'w600',
  'q75',
  'original',
] as const;

function portraitUrl(model: Record<string, unknown>): string | null {
  const portrait = childRecord(model, 'portrait_image');
  if (!portrait) return null;
  for (const variant of PORTRAIT_VARIANTS) {
    const image = isRecord(portrait[variant]) ? portrait[variant] : null;
    const url = image?.url;
    if (typeof url === 'string' && url !== '') return url;
  }
  return null;
}

function toCharacterSummary(
  model: Record<string, unknown>,
  origin: VroidCharacterOrigin,
): VroidCharacterSummary {
  const character = childRecord(model, 'character');
  return {
    id: String(model.id),
    name:
      typeof model.name === 'string' && model.name.trim() !== ''
        ? model.name
        : 'Untitled character',
    is_downloadable: Boolean(model.is_downloadable),
    character_id:
      typeof character?.id === 'string' && character.id !== ''
        ? character.id
        : null,
    portrait_url: portraitUrl(model),
    origin,
    license: characterLicense(model),
  };
}

export function createVroidHubClient({
  applicationId = null,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
}: VroidHubClientOptions = {}): VroidHubClient {
  const baseOrigin = new URL(baseUrl).origin;
  const portraitUrlsById = new Map<string, string>();
  let activePortraitFetches = 0;
  const waitingPortraitFetches: Array<() => void> = [];

  function acquirePortraitSlot(): Promise<void> {
    if (activePortraitFetches < MAX_CONCURRENT_PORTRAITS) {
      activePortraitFetches += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waitingPortraitFetches.push(resolve));
  }

  function releasePortraitSlot(): void {
    const next = waitingPortraitFetches.shift();
    if (next) next();
    else activePortraitFetches -= 1;
  }

  async function fetchJson(
    pathname: string,
    token: VroidHubAccessToken,
  ): Promise<unknown> {
    const url = new URL(pathname, baseUrl);
    const response = await fetchImpl(url.toString(), {
      headers: authorizedHeaders(token),
      signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw httpError(
        `VRoid Hub API request failed (${response.status}).`,
        response.status,
      );
    }
    return response.json();
  }

  function nextPagePath(body: unknown, currentPath: string): string | null {
    if (!isRecord(body)) return null;
    const links = childRecord(body, '_links');
    const nextLink = links ? childRecord(links, 'next') : null;
    const href = nextLink?.href;
    if (typeof href !== 'string' || href === '') return null;
    const next = new URL(href, new URL(currentPath, baseUrl));
    if (next.origin !== baseOrigin) return null;
    return `${next.pathname}${next.search}`;
  }

  async function fetchAllPages(
    initialPath: string,
    token: VroidHubAccessToken,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let currentPath: string | null = initialPath;
    for (let page = 0; page < MAX_PAGES && currentPath != null; page += 1) {
      const body = await fetchJson(currentPath, token);
      if (isRecord(body) && Array.isArray(body.data)) {
        items.push(...body.data.filter(isRecord));
      }
      currentPath = nextPagePath(body, currentPath);
    }
    return items;
  }

  async function listCharacters(
    token: VroidHubAccessToken,
  ): Promise<VroidCharacterSummary[]> {
    const heartsQuery = new URLSearchParams({ count: String(PAGE_SIZE) });
    if (applicationId) heartsQuery.set('application_id', applicationId);
    const [ownModels, hearts] = await Promise.all([
      fetchAllPages(`/api/account/character_models?count=${PAGE_SIZE}`, token),
      fetchAllPages(`/api/hearts?${heartsQuery.toString()}`, token),
    ]);
    const heartedModels = hearts.filter(
      (model) => model.is_other_users_available === true,
    );

    const ownIds = new Set(
      ownModels
        .map((model) => model.id)
        .filter((id): id is string => typeof id === 'string'),
    );
    const byId = new Map<string, VroidCharacterSummary>();
    for (const model of [...ownModels, ...heartedModels]) {
      if (typeof model.id !== 'string') continue;
      const origin: VroidCharacterOrigin = ownIds.has(model.id)
        ? 'own'
        : 'hearted';
      byId.set(model.id, toCharacterSummary(model, origin));
    }
    const characters = [...byId.values()];
    portraitUrlsById.clear();
    for (const character of characters) {
      if (character.portrait_url != null) {
        portraitUrlsById.set(character.id, character.portrait_url);
      }
    }
    return characters;
  }

  async function loadCharacterPortrait(
    characterId: string,
  ): Promise<string | null> {
    const rawUrl = portraitUrlsById.get(characterId);
    if (rawUrl == null) return null;
    let url: URL;
    try {
      url = new URL(rawUrl, baseUrl);
    } catch {
      return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    await acquirePortraitSlot();
    try {
      const response = await fetchImpl(url.toString(), {
        signal: AbortSignal.timeout(PORTRAIT_TIMEOUT_MS),
      });
      if (!response.ok) return null;
      const contentType = (response.headers.get('content-type') ?? '')
        .split(';')[0]
        ?.trim()
        .toLowerCase();
      if (!contentType || !PORTRAIT_CONTENT_TYPES.has(contentType)) return null;
      const declaredLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_PORTRAIT_BYTES) {
        return null;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > MAX_PORTRAIT_BYTES) return null;
      return `data:${contentType};base64,${bytes.toString('base64')}`;
    } finally {
      releasePortraitSlot();
    }
  }

  async function loadCharacterModel(
    token: VroidHubAccessToken,
    characterId: unknown,
  ): Promise<Buffer> {
    if (typeof characterId !== 'string' || characterId === '') {
      throw new Error('A character id is required.');
    }
    const licenseResponse = await fetchImpl(
      new URL('/api/download_licenses', baseUrl).toString(),
      {
        method: 'POST',
        headers: authorizedHeaders(token, { 'content-type': 'application/json' }),
        body: JSON.stringify({ character_model_id: characterId }),
        signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
      },
    );
    if (!licenseResponse.ok) {
      throw httpError(
        `VRoid Hub declined to license this model for download (${licenseResponse.status}).`,
        licenseResponse.status,
      );
    }
    const license: unknown = await licenseResponse.json();
    const licenseData = isRecord(license) ? childRecord(license, 'data') : null;
    const licenseId = licenseData?.id;
    if (typeof licenseId !== 'string' || licenseId === '') {
      throw new Error('VRoid Hub did not return a download license id.');
    }

    const downloadResponse = await fetchImpl(
      new URL(`/api/download_licenses/${licenseId}/download`, baseUrl).toString(),
      {
        method: 'GET',
        redirect: 'manual',
        headers: authorizedHeaders(token),
        signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
      },
    );
    const downloadUrl = downloadResponse.headers.get('location');
    if (typeof downloadUrl !== 'string' || downloadUrl === '') {
      throw httpError(
        `VRoid Hub did not return a model download URL (${downloadResponse.status}).`,
        downloadResponse.status,
      );
    }

    const fileResponse = await fetchImpl(downloadUrl, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!fileResponse.ok) {
      throw new Error(
        `Downloading the VRM file failed (${fileResponse.status}).`,
      );
    }
    return Buffer.from(await fileResponse.arrayBuffer());
  }

  return { listCharacters, loadCharacterModel, loadCharacterPortrait };
}
