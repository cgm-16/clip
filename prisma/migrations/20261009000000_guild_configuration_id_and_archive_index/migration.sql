-- configuration_id: existing rows get a value from the default.
ALTER TABLE "guild_configs" ADD COLUMN "configuration_id" UUID NOT NULL DEFAULT gen_random_uuid();

-- Screen D ordering: ACTIVE rows newest first, ties broken by source_message_id.
CREATE INDEX "clips_guild_status_created_idx" ON "clips"("guild_id", "status", "created_at", "source_message_id");
