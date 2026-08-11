export interface ModelExpressionReport {
  expressions: readonly string[];
  modelUrl: string;
}

export function expressionsForModel(
  report: ModelExpressionReport | null,
  modelUrl: string | null,
): readonly string[] {
  return report?.modelUrl === modelUrl ? report.expressions : [];
}
