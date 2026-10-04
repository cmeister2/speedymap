/** A binary min-heap with typed storage, so nationwide searches avoid per-node objects. */
export class MinHeap {
  constructor(capacity = 4096) {
    this.ids = new Uint32Array(capacity);
    this.priorities = new Float64Array(capacity);
    this.costs = new Float64Array(capacity);
    this.size = 0;
  }

  clear() { this.size = 0; }

  push(id, priority, cost) {
    if (this.size === this.ids.length) {
      const capacity = Math.max(16, this.size * 2);
      const ids = new Uint32Array(capacity);
      const priorities = new Float64Array(capacity);
      const costs = new Float64Array(capacity);
      ids.set(this.ids); priorities.set(this.priorities); costs.set(this.costs);
      this.ids = ids; this.priorities = priorities; this.costs = costs;
    }
    let index = this.size++;
    while (index > 0) {
      const parent = (index - 1) >>> 1;
      if (this.priorities[parent] <= priority) break;
      this.ids[index] = this.ids[parent];
      this.priorities[index] = this.priorities[parent];
      this.costs[index] = this.costs[parent];
      index = parent;
    }
    this.ids[index] = id;
    this.priorities[index] = priority;
    this.costs[index] = cost;
  }

  pop() {
    if (this.size === 0) return null;
    const result = { id: this.ids[0], priority: this.priorities[0], cost: this.costs[0] };
    const last = --this.size;
    if (last === 0) return result;
    const id = this.ids[last];
    const priority = this.priorities[last];
    const cost = this.costs[last];
    let index = 0;
    while (true) {
      let child = index * 2 + 1;
      if (child >= this.size) break;
      if (child + 1 < this.size && this.priorities[child + 1] < this.priorities[child]) child++;
      if (this.priorities[child] >= priority) break;
      this.ids[index] = this.ids[child];
      this.priorities[index] = this.priorities[child];
      this.costs[index] = this.costs[child];
      index = child;
    }
    this.ids[index] = id;
    this.priorities[index] = priority;
    this.costs[index] = cost;
    return result;
  }
}
