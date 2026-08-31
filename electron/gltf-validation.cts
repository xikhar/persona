import { isRecord } from './types.cjs';

interface KhronosValidatorModule {
  validateBytes(data: Uint8Array, options: Record<string, unknown>): Promise<unknown>;
}

// gltf-validator is the Khronos reference validator compiled to JavaScript.
// The package does not publish TypeScript declarations, so keep its untyped
// boundary isolated here and validate the report before trusting it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const khronosValidator = require('gltf-validator') as KhronosValidatorModule;

function issueCount(issues: Record<string, unknown>, field: string): number {
  const value = issues[field];
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error('Khronos glTF Validator returned an invalid report.');
  }
  return Number(value);
}

export async function validateCoreGlb(buffer: Buffer): Promise<void> {
  const report = await khronosValidator.validateBytes(
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    {
      format: 'glb',
      maxIssues: 1000,
      uri: 'animation.vrma',
      writeTimestamp: false,
    },
  );
  if (!isRecord(report)) throw new Error('Khronos glTF Validator returned an invalid report.');
  const issues = isRecord(report.issues) ? report.issues : null;
  if (!issues) throw new Error('Khronos glTF Validator returned an invalid report.');
  const errors = issueCount(issues, 'numErrors');
  const warnings = issueCount(issues, 'numWarnings');
  if (errors === 0 && warnings === 0) return;

  const messages = Array.isArray(issues.messages) ? issues.messages : [];
  const firstProblem = messages.find(
    (candidate) => isRecord(candidate) && (candidate.severity === 0 || candidate.severity === 1),
  );
  const detail = isRecord(firstProblem)
    ? [firstProblem.code, firstProblem.pointer, firstProblem.message]
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
        .join(' at ')
    : `${errors} error(s), ${warnings} warning(s)`;
  throw new Error(`Khronos glTF validation failed: ${detail}`);
}
