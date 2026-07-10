-- Trainers can now apply to join a gym; the owner approves before the
-- trainer is linked via TrainerProfileGym.
ALTER TABLE "TrainerProfile" ADD COLUMN IF NOT EXISTS "pendingGymIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
