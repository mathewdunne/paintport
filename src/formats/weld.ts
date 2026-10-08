// Vertex welding for STL/OBJ import: vertices with exactly equal coordinates become one
// vertex, so the mesh is indexed and connected (shell fill and smart fill need that).

/** Growable Int32 list (triangle index buffers with an unknown final size). */
export class IntList {
  private data: Int32Array;
  length = 0;
  constructor(capacity = 1024) {
    this.data = new Int32Array(Math.max(16, capacity));
  }
  push(v: number): void {
    if (this.length === this.data.length) {
      const next = new Int32Array(this.data.length * 2);
      next.set(this.data);
      this.data = next;
    }
    this.data[this.length++] = v;
  }
  toArray(): Int32Array {
    return this.data.slice(0, this.length);
  }
}

export class VertexWelder {
  private pos: Float64Array;
  private table: Int32Array; // vertex index, -1 = empty slot
  private mask: number;
  private readonly f64 = new Float64Array(3);
  private readonly bits = new Uint32Array(this.f64.buffer);
  /** Number of distinct vertices so far. */
  count = 0;

  /** `expected`: a guess of the number of distinct vertices (only a sizing hint). */
  constructor(expected = 1024) {
    let size = 16;
    while (size < expected * 2) size *= 2;
    this.table = new Int32Array(size).fill(-1);
    this.mask = size - 1;
    this.pos = new Float64Array(Math.max(16, expected) * 3);
  }

  /** Index of the vertex at (x, y, z), adding it if it is new. Coordinates must be finite. */
  add(x: number, y: number, z: number): number {
    const f = this.f64;
    // +0 turns -0 into 0, so the two hash alike; they already compare equal.
    f[0] = x + 0; f[1] = y + 0; f[2] = z + 0;
    let slot = this.hash();
    const pos = this.pos;
    for (;;) {
      const v = this.table[slot];
      if (v < 0) break;
      if (pos[v * 3] === x && pos[v * 3 + 1] === y && pos[v * 3 + 2] === z) return v;
      slot = (slot + 1) & this.mask;
    }
    const index = this.count++;
    if (index * 3 + 3 > pos.length) {
      const grown = new Float64Array(pos.length * 2);
      grown.set(pos);
      this.pos = grown;
    }
    this.pos[index * 3] = x; this.pos[index * 3 + 1] = y; this.pos[index * 3 + 2] = z;
    this.table[slot] = index;
    if (this.count * 2 > this.table.length) this.rehash();
    return index;
  }

  /** The welded vertices as x,y,z triples. */
  vertices(): Float64Array {
    return this.pos.slice(0, this.count * 3);
  }

  private hash(): number {
    const b = this.bits;
    let h = 0x811c9dc5;
    for (let k = 0; k < 6; k++) h = Math.imul(h ^ b[k], 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    return h & this.mask;
  }

  private rehash(): void {
    const size = this.table.length * 2;
    this.table = new Int32Array(size).fill(-1);
    this.mask = size - 1;
    const f = this.f64;
    for (let v = 0; v < this.count; v++) {
      f[0] = this.pos[v * 3] + 0; f[1] = this.pos[v * 3 + 1] + 0; f[2] = this.pos[v * 3 + 2] + 0;
      let slot = this.hash();
      while (this.table[slot] >= 0) slot = (slot + 1) & this.mask;
      this.table[slot] = v;
    }
  }
}
