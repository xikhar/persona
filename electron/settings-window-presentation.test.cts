import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSettingsWindowPresentationGate,
} from './settings-window-presentation.cjs';

test("delays the initial settings window until it is ready and themed", () => {
  const gate = createSettingsWindowPresentationGate();

  assert.equal(gate.requestShow(), false);
  assert.equal(gate.markReadyToShow(), false);
  assert.equal(gate.markThemeApplied(), true);
});

test("handles the resolved theme arriving before ready-to-show", () => {
  const gate = createSettingsWindowPresentationGate();

  assert.equal(gate.requestShow(), false);
  assert.equal(gate.markThemeApplied(), false);
  assert.equal(gate.markReadyToShow(), true);
});

test("presents an initialized settings window immediately on later requests", () => {
  const gate = createSettingsWindowPresentationGate();

  assert.equal(gate.markReadyToShow(), false);
  assert.equal(gate.markThemeApplied(), false);
  assert.equal(gate.requestShow(), true);
  assert.equal(gate.markThemeApplied(), false);
  assert.equal(gate.requestShow(), true);
});
