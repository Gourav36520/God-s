import { Client, Events } from "discord.js";
import { logger } from "../lib/logger.js";
import { inviteTracker } from "../trackers/invite-tracker.js";
import { voiceTracker } from "../trackers/voice-tracker.js";

export const name = Events.ClientReady;
export const once = true;

export async function execute(client: Client<true>): Promise<void> {
  logger.info(`Logged in as ${client.user.tag}`);
  logger.info(`Serving ${client.guilds.cache.size} guild(s)`);
  await inviteTracker.initialize(client);
  voiceTracker.resumeConnected(client);
}
