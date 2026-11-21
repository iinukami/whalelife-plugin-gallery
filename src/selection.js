/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
// Selection belongs to the visible page and captures revisions at selection time.
export class PageSelection {
  items = new Map();
  selected = new Map();
  setItems(items) {
    this.items = new Map(items.map((a) => [a.id, a.revision]));
    let removed = 0;
    for (const [id, revision] of this.selected)
      if (!this.items.has(id) || this.items.get(id) !== revision) {
        this.selected.delete(id);
        removed++;
      }
    return removed;
  }
  toggle(id, checked) {
    const revision = this.items.get(id);
    if (checked && Number.isSafeInteger(revision) && revision > 0)
      this.selected.set(id, revision);
    else this.selected.delete(id);
  }
  selectAll(checked) {
    this.clear();
    if (checked) for (const id of this.items.keys()) this.toggle(id, true);
  }
  clear() {
    this.selected.clear();
  }
  entries() {
    return [...this.selected].map(([id, revision]) => ({ id, revision }));
  }
}
