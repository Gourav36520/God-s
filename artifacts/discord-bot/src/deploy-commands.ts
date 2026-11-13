import { REST, Routes } from "discord.js";
import { logger } from "./lib/logger.js";

async function main(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID ?? process.env.CLIENT_ID;

  if (!token || !clientId) {
    logger.error("DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID (or CLIENT_ID) must be set as secrets.");
    process.exit(1);
  }

  const backup = await import("./commands/backup.js");
  const autobackup = await import("./commands/autobackup.js");
  const recover = await import("./commands/recover.js");
  const memberCards = await import("./commands/member-cards.js");
  const commandData = [
    backup.data,
    autobackup.data,
    recover.data,
    memberCards.generateData,
    memberCards.cardData,
  ].map((d) => d.toJSON());
  const rest = new REST().setToken(token);
  const current = (await rest.get(
    Routes.applicationCommands(clientId),
  )) as { id: string; name: string; type?: number }[];
  let added = 0;

  for (const command of commandData) {
    const alreadyRegistered = current.some(
      (item) =>
        item.name === command.name &&
        (item.type ?? 1) === (command.type ?? 1),
    );
    if (alreadyRegistered) {
      logger.info(`Keeping existing /${command.name} command unchanged.`);
      continue;
    }
    await rest.post(Routes.applicationCommands(clientId), { body: command });
    logger.info(`Added missing /${command.name} command.`);
    added++;
  }
  logger.info(
    `Missing command registration finished; added ${added} command(s) without replacing existing commands.`,
  );
}

main().catch((err) => {
  const status =
    err && typeof err === "object" && "status" in err
      ? String((err as { status: unknown }).status)
      : "unknown";
  logger.error(`Failed to add missing commands (status ${status}).`);
  process.exit(1);
});
