---
name: typescript-react
description: Use whenever writing or editing TypeScript/React (.ts, .tsx). Teaches recommended ESLint defaults (typescript-eslint, react, react-hooks, prettier) and the common pitfalls that break them — consistent type imports, no explicit any, no non-null assertions, rules-of-hooks, prefer-nullish-coalescing, display names — plus the checks to run before finishing. a large .NET/TS monorepo is cited only as an optional example of what those defaults catch.
---

# TypeScript + React — recommended lint defaults

Target: any TS/React repo using typescript-eslint + react + react-hooks + prettier (flat config or legacy). Source of truth is the repo's `eslint.config.*` / `.eslintrc*` and `tsconfig` — follow those when they differ. Prefer `strict: true` TypeScript.

## Rules of thumb (the classes that break recommended configs)
- **Type imports (`@typescript-eslint/consistent-type-imports`):** `import type { Plan } from '...'`; mixed: `import { usePlans, type Plan } from '...'`.
- **No `any` (`no-explicit-any`):** use concrete types, `unknown` + narrowing, or a precise union. Don't add `// @ts-ignore` / `@ts-expect-error` (`ban-ts-comment`).
- **No non-null assertions (`no-non-null-assertion`):** guard (`if (!x) return null;`), optional chaining, or a typed default instead of `x!`.
- **Hooks (`react-hooks` recommended):** hooks at top level, never after an early return or inside conditions/loops/callbacks; complete dependency arrays. Move the early `return` below the hooks.
  ```tsx
  // don't: if (!rows) return null; const sorted = useMemo(...)
  const sorted = useMemo(() => sortRows(rows ?? []), [rows]);
  if (!rows) return null;
  ```
- **`??` vs `||` (`prefer-nullish-coalescing`):** use `??` for objects/arrays/nullable refs. For string/number/boolean, `||` is fine when '' / 0 / false should take the fallback (some configs set `ignorePrimitives` for that). Use optional chaining (`prefer-optional-chain`).
- **Components:** named function components (so they get a display name); `memo`/`forwardRef` wrappers and test mocks need `X.displayName = 'X'`. `key` on every list item; avoid `console.log` in committed code.
- **Unused vars:** remove them; prefix intentionally unused args with `_`.
- **Formatting (prettier via ESLint):** follow the repo's Prettier config; let `--fix` do the formatting.
- **Generated code:** never hand-edit generated clients or `*.generated.ts`; regenerate with the repo's generate script.
- **E2E (Playwright):** prefer web-first assertions and role/test-id locators; avoid `waitForTimeout`, `.only`/`.skip`, and conditionals in tests when the repo's playwright plugin enforces those.

*Example (a large React + TS frontend):* consistent-type-imports / prefer-nullish-coalescing / prefer-optional-chain as errors; no-explicit-any and no-non-null-assertion as warns (being cleaned up); MUI `sx` + theme palette; Playwright e2e rules as errors; CI fails if `yarn tsc` error count rises above `tsc-baseline.txt`.

## Before finishing
1. `eslint --max-warnings 0 <changed files>` (or the repo's `yarn lint` / lint-staged). Use `--fix` first for import/prettier issues.
2. `tsc --noEmit` (or the repo's typecheck script). Don't raise the project's known-error baseline.
3. Run the unit/component tests for the touched package or app.
