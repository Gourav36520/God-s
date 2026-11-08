import {
  claimDueAutobackupConfig,
  failStaleBackupRecords,
  getDueAutobackupConfigs,
  updateAutobackupConfig,
} from "@workspace/db";
import { type Client } from "discord.js";
import { createServerBackup } from "./backup-service.js";
import { logger } from "../lib/logger.js";

const POLL_INTERVAL_MS = 30_000;
const RETRY_DELAY_MS = 15 * 60_000;
const CLAIM_TIMEOUT_MS = 30 * 60_000;
const STALE_BACKUP_AFTER_MS = 24 * 60 * 60_000;
const activeSchedulers = new WeakMap<Client, () => void>();

function shortFailure(error: unknown): string {
  return error instanceof Error
    ? error.message.replace(/\s+/g, " ").slice(0, 400)
    : "Automatic backup failed.";
}

async function sendFailureAlert(
  client: Client,
  channelId: string | null,
  guildId: string,
  reason: string,
): Promise<void> {
  if (!channelId) return;
  const channel =
    client.channels.cache.get(channelId) ??
    (await client.channels.fetch(channelId).catch(() => null));
  if (channel?.isTextBased() && "send" in channel) {
    await channel
      .send({
        content: `Automatic backup failed for this server: ${reason}`,
        allowedMentions: { parse: [] },
      })
      .catch(() => undefined);
  } else {
    logger.warn(
      `[BACKUP] Failure notification channel unavailable for guild ${guildId}.`,
    );
  }
}

export function startAutobackupScheduler(client: Client): () => void {
  const existing = activeSchedulers.get(client);
  if (existing) return existing;
  let stopped = false;
  let polling = false;
  const poll = async (): Promise<void> => {
    if (stopped || polling) return;
    polling = true;
    try {
      const interrupted = await failStaleBackupRecords(
        new Date(Date.now() - STALE_BACKUP_AFTER_MS),
      );
      if (interrupted.length) {
        logger.warn(
          `[BACKUP] Marked ${interrupted.length} abandoned backup(s) as failed and removed their partial files.`,
        );
      }
      const due = await getDueAutobackupConfigs(new Date(), 10);
      for (const config of due) {
        if (stopped) break;
        const claimed = await claimDueAutobackupConfig(
          config,
          new Date(Date.now() + CLAIM_TIMEOUT_MS),
        );
        if (!claimed) continue;
        const guild =
          client.guilds.cache.get(config.guildId) ??
          (await client.guilds.fetch(config.guildId).catch(() => null));
        if (!guild) {
          const reason = "Bot is no longer in the configured server.";
          const failedAt = new Date();
          await updateAutobackupConfig(config.guildId, {
            lastFailureAt: failedAt,
            lastFailure: reason,
            nextRunAt: new Date(failedAt.getTime() + RETRY_DELAY_MS),
          });
          await sendFailureAlert(
            client,
            config.notificationChannelId,
            config.guildId,
            reason,
          );
          continue;
        }
        try {
          await createServerBackup(
            guild,
            client.user?.id ?? "system",
            "automatic",
          );
          const completedAt = new Date();
          await updateAutobackupConfig(config.guildId, {
            lastSuccessAt: completedAt,
            lastFailureAt: null,
            lastFailure: null,
            nextRunAt: new Date(
              completedAt.getTime() + config.intervalMinutes * 60_000,
            ),
          });
          logger.info(
            `[BACKUP] Automatic backup completed for guild ${config.guildId}.`,
          );
        } catch (error) {
          const failedAt = new Date();
          const reason = shortFailure(error);
          await updateAutobackupConfig(config.guildId, {
            lastFailureAt: failedAt,
            lastFailure: reason,
            nextRunAt: new Date(failedAt.getTime() + RETRY_DELAY_MS),
          });
          await sendFailureAlert(
            client,
            config.notificationChannelId,
            config.guildId,
            reason,
          );
          logger.error(
            `[BACKUP] Automatic backup failed for guild ${config.guildId}: ${reason}`,
          );
        }
      }
    } catch (error) {
      logger.error(
        `[BACKUP] Scheduler poll failed: ${
          error instanceof Error ? error.message.slice(0, 250) : "database unavailable"
        }`,
      );
    } finally {
      polling = false;
    }
  };

  const timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
  timer.unref();
  void poll();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
    activeSchedulers.delete(client);
  };
  activeSchedulers.set(client, stop);
  return stop;
}
