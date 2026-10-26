import { useState } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import {
  ChevronDown,
  ChevronRight,
  CornerLeftUp,
  CornerRightDown,
  MoveHorizontal,
  Layers,
  MousePointerClick,
  Ungroup,
} from "lucide-react";
import type { Group, GroupSummary } from "../groups";
import "./team-groups.css";

/** Collapsed-group stand-in node on the canvas. */
export function GroupNode({ data }: NodeProps) {
  const g = data.group as Group,
    s = data.summary as GroupSummary;
  return (
    <div
      className={
        "group-card " +
        (s.failed ? "failed " : "") +
        (s.processing ? "busy " : "") +
        (data.selected ? "chosen" : "")
      }
      role="group"
      aria-label={`Group ${g.name}, ${s.members} agents, collapsed`}
    >
      <Handle type="target" position={Position.Top} />
      <div className="row">
        <Layers size={16} />
        <div className="grow">
          <b>{g.name}</b>
          <small>{s.members} agents</small>
        </div>
        <span className={"state-orbit " + (s.processing ? "processing" : "")} />
      </div>
      <div className="card-basics">
        <span>{s.processing} running</span>
        {s.failed > 0 && <span className="failure">{s.failed} failed</span>}
        {s.attention > 0 && (
          <span className="failure">{s.attention} need attention</span>
        )}
      </div>
      <button
        className="nodrag"
        aria-label={`Expand group ${g.name}`}
        onClick={() => (data.expand as () => void)()}
      >
        <ChevronRight size={13} />
        Expand
      </button>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

/** Toolbar for grouping selected agents and walking the agent hierarchy. */
export function GroupBar({
  groups,
  selectionCount,
  create,
  toggle,
  setAll,
  selectMembers,
  remove,
  nav,
}: {
  groups: Group[];
  selectionCount: number;
  create: (name: string) => void;
  toggle: (id: string) => void;
  setAll: (collapsed: boolean) => void;
  selectMembers: (id: string) => void;
  remove: (id: string) => void;
  nav: {
    parent: (() => void) | null;
    child: (() => void) | null;
    sibling: (() => void) | null;
  };
}) {
  const [name, setName] = useState("");
  return (
    <div
      className="group-bar"
      role="toolbar"
      aria-label="Team grouping and hierarchy"
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!selectionCount) return;
          create(name);
          setName("");
        }}
      >
        <input
          aria-label="Group name"
          placeholder="Group name"
          maxLength={40}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          type="submit"
          disabled={!selectionCount}
          title="Select agents on the canvas first"
        >
          <Layers size={14} />
          Group selected
        </button>
      </form>
      <div className="row" role="group" aria-label="Hierarchy navigation">
        <button
          disabled={!nav.parent}
          onClick={() => nav.parent?.()}
          title="Alt+Up"
        >
          <CornerLeftUp size={14} />
          Parent
        </button>
        <button
          disabled={!nav.child}
          onClick={() => nav.child?.()}
          title="Alt+Down"
        >
          <CornerRightDown size={14} />
          Child
        </button>
        <button
          disabled={!nav.sibling}
          onClick={() => nav.sibling?.()}
          title="Alt+Right"
        >
          <MoveHorizontal size={14} />
          Sibling
        </button>
      </div>
      {groups.length > 0 && (
        <ul className="group-list" aria-label="Groups">
          {groups.map((g) => (
            <li key={g.id} data-testid="group-chip">
              <button
                aria-expanded={!g.collapsed}
                aria-label={`${g.collapsed ? "Expand" : "Collapse"} group ${g.name}`}
                onClick={() => toggle(g.id)}
              >
                {g.collapsed ? (
                  <ChevronRight size={13} />
                ) : (
                  <ChevronDown size={13} />
                )}
                {g.name} ({g.agentIds.length})
              </button>
              <button
                className="icon"
                aria-label={`Select members of ${g.name}`}
                title="Select members"
                onClick={() => selectMembers(g.id)}
              >
                <MousePointerClick size={13} />
              </button>
              <button
                className="icon"
                aria-label={`Ungroup ${g.name}`}
                title="Ungroup"
                onClick={() => remove(g.id)}
              >
                <Ungroup size={13} />
              </button>
            </li>
          ))}
          <li>
            <button onClick={() => setAll(true)}>Collapse all</button>
            <button onClick={() => setAll(false)}>Expand all</button>
          </li>
        </ul>
      )}
    </div>
  );
}
