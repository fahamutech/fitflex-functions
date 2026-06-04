-- AlterTable
ALTER TABLE "User" ADD COLUMN     "portalUser" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN     "aclPermissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
