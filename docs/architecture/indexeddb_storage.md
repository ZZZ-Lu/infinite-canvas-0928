# IndexedDB workspace persistence

The browser's authoritative user data is in `InfiniteCanvasDB`, schema version 2.

| Store | Contents |
| --- | --- |
| `settings` | Preferences, API configuration caches, camera/playback state, script editor state and the ordered project index |
| `projects` | One script/project metadata record per project ID |
| `manifests` | Current and last nonempty card snapshot for each project |
| `card_records` | Individual card metadata, addressed by project/revision/card ID |
| `assets` | Immutable Blob/File data referenced by card metadata |
| `drafts` | Agent input drafts |
| `mcp_keys` | MCP credentials and active-key configuration |
| `traces` | Bounded agent traces |
| `meta` | Migration markers and settings revision |
| `workspace` | Preserved version 1 records for rollback and lazy card migration |

## Startup and migration

`main.tsx` initializes storage before importing `App`. Settings reads use a hydrated in-memory view; every write goes to IndexedDB. Startup errors stop mounting the app rather than creating defaults over unreadable data.

On first upgrade, Web Storage settings are copied, projects are separated into records, and drafts/MCP records are copied from their old databases. Migration markers are committed atomically with data, and checked inside transactions to tolerate concurrent startup. Legacy sources are retained unchanged and are not runtime write destinations. Old cards are normalized on first load, without deleting the legacy record.

A missing card manifest returns `null`; an intentionally empty snapshot returns `[]`. Loading an empty state does not itself schedule a save. Missing referenced card or Blob records fail loading, preventing automatic empty replacement.

## Saving and recovery

Card metadata is snapshotted before asynchronous work. Each project has an ordered write queue. A single transaction commits new metadata, newly introduced Blobs, a manifest and the preceding nonempty snapshot; it also removes records no longer reachable from current/backup versions. Shared Blob identities are stored once per project and reused across edits and backup snapshots. Binary content is not repeatedly cloned as part of the full card array.

The committed revision is compared inside the write transaction. A stale browser page cannot silently replace a newer project/settings revision. A failed transaction preserves the prior committed snapshot. `loadCardBackup` exposes the retained previous version; empty saves do not destroy the last nonempty backup.

The UI reports pending writes, failed writes and actual persistence permission. Failed operations remain retryable. Card edits debounce for 500ms with a two-second maximum; imported/generated media schedule an immediate save. Local imports include the original File from creation, before compression. Unsaved work triggers a native page-exit warning; unload handlers are only an extra best effort, never the primary durability mechanism.

## Persistence permission

Startup calls `navigator.storage.persisted()` / `persist()`. A visible button repeats the request from a user gesture. The returned boolean is authoritative: a denial is displayed, never described as granted. Explicitly clearing browser data can still remove IndexedDB. No application can force a browser to grant persistence.

## Boundaries

The repository accepts data objects and immutable media, with no DOM or React dependency. Stored card metadata consists of structured data and asset IDs; binary data is stored separately. React and Canvas consume hydrated CardData through the existing adapter. Changing the renderer does not require changing the schema, queues or migrations.

Server-provided default prompt files remain application resources. User prompt edits and settings are persisted in IndexedDB; existing server prompt synchronization remains a compatibility mirror for current inference endpoints.

## Verification

Run `node tests/canvas-performance/check-indexeddb-repository.cjs` for real IndexedDB API transaction tests using fake-indexeddb: v1 migration, settings larger than Web Storage's old limit, Blob reuse, backup retention, quota failure rollback, cross-page conflict prevention, persistence granted/denied and fresh-runtime recovery. Existing canvas regressions remain under `tests/canvas-performance`.

A separate real-browser test was run on the actual `localhost:3000` origin: two cards, a 1MiB Blob, edited metadata, a backup and a setting all survived consecutive page reloads. The embedded browser returned persistence denied, and the product displayed that actual status.

Connection recovery: every transaction is created through a managed factory. Unexpected close and Blob I/O abort invalidate cached handles; an InvalidStateError during transaction creation permits one fresh connection attempt before any request is issued. Transaction rejection preserves the initiating request error instead of hiding it behind cascading close errors. A full disk is not repaired by reconnecting. Existing unsaved browser pages are never refreshed automatically to install this update.
