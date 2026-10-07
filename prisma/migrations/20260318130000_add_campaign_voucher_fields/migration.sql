-- AlterTable
-- IF NOT EXISTS: these columns were already added to some databases outside of migrations.
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "voucherDesignUrl" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "voucherHeading" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "voucherSubtext" TEXT;
ALTER TABLE "Campaign" ADD COLUMN IF NOT EXISTS "voucherExtraText" TEXT;
