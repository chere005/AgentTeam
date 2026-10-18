// 101 is deliberately new: existing numeric 100 remains Max, never Preempt.
export const priorities = [
  { value: 0, label: "Low" },
  { value: 50, label: "Medium" },
  { value: 75, label: "High" },
  { value: 100, label: "Max" },
  { value: 101, label: "Preempt" },
];
export function priorityName(value: number) {
  return (
    priorities.find((p) => p.value === value)?.label ??
    `Legacy priority ${value}`
  );
}
export function comparePriority(
  a: { priority: number; score: number },
  b: { priority: number; score: number },
) {
  return (
    Number(b.priority === 101) - Number(a.priority === 101) || b.score - a.score
  );
}
