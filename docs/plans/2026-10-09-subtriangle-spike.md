# Phase 5 spike: sub-triangle precision (2026-10-09)

The spec (section 6, phase 5) asked for a time-boxed spike on option 2's split geometry
before choosing between option 2 (`TreePaintField`: TriangleSelector trees per triangle)
and option 3 (`SplitMeshPaintField`: cut real triangles). Code: `spike/subtri/` (dev-only,
not built, not deployed). The checks are opt-in and read real files in place by path.

## Result

**Option 2 works.** The split geometry is known and verified against PrusaSlicer itself.
A prototype brush writes trees that PrusaSlicer prints exactly where they were painted, and
the viewer can draw trees exactly at no measurable frame cost by walking them in the
fragment shader. Recommendation: build option 2. Option 3 has no advantage left: it changes
the mesh, loses export byte-parity, makes files much larger, and needs topology, BVH and
undo snapshots rebuilt on every stroke.

## 1. Split geometry

Recorded in `docs/FORMAT.md` section 2a. In short: rotate the corners so the special side
comes first, cut 1, 2 or 3 sides at their midpoints in a fixed child layout, and **read the
children from the string in reverse**. The rule came from a prose description of
PrusaSlicer 2.9's `TriangleSelector.cpp` (no code copied). Each uncertain choice (child
order, rotation, the 1- and 2-side rules separately) was a parameter, and these checks
picked the answer:

**Edge consistency on real files** (`edgeCheck.spike.ts`). Along every edge shared by two
triangles where at least one is split, 16 points are sampled from both sides. Only samples
on edges where the paint changes along the edge are counted.

| file | dialect | tris | split | leaves | max depth | PrusaSlicer rule | best other |
|---|---|---|---|---|---|---|---|
| charizar.3mf | bbs | 1.92M | 26,107 | 80,549 | 2 | **99.8%** | 65.4% |
| Pikachu+AMS.3mf | bbs | 283k | 121 | 4,618 | 6 | **98.0%** | 58.3% |
| charizard_flat_bottom_INDX_5T.3mf | prusa | 1.87M | 2,207 | 732,972 | 12 | **95.5%** | 58.1% |
| goldfish_colormix_4t.3mf | prusa | 2.65M | 77,300 | 2,423,572 | 8 | **93.6%** | 58.1% |
| benchy_4t.3mf | prusa | 225k | 203 | 2,039 | 8 | **81.4%** | 55.2% |

The two sides never agree perfectly, because a slicer subdivides each triangle on its own,
to its own depth. Benchy is lowest. Its few trees are mostly 2-side splits, so the 1- and
2-side rules were also varied on their own: every other variant scored lower on both
benchy and Pikachu.

**PrusaSlicer ground truth** (`prusaSlice.spike.ts`). The installed PrusaSlicer 2.9.6 CLI
slices a 2 mm slab whose top face carries a tree with all three split kinds and asymmetric
states. Each top-layer infill line is checked at 3 points against the leaf the rule puts
there: **100% of 1071 samples** match. The other child orders and rotations score 32–72%.

## 2. Painting: a sub-triangle brush (`brush.ts`, `brush.spike.ts`)

`paintSphereTree` grows a triangle's tree for a sphere dab:
- Leaves fully inside the sphere take the state.
- Leaves the sphere's surface crosses are cut on all three sides until their longest side
  is at most an edge limit. They then take the state if their centroid is inside.
- Children that end up equal merge back into one leaf.

The prototype only writes 3-side splits. That's valid, and both slicers' own files mix all
three kinds.

- **End to end:** a 20-dab stroke (radius 5 mm, limit 0.5 mm) produces 826 leaves and a
  1101-character string. Our codec reads it back unchanged. PrusaSlicer prints it where it
  was painted: **100% of 2348 samples**, including every sample within the edge limit of
  the stroke's border.
- **Cost:** 100 dabs (radius 3 mm) across one 100 mm triangle, in Node:

  | edge limit | per dab | leaves | string |
  |---|---|---|---|
  | 1 mm | 0.19 ms | 1,582 | 2.1k chars |
  | 0.5 mm | 0.29 ms | 3,181 | 4.2k chars |
  | 0.25 mm | 0.59 ms | 6,400 | 8.5k chars |
  | 0.1 mm | 0.95 ms | 13,147 | 17.5k chars |

  Parsing the 17.5k-character tree back takes 1.1 ms.
- **Erasing** the same stroke with a slightly larger eraser merges the tree back to a
  single leaf.

## 3. Drawing (`flatten.ts`, `view.ts`, `index.html`)

Three ways were compared on goldfish (2.65M triangles, 2.42M leaves), in Chrome on an
RTX 3070, at 1037×1274:

| | extra memory | build | frame (median) |
|---|---|---|---|
| dominant leaf (today) | none | — | 2.2–5.0 ms |
| **shader tree walk** | **12.9 MB** node texture (3.2M nodes) | 0.54 s flatten in Node; 0.94 s in the browser including geometry | 2.5–5.0 ms |
| leaf mesh | 240 MB (5.0M triangles) | 2.0 s | 3.8–5.0 ms |

How the shader tree walk works:
- Triangles keep their 3 vertices. A per-vertex tag holds either the state or a root index
  into an `R32UI` texture of nodes. A split node is stored as one 32-bit word (flag, sides,
  special side, first child), with its children next to each other.
- The fragment shader gets its barycentric point from `gl_VertexID % 3` and walks at most
  24 levels.

Results:
- **Pixel check:** close-ups on the most-split triangles, 4 camera poses. The tree walk
  differs from the leaf mesh on 0.002–0.74% of pixels, which is edge antialiasing. The
  dominant view differs on 1.0–6.5%.
- **Speed:** frame times are the same in all three modes, also in those close-ups.
- **CPU check:** the CPU copy of the walk agrees with the tree code on 144,560 random
  points across three files.

Risk: the cost of the walk grows with pixels on split triangles times depth. That's free on
this GPU but unmeasured on integrated graphics.

## 4. What the real build needs to decide (questions for the plan)

1. **Resolution:** a fixed edge limit in mm, one relative to the brush radius, or one in
   screen pixels? It sets leaf count and file size (see the cost table).
2. **Which tools paint below triangle resolution:** brush and eraser only, with fills,
   Replace color, guided fill and AI Paint staying per triangle (as today)? AI Paint's mask
   edge could later cut triangles too (`docs/plans/2026-10-09-ai-paint.md`, "Later").
3. **Fills meeting split triangles:** fills flood by triangle and stop at other colors. A
   triangle that is part one color and part another needs a rule: it blocks the flood, or
   joins it by its dominant leaf, or the fill repaints only the matching leaves.
4. **Hover and the eyedropper** read a triangle's state today. With trees they should read
   the leaf under the cursor (the CPU walk above does this).
5. **Undo:** per-dab records with the trees before and after (the `EditRecord` is already
   opaque, and `preserved` already stores trees as strings).
6. **Export:** trees already pass through verbatim (as `preserved` today), so no change
   beyond the dialect conversion that already exists. The sidecar version may need a bump
   if it stores trees.

Not covered: a Bambu Studio or Orca slice of our own trees (only the edge test on their
files), integrated-GPU frame times, and a full brush on a real mesh in the app.
