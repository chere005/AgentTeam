import { test } from "node:test";
import assert from "node:assert/strict";
import { chatTree } from "../ui/chat-tree.ts";
const agent = (id: string, parentId?: string) => ({ id, name: id, parentId });
test("chat tree nests children and grandchildren in stable order instead of flattening them", () => {
  const tree = chatTree([
    agent("worker", "manager"),
    agent("manager"),
    agent("reviewer", "manager"),
    agent("specialist", "worker"),
    agent("orphan", "missing"),
  ]);
  assert.deepEqual(
    tree.map((n) => n.agent.id),
    ["manager", "orphan"],
  );
  assert.deepEqual(
    tree[0].children.map((n) => n.agent.id),
    ["worker", "reviewer"],
  );
  assert.equal(tree[0].children[0].children[0].agent.id, "specialist");
});
test("malformed historical cycles retain every agent exactly once", () => {
  const tree = chatTree([
    agent("a", "b"),
    agent("b", "a"),
    agent("self", "self"),
  ]);
  const ids: string[] = [];
  const walk = (nodes: typeof tree) => {
    for (const node of nodes) {
      ids.push(node.agent.id);
      walk(node.children);
    }
  };
  walk(tree);
  assert.deepEqual(ids.sort(), ["a", "b", "self"]);
});
