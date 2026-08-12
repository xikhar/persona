import assert from 'node:assert/strict';
import http from 'node:http';
import test, { type TestContext } from 'node:test';
import type {
  IncomingHttpHeaders,
  Server,
  ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  characterModelPageUrl,
  createVroidHubClient,
} from './vroid-hub-client.cjs';
import { isRecord } from './types.cjs';

const TOKEN = { accessToken: "access-1", tokenType: "Bearer" };

interface FakeHubRequest {
  body: string;
  headers: IncomingHttpHeaders;
  method: string;
  url: string;
}

interface FakeHubServer extends Server {
  address(): AddressInfo;
}

type FakeHubRequestHandler = (
  request: FakeHubRequest,
  response: ServerResponse,
) => void;

function startFakeHub(
  context: TestContext,
  { onRequest }: { onRequest: FakeHubRequestHandler },
): Promise<FakeHubServer> {
  const server = http.createServer((request, response) => {
    // IncomingMessage's fields (headers included) aren't own-enumerable, so
    // build an explicit plain object rather than `{ ...request }`, which
    // would silently drop `headers`.
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      onRequest(
        {
          url: request.url ?? '/',
          method: request.method ?? 'GET',
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        },
        response,
      );
    });
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return new Promise<FakeHubServer>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Fake VRoid Hub did not bind to TCP.'));
        return;
      }
      resolve(server as FakeHubServer);
    });
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function characterModel(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "model-1",
    name: "My Character",
    is_downloadable: false,
    is_other_users_available: true,
    // A model is nested under the character that owns it, and the two have
    // separate ids — model pages are addressed by both.
    character: { id: "character-1" },
    portrait_image: { sq300: { url: "https://images.vroid.com/portrait.png" } },
    ...overrides,
  };
}

test("lists the account's own models and eligible hearted models, filtering ineligible hearts", async (context) => {
  let heartsUrl: string | null = null;
  const server = await startFakeHub(context, {
    onRequest(request, response) {
      if (request.url.startsWith("/api/account/character_models")) {
        assert.equal(request.headers.authorization, "Bearer access-1");
        assert.equal(request.headers["x-api-version"], "11");
        return json(response, 200, {
          data: [characterModel({ id: "own-1", name: "Owned" })],
        });
      }
      if (request.url.startsWith("/api/hearts")) {
        heartsUrl = request.url;
        // /api/hearts' data entries are the character models themselves,
        // not a heart record wrapping one under a character_model key.
        return json(response, 200, {
          data: [
            characterModel({
              id: "hearted-allowed",
              name: "Hearted, allowed",
              is_other_users_available: true,
            }),
            characterModel({
              id: "hearted-blocked",
              name: "Hearted, blocked",
              is_other_users_available: false,
            }),
          ],
        });
      }
      response.writeHead(404);
      response.end();
    },
  });
  const client = createVroidHubClient({
    applicationId: "app-123",
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });

  const characters = await client.listCharacters(TOKEN);

  assert.deepEqual(
    characters.map((character) => character.id).sort(),
    ["hearted-allowed", "own-1"],
  );
  assert.deepEqual(
    Object.fromEntries(characters.map((character) => [character.id, character.origin])),
    { "hearted-allowed": "hearted", "own-1": "own" },
  );
  if (typeof heartsUrl !== 'string') throw new Error('Hearts endpoint was not requested.');
  assert.equal(
    new URL(heartsUrl, "http://x").searchParams.get("application_id"),
    "app-123",
  );
});

test("follows _links.next.href until exhausted so nothing past the first page is lost", async (context) => {
  const requestedUrls: string[] = [];
  const server = await startFakeHub(context, {
    onRequest(request, response) {
      requestedUrls.push(request.url);
      const url = new URL(request.url, "http://x");
      if (url.pathname === "/api/account/character_models") {
        const page = url.searchParams.get("max_id") ?? "1";
        // Page 2's link is absolute, page 3's is relative: VRoid Hub is only
        // documented as returning "the next page's URL", so accept both.
        if (page === "1") {
          return json(response, 200, {
            data: [characterModel({ id: "own-1" })],
            _links: {
              next: {
                href: `http://127.0.0.1:${server.address().port}/api/account/character_models?count=100&max_id=2`,
              },
            },
          });
        }
        if (page === "2") {
          return json(response, 200, {
            data: [characterModel({ id: "own-2" })],
            _links: { next: { href: "/api/account/character_models?count=100&max_id=3" } },
          });
        }
        // Last page: a full `data` array but no next link.
        return json(response, 200, { data: [characterModel({ id: "own-3" })] });
      }
      if (url.pathname === "/api/hearts") {
        if (url.searchParams.get("max_id") == null) {
          return json(response, 200, {
            data: [characterModel({ id: "hearted-1" })],
            // The heart endpoint's next link carries application_id forward;
            // the client has to follow the href's query as given, not rebuild
            // it, or page 2 loses the app scoping.
            _links: {
              next: { href: "/api/hearts?count=100&application_id=app-123&max_id=2" },
            },
          });
        }
        return json(response, 200, { data: [characterModel({ id: "hearted-2" })] });
      }
      response.writeHead(404);
      response.end();
    },
  });
  const client = createVroidHubClient({
    applicationId: "app-123",
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });

  const characters = await client.listCharacters(TOKEN);

  assert.deepEqual(
    characters.map((character) => character.id).sort(),
    ["hearted-1", "hearted-2", "own-1", "own-2", "own-3"],
  );
  assert.equal(
    requestedUrls.filter((url) => url.startsWith("/api/account/character_models")).length,
    3,
  );
  // Ask for the API's maximum page size, and keep every query parameter the
  // next link hands back rather than reassembling the URL ourselves.
  const [firstAccountUrl] = requestedUrls.filter((url) =>
    url.startsWith("/api/account/character_models"),
  );
  const heartsUrls = requestedUrls.filter((url) => url.startsWith("/api/hearts"));
  assert.ok(firstAccountUrl && heartsUrls[0] && heartsUrls[1]);
  assert.equal(new URL(firstAccountUrl, "http://x").searchParams.get("count"), "100");
  assert.equal(new URL(heartsUrls[0], "http://x").searchParams.get("count"), "100");
  assert.equal(
    new URL(heartsUrls[1], "http://x").searchParams.get("application_id"),
    "app-123",
  );
});

test("stops paging rather than replaying a next link that points off the configured host", async (context) => {
  const requestedUrls: string[] = [];
  const server = await startFakeHub(context, {
    onRequest(request, response) {
      requestedUrls.push(request.url);
      if (request.url.startsWith("/api/account/character_models")) {
        return json(response, 200, {
          data: [characterModel({ id: "own-1" })],
          // Following this would re-request a foreign URL's path from VRoid
          // Hub; the token itself can't escape, since only the path and
          // query are kept and they're resolved against baseUrl again.
          _links: {
            next: { href: "https://attacker.example/api/account/character_models?count=100" },
          },
        });
      }
      if (request.url.startsWith("/api/hearts")) {
        return json(response, 200, { data: [] });
      }
      response.writeHead(404);
      response.end();
    },
  });
  const client = createVroidHubClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });

  const characters = await client.listCharacters(TOKEN);

  assert.deepEqual(characters.map((character) => character.id), ["own-1"]);
  assert.equal(
    requestedUrls.filter((url) => url.startsWith("/api/account/character_models")).length,
    1,
  );
});

test("caps paging so an API that always returns a next link can't loop forever", async (context) => {
  let accountRequests = 0;
  const server = await startFakeHub(context, {
    onRequest(request, response) {
      if (request.url.startsWith("/api/account/character_models")) {
        accountRequests += 1;
        return json(response, 200, {
          data: [characterModel({ id: `own-${accountRequests}` })],
          _links: {
            next: { href: `/api/account/character_models?count=100&max_id=${accountRequests}` },
          },
        });
      }
      if (request.url.startsWith("/api/hearts")) {
        return json(response, 200, { data: [] });
      }
      response.writeHead(404);
      response.end();
    },
  });
  const client = createVroidHubClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });

  const characters = await client.listCharacters(TOKEN);

  assert.equal(accountRequests, 20);
  assert.equal(characters.length, 20);
});

test("extracts VRM 0.0 and VRM 1.0 conditions of use in their own native shapes", async (context) => {
  const server = await startFakeHub(context, {
    onRequest(request, response) {
      if (request.url.startsWith("/api/account/character_models")) {
        return json(response, 200, {
          data: [
            characterModel({
              id: "vrm0-model",
              license: {
                spec_version: 'hostile-value',
                credit: "necessary",
                personal_commercial_use: "profit",
                redistribution: 'not-a-permission',
              },
            }),
            characterModel({
              id: "vrm1-model",
              latest_character_model_version: {
                spec_version: "1.0",
                vrm_meta: {
                  commercialUsage: "personalProfit",
                  creditNotation: "required",
                  allowRedistribution: false,
                },
              },
            }),
            characterModel({ id: "no-license-model" }),
          ],
        });
      }
      if (request.url.startsWith("/api/hearts")) {
        return json(response, 200, { data: [] });
      }
      response.writeHead(404);
      response.end();
    },
  });
  const client = createVroidHubClient({
    applicationId: "app-123",
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });

  const characters = await client.listCharacters(TOKEN);
  const byId = Object.fromEntries(characters.map((c) => [c.id, c.license]));

  assert.deepEqual(byId["vrm0-model"], {
    spec_version: "0.0",
    credit: "necessary",
    personal_commercial_use: "profit",
  });
  assert.deepEqual(byId["vrm1-model"], {
    spec_version: "1.0",
    commercialUsage: "personalProfit",
    creditNotation: "required",
    allowRedistribution: false,
  });
  assert.equal(byId["no-license-model"], null);
});

test("downloads a licensed character model through the redirect flow", async (context) => {
  const fileBytes = Buffer.from("glTFmodelbytes");
  const server = await startFakeHub(context, {
    onRequest(request, response) {
      if (request.method === "POST" && request.url === "/api/download_licenses") {
        assert.equal(request.headers.authorization, "Bearer access-1");
        assert.deepEqual(JSON.parse(request.body), { character_model_id: "model-1" });
        return json(response, 200, { data: { id: "license-1" } });
      }
      if (request.url === "/api/download_licenses/license-1/download") {
        response.writeHead(302, {
          location: `http://127.0.0.1:${server.address().port}/files/model.vrm`,
        });
        return response.end();
      }
      if (request.url === "/files/model.vrm") {
        response.writeHead(200, { "content-type": "model/gltf-binary" });
        return response.end(fileBytes);
      }
      response.writeHead(404);
      response.end();
    },
  });
  const client = createVroidHubClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });

  const buffer = await client.loadCharacterModel(TOKEN, "model-1");

  assert.equal(Buffer.isBuffer(buffer), true);
  assert.equal(buffer.equals(fileBytes), true);
});

test("surfaces a denied download license instead of guessing a URL", async (context) => {
  const server = await startFakeHub(context, {
    onRequest(_request, response) {
      json(response, 403, { error: "forbidden" });
    },
  });
  const client = createVroidHubClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });

  await assert.rejects(
    () => client.loadCharacterModel(TOKEN, "model-1"),
    /declined to license/i,
  );
});

test("rejects a redirect response with no Location header", async (context) => {
  const server = await startFakeHub(context, {
    onRequest(request, response) {
      if (request.url === "/api/download_licenses") {
        return json(response, 200, { data: { id: "license-1" } });
      }
      response.writeHead(302);
      response.end();
    },
  });
  const client = createVroidHubClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });

  await assert.rejects(
    () => client.loadCharacterModel(TOKEN, "model-1"),
    /download URL/i,
  );
});

// Revoking the app on hub.vroid.com invalidates the access token immediately,
// while expires_at still looks fine — so a 401 is the only sign the session
// needs re-checking, and main.cts can only act on it if the status survives.
test("tags a failed API request with its status so a 401 is recognizable", async (context) => {
  const server = await startFakeHub(context, {
    onRequest(_request, response) {
      json(response, 401, { error: "unauthorized" });
    },
  });
  const client = createVroidHubClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });

  const error: unknown = await client.listCharacters(TOKEN).catch((reason: unknown) => reason);
  assert.ok(isRecord(error));
  assert.equal(error.status, 401);
  assert.equal(typeof error.message, 'string');
  assert.match(String(error.message), /API request failed \(401\)/);
});

test("tags a denied download license with its status", async (context) => {
  const server = await startFakeHub(context, {
    onRequest(_request, response) {
      json(response, 401, { error: "unauthorized" });
    },
  });
  const client = createVroidHubClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });

  const error: unknown = await client
    .loadCharacterModel(TOKEN, "model-1")
    .catch((reason: unknown) => reason);
  assert.ok(isRecord(error));
  assert.equal(error.status, 401);
});

// A success here is itself a redirect, so `ok` can't mark one — only the
// Location header can. Its absence still has to carry the status through.
test("tags a missing download redirect with its status", async (context) => {
  const server = await startFakeHub(context, {
    onRequest(request, response) {
      if (request.url === "/api/download_licenses") {
        return json(response, 200, { data: { id: "license-1" } });
      }
      json(response, 401, { error: "unauthorized" });
    },
  });
  const client = createVroidHubClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });

  const error: unknown = await client
    .loadCharacterModel(TOKEN, "model-1")
    .catch((reason: unknown) => reason);
  assert.ok(isRecord(error));
  assert.equal(error.status, 401);
  assert.equal(typeof error.message, 'string');
  assert.match(String(error.message), /download URL \(401\)/);
});

test("carries the owning character's id, which a model's Hub page is addressed by", async (context) => {
  const server = await startFakeHub(context, {
    onRequest(request, response) {
      if (request.url.startsWith("/api/account/character_models")) {
        return json(response, 200, {
          data: [
            characterModel({ id: "model-1", character: { id: "character-9" } }),
            // A model with no character block still lists; the picker just
            // can't offer a link to it.
            characterModel({ id: "model-2", character: undefined }),
          ],
        });
      }
      return json(response, 200, { data: [] });
    },
  });
  const client = createVroidHubClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });

  const characters = await client.listCharacters(TOKEN);

  assert.deepEqual(
    Object.fromEntries(
      characters.map((character) => [character.id, character.character_id]),
    ),
    { "model-1": "character-9", "model-2": null },
  );
});

test("inlines a listed character's portrait as a data URL without sending the token", async (context) => {
  const portraitBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02]);
  const portraitRequest: { headers: IncomingHttpHeaders | null } = {
    headers: null,
  };
  const server = await startFakeHub(context, {
    onRequest(request, response) {
      if (request.url === "/portrait-sq300.png") {
        portraitRequest.headers = request.headers;
        response.writeHead(200, { "content-type": "image/png" });
        return response.end(portraitBytes);
      }
      if (request.url.startsWith("/api/account/character_models")) {
        return json(response, 200, {
          data: [
            characterModel({
              id: "own-1",
              portrait_image: {
                // Ordered worst-first to prove the small square crop wins:
                // `original` on VRoid Hub can be a multi-megabyte render.
                original: { url: "/portrait-original.png" },
                sq300: { url: "/portrait-sq300.png" },
              },
            }),
          ],
        });
      }
      return json(response, 200, { data: [] });
    },
  });
  const client = createVroidHubClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });

  const [character] = await client.listCharacters(TOKEN);
  assert.ok(character?.portrait_url);
  assert.match(character.portrait_url, /portrait-sq300\.png$/);

  const dataUrl = await client.loadCharacterPortrait("own-1");

  assert.equal(
    dataUrl,
    `data:image/png;base64,${portraitBytes.toString("base64")}`,
  );
  // The image CDN is a different host from the API, so the access token must
  // not ride along with the portrait request.
  assert.equal(portraitRequest.headers?.authorization, undefined);
});

test("returns no portrait for an id the last listing never handed out", async () => {
  const client = createVroidHubClient({ baseUrl: "http://127.0.0.1:1" });

  // Nothing is fetched at all: an unlisted id has no URL, which is what keeps
  // the renderer from steering main-process requests anywhere it likes.
  assert.equal(await client.loadCharacterPortrait("never-listed"), null);
});

test("ignores a portrait response that isn't a displayable image", async (context) => {
  const server = await startFakeHub(context, {
    onRequest(request, response) {
      if (request.url === "/markup.png") {
        response.writeHead(200, { "content-type": "text/html" });
        return response.end("<script>nope</script>");
      }
      // SVG matches `image/*` but buys nothing as a portrait, so it's not on
      // the allowlist either.
      if (request.url === "/vector.png") {
        response.writeHead(200, { "content-type": "image/svg+xml" });
        return response.end("<svg xmlns='http://www.w3.org/2000/svg'/>");
      }
      if (request.url.startsWith("/api/account/character_models")) {
        return json(response, 200, {
          data: [
            characterModel({
              id: "markup",
              portrait_image: { sq300: { url: "/markup.png" } },
            }),
            characterModel({
              id: "vector",
              portrait_image: { sq300: { url: "/vector.png" } },
            }),
          ],
        });
      }
      return json(response, 200, { data: [] });
    },
  });
  const client = createVroidHubClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });

  await client.listCharacters(TOKEN);

  assert.equal(await client.loadCharacterPortrait("markup"), null);
  assert.equal(await client.loadCharacterPortrait("vector"), null);
});

test("addresses a model's Hub page by both the character and model id", () => {
  // The model id alone resolves to nothing — /characters/<model id> is a 404.
  assert.equal(
    characterModelPageUrl("character-9", "model-1"),
    "https://hub.vroid.com/characters/character-9/models/model-1",
  );
});

test("keeps a hostile id inside the model page path", () => {
  assert.equal(
    characterModelPageUrl("../../evil", "a b/c?d#e"),
    "https://hub.vroid.com/characters/..%2F..%2Fevil/models/a%20b%2Fc%3Fd%23e",
  );
});

test("refuses to build a model page URL from a missing id", () => {
  assert.throws(
    () => characterModelPageUrl("", "model-1"),
    /character id is required/i,
  );
  assert.throws(
    () => characterModelPageUrl("character-9", ""),
    /character model id is required/i,
  );
  assert.throws(
    () => characterModelPageUrl("character-9", undefined),
    /character model id is required/i,
  );
});

test("holds portrait downloads to a fixed number of concurrent requests", async (context) => {
  const modelCount = 20;
  let inFlight = 0;
  let peakInFlight = 0;
  const release: (() => void)[] = [];
  const server = await startFakeHub(context, {
    onRequest(request, response) {
      if (request.url.startsWith("/portrait-")) {
        inFlight += 1;
        peakInFlight = Math.max(peakInFlight, inFlight);
        // Held open until every request that's going to arrive has, so the
        // peak reflects the client's ceiling and not the server's speed.
        release.push(() => {
          inFlight -= 1;
          response.writeHead(200, { "content-type": "image/png" });
          response.end(Buffer.from([0x89, 0x50]));
        });
        return;
      }
      if (request.url.startsWith("/api/account/character_models")) {
        return json(response, 200, {
          data: Array.from({ length: modelCount }, (_unused, index) =>
            characterModel({
              id: `model-${index}`,
              portrait_image: { sq300: { url: `/portrait-${index}.png` } },
            }),
          ),
        });
      }
      return json(response, 200, { data: [] });
    },
  });
  const client = createVroidHubClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });
  const characters = await client.listCharacters(TOKEN);

  let done = false;
  const portraits = Promise.all(
    characters.map((character) => client.loadCharacterPortrait(character.id)),
  ).then((results) => {
    done = true;
    return results;
  });
  // Drained one at a time: each release frees a slot, and the set only ever
  // finishes if the client hands that slot to a queued request.
  while (!done) {
    release.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal((await portraits).length, modelCount);
  assert.ok(
    peakInFlight <= 6,
    `expected at most 6 concurrent portrait requests, saw ${peakInFlight}`,
  );
});

test("ignores an oversized portrait without buffering it", async (context) => {
  const server = await startFakeHub(context, {
    onRequest(request, response) {
      if (request.url === "/portrait.png") {
        response.writeHead(200, {
          "content-type": "image/png",
          "content-length": String(64 * 1024 * 1024),
        });
        return response.end(Buffer.alloc(8));
      }
      if (request.url.startsWith("/api/account/character_models")) {
        return json(response, 200, {
          data: [
            characterModel({
              id: "own-1",
              portrait_image: { sq300: { url: "/portrait.png" } },
            }),
          ],
        });
      }
      return json(response, 200, { data: [] });
    },
  });
  const client = createVroidHubClient({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  });

  await client.listCharacters(TOKEN);

  assert.equal(await client.loadCharacterPortrait("own-1"), null);
});

test("requires a character id", async () => {
  const client = createVroidHubClient({ baseUrl: "http://127.0.0.1:1" });
  await assert.rejects(
    () => client.loadCharacterModel(TOKEN, ""),
    /character id is required/i,
  );
});
