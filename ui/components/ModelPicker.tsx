import { useEffect, useState } from "react";
import { api } from "../api";
import {
  isSelectableModel,
  modelOptionLabel,
  modelOptions,
  type RuntimeModels,
} from "../../src/model-choices";

const CUSTOM = "__custom-model__";

/** Detected runtimes, fetched once (undefined while loading or when the request fails). */
export function useRuntimeList() {
  const [runtimes, setRuntimes] = useState<RuntimeModels[] | undefined>();
  useEffect(() => {
    let alive = true;
    api("/runtimes")
      .then((r: any) => alive && setRuntimes(r.runtimes))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return runtimes;
}

/**
 * Model dropdown for one environment: advertised and well-known models, the current value kept
 * even when unusable (grayed out, never swapped), and a "Custom model ID…" entry that reveals a
 * text input. With `keepLabel`, an empty value means "keep" and is the first entry.
 */
export function ModelPicker({
  label,
  environment,
  runtimes,
  value,
  onChange,
  keepLabel,
}: {
  label: string;
  environment: string;
  runtimes: RuntimeModels[] | undefined;
  value: string;
  onChange: (model: string) => void;
  keepLabel?: string;
}) {
  const [custom, setCustom] = useState(false);
  const runtime = runtimes?.find((r) => r.id === environment);
  const choices = modelOptions(runtime, value, environment);
  return (
    <div className="model-picker">
      <select
        aria-label={label}
        value={custom ? CUSTOM : value}
        onChange={(e) => {
          if (e.target.value === CUSTOM) return setCustom(true);
          setCustom(false);
          onChange(e.target.value);
        }}
      >
        {keepLabel !== undefined && <option value="">{keepLabel}</option>}
        {choices.map((m) => (
          <option key={m.id} value={m.id} disabled={!isSelectableModel(m)}>
            {modelOptionLabel(m)}
          </option>
        ))}
        <option value={CUSTOM}>Custom model ID…</option>
      </select>
      {custom && (
        <input
          aria-label={`Custom ${label[0].toLowerCase()}${label.slice(1)}`}
          placeholder="Model ID (not validated)"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
