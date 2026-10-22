import { useCallback, useEffect, useState } from "react";

/** Keep setup accordions per agent so selecting another canvas card doesn't reset the panel. */
export function usePersistedDetails(
  agentId: string | undefined,
  section: string,
  initial: boolean,
) {
  const key = `agentteam.setup.${agentId ?? "new"}.${section}`;
  const read = useCallback(() => {
    try {
      const value = localStorage.getItem(key);
      return value === null ? initial : value === "true";
    } catch {
      return initial;
    }
  }, [initial, key]);
  const [open, setOpen] = useState(read);
  useEffect(() => setOpen(read()), [read]);
  const onToggle = useCallback(
    (event: React.SyntheticEvent<HTMLDetailsElement>) => {
      const value = event.currentTarget.open;
      setOpen(value);
      try {
        localStorage.setItem(key, String(value));
      } catch {
        // Keep the current in-memory preference if browser storage is unavailable.
      }
    },
    [key],
  );
  return [open, onToggle] as const;
}
