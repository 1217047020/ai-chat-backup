# Findings

Project was empty at initial inspection; the scaffold agent is creating shared contracts concurrently.

- Local ChatGPT Degrade Checker 2.4.7 uses `/api/auth/session?unstable_client=true`, `GET /backend-api/conversations` with `offset/limit/order=updated` plus `is_archived=true`, `GET /backend-api/conversation/:id`, project sidebar `/backend-api/gizmos/snorlax/sidebar`, and project conversation cursor endpoint `/backend-api/gizmos/:id/conversations`.
- ChatGPT workspace routing is conveyed by `ChatGPT-Account-Id`; the local exporter also supplies `Authorization` and `oai-device-id` from page context.
- Local Claude Exporter 1.10.17 uses cookie-authenticated `GET /api/organizations`, `/api/organizations/:org/chat_conversations`, `/chat_conversations/:id?tree=True&rendering_mode=messages&render_all_tools=true`, and `/projects`.
- Claude's active branch is reconstructed from `current_leaf_message_uuid` via `parent_message_uuid`. Artifacts occur in allowlisted `tool_use` blocks (`artifacts`, `create_file`) with `code_block`/`json_block`, and legacy `<antArtifact>` tags. Attachments expose `file_name`, `file_size`, `file_type`, and optional extracted content.
- Shared `Scope.scopeKey` is provider-local (the fixture uses `personal`), so adapters keep bare scope IDs and add the platform exactly once to conversation keys.
- The service worker cannot use provider page cookies/tokens; `ContentProviderAdapter`/`RuntimeProviderAdapter` route fixed provider operations to an open matching tab. Realtime snapshots arrive through `conversation_captured` runtime messages.
- The Drive layer now imports adapter Markdown/artifact serializers; attachments should remain metadata-only JSON.
