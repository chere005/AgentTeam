import { useEffect, useState } from "react";
import { api } from "../api";
import {
  capabilityLabels,
  type CapabilityKey,
  type RuntimeCapabilityRow,
} from "../../src/capabilities";
import "./runtime-ui.css";
export function RuntimeCapabilities() {
  const [rows, setRows] = useState<RuntimeCapabilityRow[]>([]);
  useEffect(() => {
    api("/runtime-capabilities")
      .then((r) => setRows(r.capabilities))
      .catch(() => {});
  }, []);
  const keys = Object.keys(capabilityLabels) as CapabilityKey[];
  return (
    <section className="settings-card" aria-label="Runtime capabilities">
      <div className="section-title">
        <div>
          <h3>Runtime capabilities</h3>
          <p>
            What AgentTeam implements for each runtime today, not everything the
            provider offers. Fixture-tested; live accounts are not verified.
          </p>
        </div>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="capability-table">
          <thead>
            <tr>
              <th>Runtime</th>
              {keys.map((k) => (
                <th key={k}>{capabilityLabels[k]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} data-testid={"capability-" + row.id}>
                <th scope="row">{row.label}</th>
                {keys.map((k) => (
                  <td key={k} className={"cap-" + row.capabilities[k].level}>
                    {row.capabilities[k].level === "yes"
                      ? "Yes"
                      : row.capabilities[k].level === "partial"
                        ? "Partial"
                        : "No"}
                    <small>{row.capabilities[k].note}</small>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
