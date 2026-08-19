-- A tombstoned Clip can never be published again. Author or admin removal
-- overrides every other signal and blocks recreation (product spec §7.4), and
-- `removed_at` is written only on those two paths -- ordinary deletion drops the
-- row entirely -- so no legal state pairs ACTIVE with a removal timestamp.
--
-- The archive round-trip that precedes activation runs outside any lock and is
-- seconds wide, which is long enough for the author to remove the Clip in
-- between. `markActive` refuses that write, and this constraint refuses it again
-- for code that has not been written yet. The companion
-- `clips_active_requires_archive` guards the other half of the same state.
ALTER TABLE "clips" ADD CONSTRAINT "clips_active_not_removed"
  CHECK (status <> 'ACTIVE' OR removed_at IS NULL);
