import { REST, Routes } from "discord.js";
import { logger } from "./lib/logger.js";

async function main(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;

  if (!token || !clientId) {
    logger.error("DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID must be set as secrets.");
    process.exit(1);
  }

  const ping = await import("./commands/ping.js");
  const help = await import("./commands/help.js");
  const info = await import("./commands/info.js");
  const security = await import("./commands/security.js");
  const judgment = await import("./commands/judgment.js");
  const logging = await import("./commands/logging.js");

  const commandData = [
    ping.data,
    help.data,
    info.data,
    security.data,
    judgment.data,
    judgment.releaseData,
    logging.data,
  ].map((d) => d.toJSON());

  const rest = new REST().setToken(token);

  logger.info(`Registering ${commandData.length} slash command(s) globally...`);
  await rest.put(Routes.applicationCommands(clientId), { body: commandData });
  logger.info("Successfully registered all commands.");
}

main().catch((err) => {
  logger.error("Failed to register commands:", err);
  process.exit(1);
});
