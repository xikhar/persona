import assert from 'node:assert/strict';
import test from 'node:test';
import { isAllowedRendererNavigation } from './navigation-policy.cjs';

test("allows only the renderer entry or its development origin", () => {
  assert.equal(
    isAllowedRendererNavigation(
      "file:///opt/Persona/resources/app.asar/dist/index.html#view",
      "file:///opt/Persona/resources/app.asar/dist/index.html",
    ),
    true,
  );
  assert.equal(
    isAllowedRendererNavigation(
      "file:///opt/Persona/resources/app.asar/dist/other.html",
      "file:///opt/Persona/resources/app.asar/dist/index.html",
    ),
    false,
  );
  assert.equal(
    isAllowedRendererNavigation(
      "http://127.0.0.1:5173/scene",
      "http://127.0.0.1:5173/",
    ),
    true,
  );
  assert.equal(
    isAllowedRendererNavigation(
      "https://example.com/",
      "http://127.0.0.1:5173/",
    ),
    false,
  );
});
