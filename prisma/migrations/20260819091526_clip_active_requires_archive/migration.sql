-- A Clip may only be ACTIVE while both halves of its Discord archive exist.
-- Discord rejects a forward carrying provenance content (error 160011), so one
-- archive entry is two messages and "partial archive" is a reachable state.
-- Enforcing the pairing in the database rather than in the service is what makes
-- the legal orderings the only orderings: ACTIVE -> DELETING -> clear ids on a
-- confirmed Discord delete, and, on revival, DELETING -> set ids -> ACTIVE.
-- Product spec §9.3, and the "never reach ACTIVE with a missing or partial
-- Discord archive" invariant.
ALTER TABLE "clips" ADD CONSTRAINT "clips_active_requires_archive"
  CHECK (
    status <> 'ACTIVE'
    OR (archive_provenance_message_id IS NOT NULL AND archive_forward_message_id IS NOT NULL)
  );
