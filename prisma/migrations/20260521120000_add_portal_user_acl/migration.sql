-- AlterTable (idempotent: safe to re-apply after a partial failure)
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "portalUser" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "aclPermissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
