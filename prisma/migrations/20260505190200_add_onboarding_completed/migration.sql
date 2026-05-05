-- AlterTable: Add onboardingCompleted to User
ALTER TABLE "User" ADD COLUMN "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: Add amenities and equipment to Gym
ALTER TABLE "Gym" ADD COLUMN "amenities" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Gym" ADD COLUMN "equipment" TEXT[] DEFAULT ARRAY[]::TEXT[];
