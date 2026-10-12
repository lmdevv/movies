import { ChevronDownIcon } from "lucide-react";
import { useId } from "react";

/**
 * A labeled native select drawn as the Paper dropdown field: 36px, hairline, chevron at the end.
 * Native, so it opens the platform picker and works with the keyboard and screen readers.
 */
export function SelectField<Value extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  readonly label: string;
  readonly value: Value;
  readonly options: ReadonlyArray<{ readonly value: Value; readonly label: string }>;
  readonly onChange: (value: Value) => void;
  readonly className?: string;
}) {
  const id = useId();

  return (
    <div className={className}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="font-sans text-label/label font-medium text-text-muted">
          {label}
        </label>
        <div className="relative flex items-center">
          <select
            id={id}
            value={value}
            onChange={(event) => {
              const next = options.find((option) => option.value === event.target.value);

              if (next !== undefined) onChange(next.value);
            }}
            className="h-9 w-full cursor-pointer appearance-none rounded-control border border-hairline bg-surface pr-8 pl-3 font-sans text-label/label text-text outline-none"
          >
            {options.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <ChevronDownIcon
            className="pointer-events-none absolute right-3 size-3 text-text-muted"
            strokeWidth={1.75}
            aria-hidden
          />
        </div>
      </div>
    </div>
  );
}
