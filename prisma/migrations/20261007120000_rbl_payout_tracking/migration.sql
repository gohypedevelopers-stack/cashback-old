-- AlterTable
ALTER TABLE "Withdrawal" ADD COLUMN     "holdReason" TEXT,
ADD COLUMN     "initiatedAt" TIMESTAMP(3),
ADD COLUMN     "lastRequeryAt" TIMESTAMP(3),
ADD COLUMN     "nextRequeryAt" TIMESTAMP(3),
ADD COLUMN     "notFoundCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "rblCustRef" TEXT,
ADD COLUMN     "rblErrorCode" TEXT,
ADD COLUMN     "rblOrgTxnId" TEXT,
ADD COLUMN     "rblPayeeRespCode" TEXT,
ADD COLUMN     "rblRefId" TEXT,
ADD COLUMN     "rblTxnId" TEXT,
ADD COLUMN     "rblTxnStatus" TEXT,
ADD COLUMN     "requeryCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "retriedSameIds" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "RblApiLog" (
    "id" TEXT NOT NULL,
    "withdrawalId" TEXT,
    "api" TEXT NOT NULL,
    "txnId" TEXT,
    "requestBody" TEXT NOT NULL,
    "responseBody" TEXT,
    "httpStatus" INTEGER,
    "error" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RblApiLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RblApiLog_withdrawalId_idx" ON "RblApiLog"("withdrawalId");

-- CreateIndex
CREATE INDEX "RblApiLog_txnId_idx" ON "RblApiLog"("txnId");

-- CreateIndex
CREATE INDEX "RblApiLog_createdAt_idx" ON "RblApiLog"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Withdrawal_rblTxnId_key" ON "Withdrawal"("rblTxnId");

-- CreateIndex
CREATE UNIQUE INDEX "Withdrawal_rblRefId_key" ON "Withdrawal"("rblRefId");

-- CreateIndex
CREATE INDEX "Withdrawal_status_nextRequeryAt_idx" ON "Withdrawal"("status", "nextRequeryAt");

-- AddForeignKey
ALTER TABLE "RblApiLog" ADD CONSTRAINT "RblApiLog_withdrawalId_fkey" FOREIGN KEY ("withdrawalId") REFERENCES "Withdrawal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

