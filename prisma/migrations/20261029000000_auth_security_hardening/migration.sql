BEGIN;
ALTER TABLE "User" ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "User" ADD CONSTRAINT "User_authVersion_check" CHECK ("authVersion" >= 0);
CREATE TABLE "AuthSession" (
  "id" UUID NOT NULL, "userId" UUID NOT NULL, "tokenFamilyId" UUID NOT NULL,
  "refreshTokenHash" CHAR(64) NOT NULL, "usedTokenHashes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "rotationCount" INTEGER NOT NULL DEFAULT 0, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3), "lastUsedAt" TIMESTAMP(3),
  CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuthSession_history_check" CHECK ("rotationCount" BETWEEN 0 AND 1000 AND cardinality("usedTokenHashes") = "rotationCount"),
  CONSTRAINT "AuthSession_expiry_check" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "AuthSession_tokenFamilyId_key" ON "AuthSession"("tokenFamilyId");
CREATE UNIQUE INDEX "AuthSession_refreshTokenHash_key" ON "AuthSession"("refreshTokenHash");
CREATE INDEX "AuthSession_userId_revokedAt_expiresAt_idx" ON "AuthSession"("userId", "revokedAt", "expiresAt");
CREATE TABLE "PasswordResetToken" (
  "userId" UUID NOT NULL, "tokenHash" CHAR(64) NOT NULL, "authVersion" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3), "deliveryStatus" VARCHAR(10) NOT NULL DEFAULT 'PENDING',
  CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("userId"),
  CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "PasswordResetToken_expiry_check" CHECK ("expiresAt" > "createdAt"),
  CONSTRAINT "PasswordResetToken_delivery_check" CHECK ("deliveryStatus" IN ('PENDING', 'SENT', 'FAILED'))
);
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken"("expiresAt");
CREATE TABLE "AuthRateBucket" (
  "id" UUID NOT NULL, "key" CHAR(64) NOT NULL, "count" INTEGER NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AuthRateBucket_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuthRateBucket_count_check" CHECK ("count" > 0)
);
CREATE UNIQUE INDEX "AuthRateBucket_key_key" ON "AuthRateBucket"("key");
CREATE INDEX "AuthRateBucket_expiresAt_idx" ON "AuthRateBucket"("expiresAt");
COMMIT;
