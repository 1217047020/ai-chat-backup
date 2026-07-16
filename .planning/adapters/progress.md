# Progress

- Started isolated adapter subtask and coordinated expected shared types with the scaffold agent.
- Located and inspected local, installed source behavior for ChatGPT Degrade Checker 2.4.7 and Claude Exporter 1.10.17.
- Aligned implementation with `src/shared/types.ts`; adapter output will use the shared canonical schema.
- Added ChatGPT and Claude adapters with endpoint-compatible read-only pagination/detail calls, branch-aware normalization, raw sanitization, and artifact/attachment extraction.
- Added deterministic Markdown/artifact serializers and a focused adapter fixture test suite.
- Added fixed-operation MAIN-world page bridge plus isolated collector runtime handlers; no arbitrary URL/header operation is exposed.
- Adapter-only TypeScript compilation passes; repository-wide compile is temporarily blocked by concurrent sync/coordinator type drift. WXT build is blocked by the existing Vite/plugin-react package export mismatch.
- Verified provider-local scope keys (`personal`, organization/workspace ID) and fixed conversation identity generation to avoid duplicated platform prefixes.
- Added sanitized golden fixtures for ChatGPT mapping branches and Claude Artifact/attachment behavior; `npm run compile` and `npm test` pass.
