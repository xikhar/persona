import type { SettingsSnapshotLike } from './types.cjs';

export function snapshotHasConfiguredModel(
  snapshot: SettingsSnapshotLike | null | undefined,
): boolean {
  return (
    snapshot?.default_model_id != null &&
    Array.isArray(snapshot.models) &&
    snapshot.models.some(
      (model) => model?.id === snapshot.default_model_id,
    )
  );
}
