import { adjustRangeHandle, dualRangeStyle } from '../../range-slider';

export function MillisecondRangeSlider({
  disabled,
  label,
  maximum = 3600,
  minimum = 45,
  onCommit,
  onPreview,
  step = 5,
  value,
}: {
  disabled: boolean;
  label: string;
  maximum?: number;
  minimum?: number;
  onCommit: (range: readonly [number, number]) => void;
  onPreview: (range: readonly [number, number]) => void;
  step?: number;
  value: readonly [number, number];
}) {
  return (
    <div
      className="dual-range-slider"
      style={dualRangeStyle(value, minimum, maximum)}
    >
      <div className="dual-range-track" aria-hidden="true">
        <i />
      </div>
      {([0, 1] as const).map((handle) => (
        <input
          aria-label={`${label} ${handle === 0 ? 'minimum' : 'maximum'}`}
          className={`dual-range-input dual-range-input-${handle === 0 ? 'minimum' : 'maximum'}`}
          disabled={disabled}
          key={handle}
          max={maximum}
          min={minimum}
          onChange={(event) =>
            onPreview(
              adjustRangeHandle(value, handle, Number(event.currentTarget.value)),
            )
          }
          onKeyUp={(event) => {
            if (event.key.startsWith('Arrow')) {
              onCommit(
                adjustRangeHandle(
                  value,
                  handle,
                  Number(event.currentTarget.value),
                ),
              );
            }
          }}
          onPointerUp={(event) =>
            onCommit(
              adjustRangeHandle(value, handle, Number(event.currentTarget.value)),
            )
          }
          step={step}
          type="range"
          value={value[handle]}
        />
      ))}
    </div>
  );
}
