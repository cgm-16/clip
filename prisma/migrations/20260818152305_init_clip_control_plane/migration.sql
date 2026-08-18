-- CreateEnum
CREATE TYPE "clip_status" AS ENUM ('PENDING', 'ACTIVE', 'DELETING', 'FAILED', 'REMOVED_BY_AUTHOR', 'REMOVED_BY_ADMIN');

-- CreateEnum
CREATE TYPE "author_notification_status" AS ENUM ('PENDING', 'DELIVERED', 'UNDELIVERABLE');

-- CreateTable
CREATE TABLE "guild_configs" (
    "guild_id" TEXT NOT NULL,
    "archive_channel_id" TEXT NOT NULL,
    "configured_by_user_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guild_configs_pkey" PRIMARY KEY ("guild_id")
);

-- CreateTable
CREATE TABLE "guild_allowed_roles" (
    "guild_id" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,

    CONSTRAINT "guild_allowed_roles_pkey" PRIMARY KEY ("guild_id","role_id")
);

-- CreateTable
CREATE TABLE "clips" (
    "guild_id" TEXT NOT NULL,
    "source_message_id" TEXT NOT NULL,
    "source_channel_id" TEXT NOT NULL,
    "archive_provenance_message_id" TEXT,
    "archive_forward_message_id" TEXT,
    "author_user_id" TEXT NOT NULL,
    "status" "clip_status" NOT NULL DEFAULT 'PENDING',
    "author_notification_status" "author_notification_status" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "removed_at" TIMESTAMP(3),

    CONSTRAINT "clips_pkey" PRIMARY KEY ("guild_id","source_message_id")
);

-- CreateTable
CREATE TABLE "clippers" (
    "guild_id" TEXT NOT NULL,
    "source_message_id" TEXT NOT NULL,
    "clipper_user_id" TEXT NOT NULL,
    "clipped_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "clippers_pkey" PRIMARY KEY ("guild_id","source_message_id","clipper_user_id")
);

-- CreateTable
CREATE TABLE "admin_sessions" (
    "token_hash" TEXT NOT NULL,
    "guild_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("token_hash")
);

-- CreateTable
CREATE TABLE "setup_tokens" (
    "token_hash" TEXT NOT NULL,
    "guild_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),

    CONSTRAINT "setup_tokens_pkey" PRIMARY KEY ("token_hash")
);

-- AddForeignKey
ALTER TABLE "guild_allowed_roles" ADD CONSTRAINT "guild_allowed_roles_guild_id_fkey" FOREIGN KEY ("guild_id") REFERENCES "guild_configs"("guild_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "clippers" ADD CONSTRAINT "clippers_guild_id_source_message_id_fkey" FOREIGN KEY ("guild_id", "source_message_id") REFERENCES "clips"("guild_id", "source_message_id") ON DELETE RESTRICT ON UPDATE CASCADE;
