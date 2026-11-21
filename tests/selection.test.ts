import { test } from "node:test";
import assert from "node:assert/strict";
const { PageSelection } = await import(
  new URL("../src/selection.js", import.meta.url).href
);

test("page selection supports individual toggles, select all and clear without hidden images", () => {
  const s = new PageSelection();
  s.setItems([
    { id: "a", revision: 1 },
    { id: "b", revision: 2 },
  ]);
  s.toggle("a", true);
  assert.deepEqual(s.entries(), [{ id: "a", revision: 1 }]);
  s.toggle("hidden", true);
  assert.equal(s.entries().length, 1);
  s.selectAll(true);
  assert.equal(s.entries().length, 2);
  s.toggle("a", false);
  assert.deepEqual(s.entries(), [{ id: "b", revision: 2 }]);
  s.selectAll(false);
  assert.deepEqual(s.entries(), []);
});
test("refresh retains unchanged selections, removes changed/missing images and never selects incoming rows", () => {
  const s = new PageSelection();
  s.setItems([
    { id: "a", revision: 1 },
    { id: "b", revision: 2 },
  ]);
  s.selectAll(true);
  assert.equal(
    s.setItems([
      { id: "a", revision: 1 },
      { id: "b", revision: 2 },
    ]),
    0,
  );
  assert.equal(s.entries().length, 2);
  assert.equal(
    s.setItems([
      { id: "a", revision: 3 },
      { id: "b", revision: 2 },
      { id: "c", revision: 1 },
    ]),
    1,
  );
  assert.deepEqual(s.entries(), [{ id: "b", revision: 2 }]);
  assert.equal(s.setItems([{ id: "c", revision: 1 }]), 1);
  assert.deepEqual(s.entries(), []);
  s.selectAll(true);
  s.clear();
  assert.deepEqual(s.entries(), []);
});
