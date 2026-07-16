# Adapter implementation plan

## Goal
Implement ChatGPT and Claude provider adapters, normalization/Markdown/artifact handling, and a safe page-to-extension collection bridge without touching sync, Drive, or UI code.

## Phases
- [complete] Inspect local extension sources and shared project contracts.
- [complete] Implement shared adapter utilities and ChatGPT adapter.
- [complete] Implement Claude adapter and attribution.
- [complete] Implement content collection bridge and provider observers.
- [complete] Add focused tests and run type/test checks.

## Constraints
- Preserve authentication in page context; never persist or log tokens/cookies.
- Read-only provider requests only.
- No changes to package/config, sync/Drive, or popup UI.

## Errors
- None.
