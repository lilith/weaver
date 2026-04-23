// Module map for convex-test. Globs BOTH the hand-written Convex files
// and the generated `_generated/` stubs — convex-test's module-root
// resolver walks the common path prefix looking for `_generated/`.
//
// WARNING: vitest's vite pipeline evaluates `import.meta.glob` at
// transform time; plain `node` imports of this file will see `modules`
// as an empty object. Only use from vitest-driven tests.
//
// Kept out of `convex/` because Convex's bundler tries to parse every
// .ts in its functions directory and fails on `import.meta.glob`
// (unsupported in the Convex runtime).

export const modules = (import.meta as any).glob(
	"../../convex/**/*.{ts,js}",
);
