import { Events } from "discord.js";
import type { Message } from "discord.js";
import { commands, securityManager } from "../lib/registry.js";
import { logger } from "../lib/logger.js";

export const name = Events.MessageCreate;
export const once = false;

export async function execute(message: Message): Promise<void> {
  if (!message.guildId || message.author.bot) return;

  const prefix = securityManager.getConfig(message.guildId).prefix;
  if (!prefix || !message.content.startsWith(prefix)) return;

  const input = message.content.slice(prefix.length).trim();
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