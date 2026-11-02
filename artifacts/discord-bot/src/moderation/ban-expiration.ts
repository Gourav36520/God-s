import { Events, type Client, type GuildBan } from "discord.js";
import {
  deferModerationBanExpiration,
  listDueModerationBanExpirations,
  resolveModerationBanExpiration,
  resolveModerationBanExpirationsForTarget,
} from "@workspace/db";
import { logger } from "../lib/logger.js";

const CHECK_INTERVAL_MS = 60_000;
const RETRY_DELAY_MS = 5 * 60_000;

function discordErrorCode(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "number"
  ) {
    return error.code;
  }
  return null;
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown error";
}

export function startBanExpirationProcessor(client: Client): () => void {
  let timer: ReturnType<typeof setInterval> | null = null;
  let processing = false;
  let stopped = false;

  const onBanRemoved = (ban: GuildBan): void => {
    void resolveModerationBanExpirationsForTarget(
      ban.guild.id,
      ban.user.id,
    ).catch((error: unknown) => {
      logger.warn(
        "Temporary ban schedule cleanup failed after a ban was removed:",
        safeErrorName(error),
      );
    });
  };

  const processDueBans = async (): Promise<void> => {
    if (stopped || processing) return;
    processing = true;
    try {
      const dueBans = await listDueModerationBanExpirations();
      for (const scheduledBan of dueBans) {
        if (stopped) break;
        try {
          const guild =
            client.guilds.cache.get(scheduledBan.guildId) ??
            (await client.guilds.fetch(scheduledBan.guildId));

          try {
            await guild.bans.remove(
              scheduledBan.targetId,
              "Temporary ban expired",
            );
          } catch (error) {
            // A moderator may already have unbanned the user. Treat that as complete.
            if (discordErrorCode(error) !== 10026) throw error;
          }

          await resolveModerationBanExpiration(scheduledBan.id);
        } catch (error) {
          try {
            await deferModerationBanExpiration(
              scheduledBan.id,
              new Date(Date.now() + RETRY_DELAY_MS),
            );
          } catch (retryError) {
            logger.warn(
              "Temporary ban retry delay could not be saved:",
              safeErrorName(retryError),
            );
          }
          logger.warn(
            `Temporary ban expiration failed in guild=${scheduledBan.guildId} target=${scheduledBan.targetId}; it will be retried:`,
            safeErrorName(error),
          );
        }
      }
    } catch (error) {
      logger.warn(
        "Temporary ban expiry scan failed; it will be retried:",
        safeErrorName(error),
      );
    } finally {
      processing = false;
    }
  };

  const beginProcessing = (): void => {
    if (stopped || timer) return;
    void processDueBans();
    timer = setInterval(() => void processDueBans(), CHECK_INTERVAL_MS);
    timer.unref?.();
  };

  client.on(Events.GuildBanRemove, onBanRemoved);
  if (client.isReady()) {
    beginProcessing();
  } else {
    client.once(Events.ClientReady, beginProcessing);
  }

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    client.off(Events.GuildBanRemove, onBanRemoved);
    client.off(Events.ClientReady, beginProcessing);
  };
}
