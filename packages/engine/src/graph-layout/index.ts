// Graph-map layout — pure (no Convex, no DOM). Spec/26 Layer 1.
//
// Three things live here:
//   1. Node classification (spatial vs action vs floating).
//   2. Cardinal-label → unit-vector lookup.
//   3. A seeded force simulation that respects authored direction labels
//      (cone bias), pinned positions (soft attractors), and subgraph
//      clustering.
//
// Exports are consumed by convex/graph.ts (server) and
// apps/play/src/lib/map-graph/ (client). Both call the same layout code
// so client renders and server test fixtures stay in sync.

export type NodeClass = "spatial" | "action" | "floating";

export type GraphNode = {
  slug: string;
  biome: string | null;
  subgraph: string | null;
  map_shape?: NodeClass;
  draft: boolean;
  tags: string[];
  neighbors: Record<string, string>;
  pin?: { x: number; y: number };
};

export type GraphEdge = {
  from: string;
  to: string;
  direction: string;
  traffic: number;
};

export type LayoutOptions = {
  width: number;
  height: number;
  iterations?: number;
  intraSubgraphAttraction?: number;
  interSubgraphAttraction?: number;
  cardinalBiasStrength?: number;
  coneAngleRad?: number;
  pinPullStrength?: number;
  edgeBaseLength?: number;
  chargeStrength?: number;
  seed?: number;
  /** Minimum pairwise distance; nodes closer than this receive a
   *  Hooke-style hard repulsion, not just inverse-square charge.
   *  Prevents the local minima where two nodes end up at d=0. */
  minPairDistance?: number;
};

export type LayoutResult = Map<string, { x: number; y: number; class: NodeClass }>;

// --- Canonical label sets --------------------------------------------

export const CARDINAL_LABELS: Set<string> = new Set([
  "n", "s", "e", "w",
  "north", "south", "east", "west",
  "ne", "nw", "se", "sw",
  "northeast", "northwest", "southeast", "southwest",
  "up", "down",
  "in", "out",
]);

export const VERB_LABELS: Set<string> = new Set([
  "read", "talk", "use", "examine", "search", "pick", "study",
  "sit", "listen", "watch", "smell", "taste", "touch",
  "drink", "eat", "open", "close", "wait",
]);

// --- classifyNode ----------------------------------------------------

export function classifyNode(node: GraphNode): NodeClass {
  // Rule 1: explicit override.
  if (node.map_shape) return node.map_shape;

  const labels = Object.keys(node.neighbors ?? {});
  const lower = labels.map((l) => l.toLowerCase());

  // Rule 2: draft dead-end (exactly one neighbor) → action chip. Drafts
  // generated for a specific verb option (`read the book`) typically
  // have only the `back` link; treat them as action chips that orbit
  // their parent rather than spatial nodes that need layout room.
  if (node.draft && lower.length === 1) return "action";

  // Rule 3: every neighbor label is a verb.
  if (lower.length > 0 && lower.every((l) => VERB_LABELS.has(l))) {
    return "action";
  }

  // Rule 4: any cardinal label OR ≥2 neighbors → spatial.
  const anyCardinal = lower.some((l) => CARDINAL_LABELS.has(l));
  if (anyCardinal || lower.length >= 2) return "spatial";

  // Rule 5: fallback.
  return "floating";
}

// --- directionToVector -----------------------------------------------

const DIAG = Math.SQRT1_2;  // 1/√2
const VECTORS: Record<string, { dx: number; dy: number }> = {
  n: { dx: 0, dy: -1 },          north: { dx: 0, dy: -1 },
  s: { dx: 0, dy: 1 },           south: { dx: 0, dy: 1 },
  e: { dx: 1, dy: 0 },           east:  { dx: 1, dy: 0 },
  w: { dx: -1, dy: 0 },          west:  { dx: -1, dy: 0 },
  ne: { dx: DIAG, dy: -DIAG },   northeast: { dx: DIAG, dy: -DIAG },
  nw: { dx: -DIAG, dy: -DIAG },  northwest: { dx: -DIAG, dy: -DIAG },
  se: { dx: DIAG, dy: DIAG },    southeast: { dx: DIAG, dy: DIAG },
  sw: { dx: -DIAG, dy: DIAG },   southwest: { dx: -DIAG, dy: DIAG },
  up: { dx: 0, dy: -1 },         down: { dx: 0, dy: 1 },
  in: { dx: 0, dy: 1 },          out: { dx: 0, dy: -1 },
};

export function directionToVector(label: string): { dx: number; dy: number } | null {
  if (!label) return null;
  const k = label.toLowerCase();
  return VECTORS[k] ?? null;
}

// --- Deterministic PRNG + helpers -----------------------------------

function mulberry32(seed: number) {
  let s = seed >>> 0;
  return function (): number {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// --- Force simulation ------------------------------------------------

type Vec = { x: number; y: number };

export function layoutSubgraph(
  rawNodes: GraphNode[],
  rawEdges: GraphEdge[],
  opts: LayoutOptions,
): LayoutResult {
  const result: LayoutResult = new Map();
  if (rawNodes.length === 0) return result;

  const iterations = opts.iterations ?? 120;
  const intraA = opts.intraSubgraphAttraction ?? 0.5;
  const interA = opts.interSubgraphAttraction ?? 0.08;
  const coneStrength = opts.cardinalBiasStrength ?? 2.5;
  const coneAngle = opts.coneAngleRad ?? Math.PI / 4;
  const pinPull = opts.pinPullStrength ?? 1.5;
  const edgeLen = opts.edgeBaseLength ?? 140;
  const charge = opts.chargeStrength ?? 7000;
  const minPair = opts.minPairDistance ?? 70;
  const rand = mulberry32(opts.seed ?? 0x9e3779b9);
  const cx = opts.width / 2;
  const cy = opts.height / 2;

  // Index node → idx for O(1) lookup.
  const idx = new Map<string, number>();
  rawNodes.forEach((n, i) => idx.set(n.slug, i));
  const classes = rawNodes.map((n) => classifyNode(n));

  // Only `spatial` nodes participate in physics. Action chips are
  // anchored to their parent; floating nodes get placed last in a
  // sidebar column deterministically.
  const physicsIdx: number[] = [];
  rawNodes.forEach((n, i) => {
    if (classes[i] === "spatial" || classes[i] === "floating") physicsIdx.push(i);
  });

  // --- Initial positions: BFS seed from highest-degree node -----
  const pos: Vec[] = rawNodes.map(() => ({ x: cx, y: cy }));
  const placed = new Set<number>();

  // Degree ordering for start.
  const degree = rawNodes.map((n) => Object.keys(n.neighbors ?? {}).length);
  let start = -1;
  for (const i of physicsIdx) {
    if (start < 0 || degree[i] > degree[start]) start = i;
  }
  if (start < 0) start = 0;

  pos[start] = { x: cx, y: cy };
  placed.add(start);
  const queue: number[] = [start];
  while (queue.length > 0) {
    const ci = queue.shift()!;
    const n = rawNodes[ci];
    for (const [label, neighborSlug] of Object.entries(n.neighbors ?? {})) {
      const ni = idx.get(neighborSlug);
      if (ni == null || placed.has(ni)) continue;
      // Action nodes orbit their parent — skip BFS placement.
      if (classes[ni] === "action") {
        placed.add(ni);
        continue;
      }
      const v = directionToVector(label);
      if (v) {
        pos[ni] = {
          x: pos[ci].x + v.dx * edgeLen,
          y: pos[ci].y + v.dy * edgeLen,
        };
      } else {
        // Unknown direction — random jitter around parent.
        const theta = rand() * Math.PI * 2;
        pos[ni] = {
          x: pos[ci].x + Math.cos(theta) * edgeLen,
          y: pos[ci].y + Math.sin(theta) * edgeLen,
        };
      }
      placed.add(ni);
      queue.push(ni);
    }
  }
  // Any unreachable node (no edge into the component) — place
  // randomly near the center.
  rawNodes.forEach((_, i) => {
    if (placed.has(i)) return;
    pos[i] = {
      x: cx + (rand() - 0.5) * opts.width * 0.6,
      y: cy + (rand() - 0.5) * opts.height * 0.6,
    };
  });
  // Apply pins as authoritative initial positions.
  rawNodes.forEach((n, i) => {
    if (n.pin) pos[i] = { x: n.pin.x, y: n.pin.y };
  });

  // Pre-compute subgraph centroids target (they accumulate during sim).
  const subgraphKeys: Record<string, number[]> = {};
  rawNodes.forEach((n, i) => {
    if (classes[i] === "action") return;
    const key = n.subgraph ?? n.biome ?? "__none";
    (subgraphKeys[key] ??= []).push(i);
  });

  // --- Force sim -------------------------------------------------
  const vel: Vec[] = rawNodes.map(() => ({ x: 0, y: 0 }));
  // Build edge lookup from -> to keyed edges so we can track cone bias.
  const edgeList = rawEdges.filter((e) => idx.has(e.from) && idx.has(e.to));

  // Bidirectional cardinal conflict resolution (spec 26 §Feasibility
  // "45° cone preservation test"). When A has cardinal "north:B" AND B
  // also has a cardinal pointing at A, both cones would fire at once
  // and cancel each other. For each unordered pair we pick ONE cardinal
  // edge to own the cone: if only one side has a cardinal, that one
  // wins by default; if both do, the lower-slug source wins.
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const cardinalEdgesByPair = new Map<string, GraphEdge[]>();
  for (const e of edgeList) {
    if (!directionToVector(e.direction)) continue;
    const k = pairKey(e.from, e.to);
    const arr = cardinalEdgesByPair.get(k);
    if (arr) arr.push(e);
    else cardinalEdgesByPair.set(k, [e]);
  }
  const coneEdge = new WeakSet<GraphEdge>();
  for (const arr of cardinalEdgesByPair.values()) {
    // Prefer the edge whose source is lexicographically first; guarantees
    // deterministic winner regardless of edge insertion order.
    arr.sort((p, q) => (p.from < q.from ? -1 : p.from > q.from ? 1 : 0));
    coneEdge.add(arr[0]);
  }

  for (let iter = 0; iter < iterations; iter++) {
    const force: Vec[] = rawNodes.map(() => ({ x: 0, y: 0 }));

    // Centroid per subgraph (only physics nodes).
    const centroid: Record<string, Vec> = {};
    for (const [k, ii] of Object.entries(subgraphKeys)) {
      let sx = 0, sy = 0, n = 0;
      for (const i of ii) {
        if (classes[i] === "action") continue;
        sx += pos[i].x; sy += pos[i].y; n++;
      }
      if (n > 0) centroid[k] = { x: sx / n, y: sy / n };
    }

    // 1) Charge repulsion (only between physics nodes). Inverse-square
    //    at long range; Hooke-style hard repulsion inside minPair so
    //    adversarial co-location (same pin, random init at center, etc)
    //    can't settle at d=0 in a local minimum. Also perturb along a
    //    deterministic axis when d=0 exactly, so the force has a direction.
    for (let a = 0; a < physicsIdx.length; a++) {
      for (let b = a + 1; b < physicsIdx.length; b++) {
        const i = physicsIdx[a], j = physicsIdx[b];
        let dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y;
        let d = Math.hypot(dx, dy);
        if (d < 0.001) {
          // Perfect overlap — nudge along a stable axis so repulsion
          // has a direction. Sign derives from node ordering.
          const nudgeAng = (hashString(rawNodes[i].slug + rawNodes[j].slug) % 360) * (Math.PI / 180);
          dx = Math.cos(nudgeAng) * 0.5;
          dy = Math.sin(nudgeAng) * 0.5;
          d = 0.5;
        }
        let fx: number, fy: number;
        if (d < minPair) {
          // Hard Hooke spring pushing out to minPair — stiffness high
          // enough to dominate other forces even in a single iteration.
          const k = 0.6;
          const excess = minPair - d;
          const push = k * excess;
          fx = (dx / d) * push;
          fy = (dy / d) * push;
        } else {
          const inv = charge / (d * d);
          fx = (dx / d) * inv;
          fy = (dy / d) * inv;
        }
        force[i].x -= fx; force[i].y -= fy;
        force[j].x += fx; force[j].y += fy;
      }
    }

    // 2) Edge spring + cone bias. Two changes from the naive version:
    //    a) Only the conflict-resolution winner fires cone bias (see
    //       conePair setup above). The loser's edge still springs.
    //    b) When outside the cone, the bias force is proportional to
    //       the angular excess (no sin-softening, no 0.15 dampener).
    //       That's strong enough to dominate the spring+charge tension
    //       that produced the 137°-off drift in the real-world audit.
    for (const e of edgeList) {
      const i = idx.get(e.from)!, j = idx.get(e.to)!;
      if (classes[i] === "action" || classes[j] === "action") continue;
      const dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const v = directionToVector(e.direction);
      const isConeOwner = v !== null && coneEdge.has(e);
      const rest = isConeOwner ? edgeLen : edgeLen * 1.5;
      // Spring toward rest length.
      const springK = 0.05;
      const springF = (d - rest) * springK;
      const ux = dx / d, uy = dy / d;
      force[i].x += ux * springF; force[i].y += uy * springF;
      force[j].x -= ux * springF; force[j].y -= uy * springF;

      // Cone bias. Two regimes:
      //   - Outside the cone: strong corrective proportional to angular
      //     excess, scaled by edge length (to produce roughly constant
      //     angular acceleration regardless of edge length).
      //   - Inside the cone: a gentle restorative toward the exact
      //     target direction, ~10% as strong. Without this, the edge
      //     can stall at cone-boundary + tiny-epsilon because the
      //     outside-cone force approaches 0 at the boundary.
      if (isConeOwner && v) {
        const cos = ux * v.dx + uy * v.dy;
        const clamped = Math.max(-1, Math.min(1, cos));
        const ang = Math.acos(clamped);
        const cross = ux * v.dy - uy * v.dx;
        const sign = cross > 0 ? 1 : -1;
        const px = -uy * sign, py = ux * sign;
        let mag: number;
        if (ang > coneAngle) {
          mag = coneStrength * (ang - coneAngle + 0.1) * d * 0.12;
        } else if (ang > 0.01) {
          // Soft in-cone restorative. Strength scales with ang so at
          // θ=0 there's no force (node is exactly on target); at the
          // boundary it matches the outside force's baseline for
          // continuity.
          mag = coneStrength * ang * d * 0.012;
        } else {
          mag = 0;
        }
        if (mag !== 0) {
          force[i].x -= px * mag; force[i].y -= py * mag;
          force[j].x += px * mag; force[j].y += py * mag;
        }
      }
    }

    // 3) Subgraph centroid attraction.
    for (const [k, ii] of Object.entries(subgraphKeys)) {
      const c = centroid[k];
      if (!c) continue;
      for (const i of ii) {
        if (classes[i] === "action") continue;
        const dx = c.x - pos[i].x, dy = c.y - pos[i].y;
        force[i].x += dx * intraA * 0.01;
        force[i].y += dy * intraA * 0.01;
      }
    }
    // Inter-subgraph pull toward global center so disjoint subgraphs
    // don't fly off to infinity.
    for (const i of physicsIdx) {
      const dx = cx - pos[i].x, dy = cy - pos[i].y;
      force[i].x += dx * interA * 0.005;
      force[i].y += dy * interA * 0.005;
    }

    // 4) Pin attractors.
    rawNodes.forEach((n, i) => {
      if (!n.pin) return;
      const dx = n.pin.x - pos[i].x, dy = n.pin.y - pos[i].y;
      force[i].x += dx * pinPull * 0.05;
      force[i].y += dy * pinPull * 0.05;
    });

    // 5) Integrate with damping.
    for (const i of physicsIdx) {
      vel[i].x = (vel[i].x + force[i].x) * 0.85;
      vel[i].y = (vel[i].y + force[i].y) * 0.85;
      // Cap velocity to keep sim bounded.
      const vmag = Math.hypot(vel[i].x, vel[i].y);
      const vcap = 40;
      if (vmag > vcap) {
        vel[i].x = (vel[i].x / vmag) * vcap;
        vel[i].y = (vel[i].y / vmag) * vcap;
      }
      pos[i].x += vel[i].x;
      pos[i].y += vel[i].y;
    }
  }

  // --- Anchor action chips to parent positions -------------------
  rawNodes.forEach((n, i) => {
    if (classes[i] !== "action") return;
    // Find parent = first neighbor whose slug resolves.
    const parentSlug = Object.values(n.neighbors ?? {})[0];
    const pi = parentSlug ? idx.get(parentSlug) : undefined;
    if (pi == null) {
      pos[i] = { x: cx, y: cy };
      return;
    }
    // Orbit around parent at ~60° offset (deterministic from slug).
    const seedAng = (hashString(n.slug) % 360) * (Math.PI / 180);
    pos[i] = {
      x: pos[pi].x + Math.cos(seedAng) * 60,
      y: pos[pi].y + Math.sin(seedAng) * 60,
    };
  });

  rawNodes.forEach((n, i) => {
    result.set(n.slug, { x: pos[i].x, y: pos[i].y, class: classes[i] });
  });
  return result;
}

// --- Alternate layouts ----------------------------------------------
// Two modes that sidestep cardinal-cone bias entirely — useful for
// worlds whose authored graph is sparse on cardinals (Quiet Vale uses
// option.target labels) or has contradictory cardinals (The Office).
//
// Both take the same signature as layoutSubgraph and return the same
// LayoutResult shape.

export type LayoutMode = "force" | "radial-tree" | "biome-cluster";

/** BFS out from the highest-degree spatial node. Concentric rings;
 *  children distributed across each ring's angular slice. Disconnected
 *  components get their own tree, tiled horizontally.
 *
 *  Good for: sparse graphs, trees, worlds where hierarchy > cardinals. */
export function layoutRadialTree(
  rawNodes: GraphNode[],
  rawEdges: GraphEdge[],
  opts: LayoutOptions,
): LayoutResult {
  const result: LayoutResult = new Map();
  if (rawNodes.length === 0) return result;

  const classes = rawNodes.map((n) => classifyNode(n));
  const idx = new Map<string, number>();
  rawNodes.forEach((n, i) => idx.set(n.slug, i));

  // Undirected adjacency — respect only non-action nodes in the tree.
  const adj: Record<number, number[]> = {};
  for (const e of rawEdges) {
    const i = idx.get(e.from), j = idx.get(e.to);
    if (i == null || j == null) continue;
    if (classes[i] === "action" || classes[j] === "action") continue;
    (adj[i] ??= []).push(j);
    (adj[j] ??= []).push(i);
  }

  const treeIdx = rawNodes
    .map((_, i) => i)
    .filter((i) => classes[i] !== "action");

  const visited = new Set<number>();
  const components: Array<Array<{ node: number; depth: number; parent: number | null }>> = [];

  while (visited.size < treeIdx.length) {
    // Pick the highest-degree unvisited node.
    let root = -1, rootDeg = -1;
    for (const i of treeIdx) {
      if (visited.has(i)) continue;
      const d = adj[i]?.length ?? 0;
      if (d > rootDeg || (d === rootDeg && rawNodes[i].slug < rawNodes[root]?.slug)) {
        root = i; rootDeg = d;
      }
    }
    if (root < 0) break;
    const comp: Array<{ node: number; depth: number; parent: number | null }> = [];
    const queue: Array<{ node: number; depth: number; parent: number | null }> = [
      { node: root, depth: 0, parent: null },
    ];
    visited.add(root);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      comp.push(cur);
      for (const n of adj[cur.node] ?? []) {
        if (visited.has(n)) continue;
        visited.add(n);
        queue.push({ node: n, depth: cur.depth + 1, parent: cur.node });
      }
    }
    components.push(comp);
  }

  // Each component gets its own centre + radius budget. Tile horizontally
  // along a central band.
  const ringStep = 120;
  const componentWidths = components.map((c) => {
    const maxDepth = c.reduce((m, x) => Math.max(m, x.depth), 0);
    return (maxDepth + 1) * ringStep * 2 + ringStep;
  });
  const totalWidth = componentWidths.reduce((a, b) => a + b, 0);
  const scale = Math.min(1, (opts.width * 0.9) / Math.max(1, totalWidth));
  const bandY = opts.height / 2;
  let cursorX = (opts.width - totalWidth * scale) / 2;

  const pos: Vec[] = rawNodes.map(() => ({ x: opts.width / 2, y: opts.height / 2 }));

  for (const [ci, comp] of components.entries()) {
    const cw = componentWidths[ci] * scale;
    const cx = cursorX + cw / 2;
    const cy = bandY;
    cursorX += cw;

    // Group by depth.
    const byDepth: Record<number, number[]> = {};
    for (const { node, depth } of comp) (byDepth[depth] ??= []).push(node);

    for (const [depthStr, members] of Object.entries(byDepth)) {
      const depth = Number(depthStr);
      if (depth === 0) {
        pos[members[0]] = { x: cx, y: cy };
        continue;
      }
      const r = depth * ringStep * scale;
      const step = (Math.PI * 2) / members.length;
      // Deterministic angle offset per depth so consecutive rings
      // don't land directly above each other (looks cleaner).
      const rootSlug = rawNodes[comp[0].node].slug;
      const base = (hashString(`${rootSlug}:${depth}`) % 360) * (Math.PI / 180);
      members.sort((a, b) => (rawNodes[a].slug < rawNodes[b].slug ? -1 : 1));
      for (let i = 0; i < members.length; i++) {
        const ang = base + i * step;
        pos[members[i]] = {
          x: cx + Math.cos(ang) * r,
          y: cy + Math.sin(ang) * r,
        };
      }
    }
  }

  // Action chips orbit their parent (same as force sim).
  rawNodes.forEach((n, i) => {
    if (classes[i] !== "action") return;
    const parentSlug = Object.values(n.neighbors ?? {})[0];
    const pi = parentSlug ? idx.get(parentSlug) : undefined;
    if (pi == null) return;
    const seedAng = (hashString(n.slug) % 360) * (Math.PI / 180);
    pos[i] = {
      x: pos[pi].x + Math.cos(seedAng) * 60,
      y: pos[pi].y + Math.sin(seedAng) * 60,
    };
  });

  rawNodes.forEach((n, i) => {
    result.set(n.slug, { x: pos[i].x, y: pos[i].y, class: classes[i] });
  });
  return result;
}

/** Group nodes by biome (falling through to subgraph), arrange each
 *  group as a circle, and place the group centres around a larger
 *  outer ring. Edges between groups cross the inner empty space;
 *  edges inside a group are short.
 *
 *  Good for: worlds with strong biome-level separation, where users
 *  want to see "which area is which" before "what connects to what". */
export function layoutBiomeCluster(
  rawNodes: GraphNode[],
  rawEdges: GraphEdge[],
  opts: LayoutOptions,
): LayoutResult {
  // Silence lint — edges aren't needed for this layout; topology
  // implicit via grouping.
  void rawEdges;

  const result: LayoutResult = new Map();
  if (rawNodes.length === 0) return result;
  const classes = rawNodes.map((n) => classifyNode(n));
  const idx = new Map<string, number>();
  rawNodes.forEach((n, i) => idx.set(n.slug, i));

  // Group by biome OR subgraph (biome preferred).
  const groups = new Map<string, number[]>();
  for (let i = 0; i < rawNodes.length; i++) {
    if (classes[i] === "action") continue;
    const n = rawNodes[i];
    const key = n.biome ?? n.subgraph ?? "unassigned";
    const arr = groups.get(key) ?? [];
    arr.push(i);
    groups.set(key, arr);
  }

  // Sort group keys for determinism.
  const keys = [...groups.keys()].sort();
  const outerRadius = Math.min(opts.width, opts.height) * 0.38;
  const cx = opts.width / 2;
  const cy = opts.height / 2;
  const pos: Vec[] = rawNodes.map(() => ({ x: cx, y: cy }));

  // Place group centres around the outer ring.
  for (let g = 0; g < keys.length; g++) {
    const key = keys[g];
    const members = groups.get(key)!;
    // Members sort — stable inner order.
    members.sort((a, b) => (rawNodes[a].slug < rawNodes[b].slug ? -1 : 1));

    const outerAng = (g / Math.max(1, keys.length)) * Math.PI * 2 - Math.PI / 2;
    const gx = cx + Math.cos(outerAng) * outerRadius;
    const gy = cy + Math.sin(outerAng) * outerRadius;

    // Each group's inner radius scales with its size.
    const innerRadius = Math.max(40, Math.sqrt(members.length) * 28);
    if (members.length === 1) {
      pos[members[0]] = { x: gx, y: gy };
      continue;
    }
    const step = (Math.PI * 2) / members.length;
    const base = (hashString(key) % 360) * (Math.PI / 180);
    for (let i = 0; i < members.length; i++) {
      const ang = base + i * step;
      pos[members[i]] = {
        x: gx + Math.cos(ang) * innerRadius,
        y: gy + Math.sin(ang) * innerRadius,
      };
    }
  }

  // Action chips orbit parent.
  rawNodes.forEach((n, i) => {
    if (classes[i] !== "action") return;
    const parentSlug = Object.values(n.neighbors ?? {})[0];
    const pi = parentSlug ? idx.get(parentSlug) : undefined;
    if (pi == null) return;
    const seedAng = (hashString(n.slug) % 360) * (Math.PI / 180);
    pos[i] = {
      x: pos[pi].x + Math.cos(seedAng) * 60,
      y: pos[pi].y + Math.sin(seedAng) * 60,
    };
  });

  rawNodes.forEach((n, i) => {
    result.set(n.slug, { x: pos[i].x, y: pos[i].y, class: classes[i] });
  });
  return result;
}

/** Dispatcher. `mode = "force"` (default) uses the cardinal-bias force
 *  sim; "radial-tree" and "biome-cluster" use the alternate layouts
 *  above. Same signature + return type regardless. */
export function layout(
  rawNodes: GraphNode[],
  rawEdges: GraphEdge[],
  opts: LayoutOptions & { mode?: LayoutMode },
): LayoutResult {
  switch (opts.mode) {
    case "radial-tree":
      return layoutRadialTree(rawNodes, rawEdges, opts);
    case "biome-cluster":
      return layoutBiomeCluster(rawNodes, rawEdges, opts);
    case "force":
    case undefined:
    default:
      return layoutSubgraph(rawNodes, rawEdges, opts);
  }
}

// --- Seed helper -----------------------------------------------------
// Caller passes branch_id (or any string) and we hash → numeric seed.
export function seedFromKey(key: string): number {
  return hashString(key);
}
