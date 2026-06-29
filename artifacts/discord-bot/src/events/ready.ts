import { Client, Events } from "discord.js";
import { logger } from "../lib/logger.js";

export const name = Events.ClientReady;
export const once = true;

export function execute(client: Client<true>): void {
  logger.info(`Logged in as ${client.user.tag}`);
  logger.info(`Serving ${client.guilds.cache.size} guild(s)`);
}
