interface ExpressionManagerLike {
  getValue(name: string): number | null;
  setValue(name: string, weight: number): void;
}

interface ActiveExpression {
  name: PersonaExpressionName;
  previousValue: number;
}

export class ActionExpressionController {
  private active: ActiveExpression | null = null;

  constructor(private readonly manager: ExpressionManagerLike) {}

  activate(name: PersonaExpressionName): void {
    if (this.active?.name === name) {
      return;
    }

    this.clear();

    this.active = {
      name,
      previousValue: this.manager.getValue(name) ?? 0,
    };
  }

  apply(name: PersonaExpressionName, weight: number): void {
    this.activate(name);
    this.manager.setValue(name, weight);
  }

  clear(): void {
    if (!this.active) {
      return;
    }

    this.manager.setValue(this.active.name, this.active.previousValue);
    this.active = null;
  }
}