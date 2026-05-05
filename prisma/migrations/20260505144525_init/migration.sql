-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "firebaseUid" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "displayName" TEXT,
    "photoUrl" TEXT,
    "userType" TEXT NOT NULL,
    "accountStatus" TEXT NOT NULL DEFAULT 'active',
    "approvalStatus" TEXT NOT NULL DEFAULT 'approved',
    "approvalNote" TEXT,
    "gymId" TEXT,
    "gymIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gym" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "location" TEXT NOT NULL,
    "venueType" TEXT NOT NULL DEFAULT 'physical',
    "accessMode" TEXT NOT NULL DEFAULT 'paid_visit',
    "operatingHours" JSONB,
    "perVisitRate" INTEGER NOT NULL DEFAULT 0,
    "ratePerDay" INTEGER NOT NULL DEFAULT 0,
    "ratePerWeek" INTEGER NOT NULL DEFAULT 0,
    "ratePerMonth" INTEGER NOT NULL DEFAULT 0,
    "commissionRate" INTEGER NOT NULL DEFAULT 12,
    "status" TEXT NOT NULL DEFAULT 'active',
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "coordinates" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Gym_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "tier" TEXT,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "cycleStartedAt" TIMESTAMP(3) NOT NULL,
    "renewsAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "homeGymId" TEXT,
    "paymentRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentRequest" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "amountTzs" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "reference" TEXT,
    "note" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,

    CONSTRAINT "PaymentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Checkin" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL,
    "subscriptionType" TEXT NOT NULL,
    "passTier" TEXT,
    "visitNumberInCycle" INTEGER,
    "gymTier" TEXT NOT NULL,
    "creditsDeductedTzs" INTEGER NOT NULL DEFAULT 0,
    "visitConsumed" BOOLEAN NOT NULL,

    CONSTRAINT "Checkin_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "gymName" TEXT NOT NULL,
    "ownerId" TEXT,
    "ownerName" TEXT,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'unpaid',
    "note" TEXT,
    "periodStart" TEXT,
    "periodEnd" TEXT,
    "receiptUrl" TEXT,
    "paymentReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3),

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GymPayout" (
    "id" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "periodStart" TEXT,
    "periodEnd" TEXT,
    "paidAt" TIMESTAMP(3),
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GymPayout_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainerProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT,
    "displayName" TEXT NOT NULL,
    "photoUrl" TEXT,
    "specialties" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "bio" TEXT,
    "rating" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "reviewCount" INTEGER NOT NULL DEFAULT 0,
    "hourlyRateTzs" INTEGER NOT NULL DEFAULT 0,
    "experienceYears" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'active',
    "approvalStatus" TEXT NOT NULL DEFAULT 'approved',
    "availability" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrainerProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrainerProfileGym" (
    "trainerId" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,

    CONSTRAINT "TrainerProfileGym_pkey" PRIMARY KEY ("trainerId","gymId")
);

-- CreateTable
CREATE TABLE "TrainerBooking" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "trainerId" TEXT NOT NULL,
    "gymId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "slot" TEXT NOT NULL,
    "amountTzs" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'confirmed',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TrainerBooking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditsWallet" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "balanceTzs" INTEGER NOT NULL DEFAULT 0,
    "lastTopUpAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "CreditsWallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditsTransaction" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "amountTzs" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "reference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditsTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSettings" (
    "id" TEXT NOT NULL DEFAULT 'platform',
    "subscriptionTiers" JSONB NOT NULL,
    "payoutBands" JSONB NOT NULL,
    "paymentPeriodDays" INTEGER NOT NULL DEFAULT 14,
    "payoutModel" TEXT NOT NULL DEFAULT 'commission',
    "currency" TEXT NOT NULL DEFAULT 'TZS',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT,
    "action" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookSeen" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookSeen_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Otp" (
    "phone" TEXT NOT NULL,
    "code" TEXT,
    "userType" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Otp_pkey" PRIMARY KEY ("phone")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_firebaseUid_key" ON "User"("firebaseUid");

-- CreateIndex
CREATE UNIQUE INDEX "User_phone_key" ON "User"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "User_userType_idx" ON "User"("userType");

-- CreateIndex
CREATE INDEX "User_accountStatus_idx" ON "User"("accountStatus");

-- CreateIndex
CREATE INDEX "User_phone_idx" ON "User"("phone");

-- CreateIndex
CREATE INDEX "Gym_status_idx" ON "Gym"("status");

-- CreateIndex
CREATE INDEX "Gym_tier_idx" ON "Gym"("tier");

-- CreateIndex
CREATE INDEX "Subscription_memberId_status_idx" ON "Subscription"("memberId", "status");

-- CreateIndex
CREATE INDEX "Subscription_renewsAt_idx" ON "Subscription"("renewsAt");

-- CreateIndex
CREATE INDEX "PaymentRequest_memberId_idx" ON "PaymentRequest"("memberId");

-- CreateIndex
CREATE INDEX "PaymentRequest_status_idx" ON "PaymentRequest"("status");

-- CreateIndex
CREATE INDEX "Checkin_gymId_timestamp_idx" ON "Checkin"("gymId", "timestamp");

-- CreateIndex
CREATE INDEX "Checkin_memberId_timestamp_idx" ON "Checkin"("memberId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "Checkin_memberId_gymId_timestamp_key" ON "Checkin"("memberId", "gymId", "timestamp");

-- CreateIndex
CREATE INDEX "Invoice_gymId_periodStart_periodEnd_idx" ON "Invoice"("gymId", "periodStart", "periodEnd");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "GymPayout_gymId_periodStart_periodEnd_idx" ON "GymPayout"("gymId", "periodStart", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "TrainerProfile_userId_key" ON "TrainerProfile"("userId");

-- CreateIndex
CREATE INDEX "TrainerProfile_status_idx" ON "TrainerProfile"("status");

-- CreateIndex
CREATE INDEX "TrainerBooking_memberId_idx" ON "TrainerBooking"("memberId");

-- CreateIndex
CREATE INDEX "TrainerBooking_trainerId_idx" ON "TrainerBooking"("trainerId");

-- CreateIndex
CREATE UNIQUE INDEX "CreditsWallet_userId_key" ON "CreditsWallet"("userId");

-- CreateIndex
CREATE INDEX "CreditsTransaction_walletId_idx" ON "CreditsTransaction"("walletId");

-- CreateIndex
CREATE INDEX "AuditLog_actor_idx" ON "AuditLog"("actor");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");

-- CreateIndex
CREATE INDEX "WebhookSeen_at_idx" ON "WebhookSeen"("at");

-- CreateIndex
CREATE INDEX "Otp_expiresAt_idx" ON "Otp"("expiresAt");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentRequest" ADD CONSTRAINT "PaymentRequest_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Checkin" ADD CONSTRAINT "Checkin_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Checkin" ADD CONSTRAINT "Checkin_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GymPayout" ADD CONSTRAINT "GymPayout_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainerProfile" ADD CONSTRAINT "TrainerProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainerProfileGym" ADD CONSTRAINT "TrainerProfileGym_trainerId_fkey" FOREIGN KEY ("trainerId") REFERENCES "TrainerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainerProfileGym" ADD CONSTRAINT "TrainerProfileGym_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainerBooking" ADD CONSTRAINT "TrainerBooking_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainerBooking" ADD CONSTRAINT "TrainerBooking_trainerId_fkey" FOREIGN KEY ("trainerId") REFERENCES "TrainerProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TrainerBooking" ADD CONSTRAINT "TrainerBooking_gymId_fkey" FOREIGN KEY ("gymId") REFERENCES "Gym"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditsWallet" ADD CONSTRAINT "CreditsWallet_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditsTransaction" ADD CONSTRAINT "CreditsTransaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "CreditsWallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;
