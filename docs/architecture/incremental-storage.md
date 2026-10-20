# Incremental card storage

## Entry points and ownership

`src/db.ts` keeps the existing save/load/delete API. Card operations use
`src/storage/client.ts` → `repository.ts` → `storage.worker.ts` → `backend.ts`.
Agent traces still use the legacy workspace. Script/project descriptions and
camera state still use their existing localStorage paths.

The repository accepts immutable CardData arrays; the existing React update and
undo paths replace changed card objects. Never mutate a persisted card or its
nested fields in place. It captures the array and project key before awaiting,
compares object identity first and then normalized metadata, and sends only changed
records. It yields after approximately 3ms of scanning. Bulk metadata messages
contain at most 16 cards (or about 128KiB, except a single oversized card).
Media uploads are batched separately, at most four resources per message.

Only one save runs per project; later queued snapshots coalesce into the newest.
The confirmed baseline advances only after transaction completion. Failure leaves
the baseline unchanged and the UI's current data pending. Automatic saves debounce
300ms, checkpoint continuous edits after 2 seconds, and retry non-conflict failures
three times. This checkpoint is not a 2-second idle recovery delay.
Ctrl+S, backgrounding and project switches share the repository. Project switching
waits for current changes; failure keeps the current project open. Unload warns
while dirty; asynchronous writes at process termination are not guaranteed.

## Database

`InfiniteCanvasIncrementalDB`, schema 1:

* `projects`: project key → generation, revision, ordered card IDs, deleted flag.
* `cards`: [project, generation, card ID] → metadata and resource references.
* `assets`: stable resource ID → Blob or data URL string.
* `history`: [project, revision] → previous head and changed/deleted records.

Card metadata contains serializable resource markers, not blob URLs. Original
media, display images, nested reference media and all thumbnail sizes are retained.
Runtime URLs are recreated at load. The same Blob object / data URL is registered
once; loaded resource IDs are reused. This is not content-hash deduplication of
independently imported files with identical bytes.

Large assets are committed before cards reference them. A single final transaction
checks the expected revision and existence of referenced assets, writes changed
cards/deletions/order/history and advances the project head. Only `oncomplete`
confirms success. Different tabs with stale revisions are rejected, not silently
merged. Conflict UI keeps local changes available; do not reload before preserving
those changes elsewhere if both versions are needed.

The last 50 commit journal entries are retained. `restorePreviousCardSave` provides
explicit previous-commit recovery, including deleted-project recovery; it is not
yet exposed as a new UI button. Undo/redo continues through the existing card
history and incremental saves. Assets are not garbage-collected in this release,
to avoid deleting media required by undo, recovery or migration. Abandoned staging
generations can remain after interruption and consume storage.

## Legacy migration and rollback boundary

If no new project head exists, the worker reads
`InfiniteCanvasDB/workspace/cards_<project>` (or legacy `cards`). It validates IDs,
encodes/stores batches of 16 in a new invisible generation and publishes the
project head only after all batch transactions complete. Interrupted migration
leaves the old data intact and can restart. Concurrent migrations publish only
the first completed head. Empty arrays are valid projects, not missing projects.
Read errors and unresolved blob URLs stop loading/saving, rather than creating
default data over the original.

The old workspace is retained as a migration-time backup. After editing in the
new format, it is NOT the latest project and must not be used for automatic
rollback. Running old application code cannot read the new commits. All existing
preview tabs must refresh before editing after this upgrade. Do not delete or
recreate the database on version errors. A deliberate downgrade requires exporting
the latest new-format data first; this release does not implement a downgrade UI.

Storage DTOs and the repository do not depend on DOM, canvas nodes or React.
Only the application schedules UI notices. Switching rendering engines does not
require changing the database or saving layer.

## Validation

Run `npm run test:storage`, `npm run lint`, `npm run build`.
Tests cover one-card writes in 2632 cards, media preservation and reuse, no-op
saves, empty projects, failed transactions and retries, transaction abort after
request success, migration interruption, project isolation, stale tabs, deletion
tombstones, overlapping edits, and journal recovery.

Browser verification on the existing 2632-card project: migration/read completed,
unchanged reconstructed cards produced zero write messages. An isolated browser
database with 2632 synthetic cards and eight references each saved a one-card
move in approximately 7–13ms across six runs, with one metadata commit and no
asset upload. This is a controlled benchmark, not an assertion that every real
project operation has that latency. First migration, bulk import, loading and
resource URL creation have separate costs.
