import { lt } from "drizzle-orm";
import { logger } from "../logger";

export async function purgeVerificationData(
  retentionDays: number,
  now = new Date(),
): Promise<void> {
  const {
    db,
    verificationBotNoncesTable,
    verificationSessionsTable,
  } = await import("@workspace/db");
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  await db
    .delete(verificationSessionsTable)
    .where(lt(verificationSessionsTable.createdAt, cutoff));
  await db
    .delete(verificationBotNoncesTable)
    .where(lt(verificationBotNoncesTable.expiresAt, now));
}

export function startVerificationRetentionCleanup(): void {
  const retentionDays = Number(process.env.VERIFICATION_RETENTION_DAYS);
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > 3650
  ) {
    return;
  }

  const run = async (): Promise<void> => {
    try {
      await purgeVerificationData(retentionDays);
      logger.info({ retentionDays }, "Verification retention cleanup completed");
    } catch {
      logger.error("Verification retention cleanup failed");
    }
  };

  void run();
  const timer = setInterval(() => void run(), 60 * 60 * 1000);
  timer.unref();
}
