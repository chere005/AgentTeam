import { priorities, priorityName } from "../../src/priorities";
export { priorityName };
export function PrioritySelect({
  value,
  onChange,
  label,
}: {
  value: number;
  onChange: (value: number) => void;
  label?: string;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
    >
      {priorities.map((p) => (
        <option key={p.value} value={p.value}>
          {p.label}
        </option>
      ))}
      {!priorities.some((p) => p.value === value) && (
        <option value={value}>{priorityName(value)}</option>
      )}
    </select>
  );
}
