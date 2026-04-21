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
  const coneStrength = opts.cardinalBiasStrength ?? 0.8;
  const coneAngle = opts.coneAngleRad ?? Math.PI / 4;
  const pinPull = opts.pinPullStrength ?? 1.5;
  const edgeLen = opts.edgeBaseLength ?? 140;
  const charge = opts.chargeStrength ?? 7000;
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

    // 1) Charge repulsion (only between physics nodes).
    for (let a = 0; a < physicsIdx.length; a++) {
      for (let b = a + 1; b < physicsIdx.length; b++) {
        const i = physicsIdx[a], j = physicsIdx[b];
        const dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) d2 = 1;
        const inv = charge / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * inv, fy = (dy / d) * inv;
        force[i].x -= fx; force[i].y -= fy;
        force[j].x += fx; force[j].y += fy;
      }
    }

    // 2) Edge spring + cone bias.
    for (const e of edgeList) {
      const i = idx.get(e.from)!, j = idx.get(e.to)!;
      if (classes[i] === "action" || classes[j] === "action") continue;
      const dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const v = directionToVector(e.direction);
      const rest = v ? edgeLen : edgeLen * 1.5;
      // Spring toward rest length.
      const springK = 0.05;
      const springF = (d - rest) * springK;
      const ux = dx / d, uy = dy / d;
      force[i].x += ux * springF; force[i].y += uy * springF;
      force[j].x -= ux * springF; force[j].y -= uy * springF;

      // Cone bias — rotate current edge toward v if outside cone.
      if (v) {
        const cos = ux * v.dx + uy * v.dy;
        const clamped = Math.max(-1, Math.min(1, cos));
        const ang = Math.acos(clamped);
        if (ang > coneAngle) {
          const excess = ang - coneAngle;
          // Perpendicular direction to rotate into the cone.
          // Sign of the perpendicular is the sign of cross(u, v).
          const cross = ux * v.dy - uy * v.dx;
          const sign = cross > 0 ? 1 : -1;
          // Perpendicular to u, pointing toward v side.
          const px = -uy * sign, py = ux * sign;
          const mag = coneStrength * Math.sin(excess) * d * 0.15;
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

// --- Seed helper -----------------------------------------------------
// Caller passes branch_id (or any string) and we hash → numeric seed.
export function seedFromKey(key: string): number {
  return hashString(key);
}
