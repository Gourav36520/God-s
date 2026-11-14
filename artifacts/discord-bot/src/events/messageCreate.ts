import { Events } from "discord.js";
import type { Message } from "discord.js";
import { commands, securityManager } from "../lib/registry.js";
import { logger } from "../lib/logger.js";
import { messageTracker } from "../trackers/message-tracker.js";
import { levelingService } from "../leveling/service.js";

export const name = Events.MessageCreate;
export const once = false;

export async function execute(message: Message): Promise<void> {
  if (!message.guildId || message.author.bot) return;

  messageTracker.recordMessage(message.guildId, message.author.id);
  void levelingService
    .handleMessage(
      message,
      securityManager.getConfig(message.guildId).prefix,
    )
    .catch((error) =>
      logger.warn(
        `Level XP could not be recorded for message ${message.id}:`,
        error instanceof Error ? error.message : String(error),
      ),
    );

  const prefix = securityManager.getConfig(message.guildId).prefix;
  const content = message.content ?? "";
  if (!prefix || !content.startsWith(prefix)) return;

  const input = content.slice(prefix.length).trim();
  if (!input) return;

  const [rawName, ...args] = input.split(/\s+/u);
  const command = commands.get(rawName.toLowerCase());
  if (!command?.executePrefix) return;

  try {
    await command.executePrefix(message, args);
  } catch (error) {
    logger.error(
      `Prefix command "${rawName.toLowerCase()}" failed in guild ${message.guildId}: ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }`,
    );
  }
}