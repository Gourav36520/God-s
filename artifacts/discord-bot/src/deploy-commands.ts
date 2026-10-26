import { REST, Routes } from "discord.js";
import { logger } from "./lib/logger.js";

async function main(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID ?? process.env.CLIENT_ID;

  if (!token || !clientId) {
    logger.error("DISCORD_BOT_TOKEN and DISCORD_CLIENT_ID (or CLIENT_ID) must be set as secrets.");
    process.exit(1);
  }

  const testGuildId = process.env.DISCORD_TEST_GUILD_ID?.trim();
  const deployGlobally = process.argv.includes("--global");
  if (deployGlobally === Boolean(testGuildId)) {
    logger.error(
      "Set DISCORD_TEST_GUILD_ID for a test-guild registration, or pass --global for an intentional global registration.",
    );
    process.exit(1);
  }
  if (testGuildId && !/^\d{17,20}$/.test(testGuildId)) {
    logger.error("DISCORD_TEST_GUILD_ID must be a valid Discord server ID.");
    process.exit(1);
  }

  const ping = await import("./commands/ping.js");
  const help = await import("./commands/help.js");
  const info = await import("./commands/info.js");
  const security = await import("./commands/security.js");
  const judgment = await import("./commands/judgment.js");
  const logging = await import("./commands/logging.js");
  const heat = await import("./commands/heat.js");
  const autorole = await import("./commands/autorole.js");
  const reactionrole = await import("./commands/reactionrole.js");
  const set = await import("./commands/set.js");
  const remove = await import("./commands/remove.js");
  const welcome = await import("./commands/welcome.js");
  const goodbye = await import("./commands/goodbye.js");
  const create = await import("./commands/create.js");
  const embed = await import("./commands/embed.js");
  const add = await import("./commands/add.js");
  const ticket = await import("./commands/ticket.js");
  const message = await import("./commands/message.js");
  const voice = await import("./commands/voice.js");
  const invite = await import("./commands/invite.js");
  const invited = await import("./commands/invited.js");
  const verification = await import("./commands/verification.js");

  const commandData = [
    ping.data,
    help.data,
    info.data,
    security.data,
    judgment.data,
    judgment.releaseData,
    logging.data,
    heat.data,
    autorole.data,
    reactionrole.data,
    set.data,
    remove.data,
    welcome.data,
    goodbye.data,
    create.data,
    embed.data,
    add.data,
    ticket.data,
    message.data,
    voice.data,
    invite.data,
    invited.data,
    verification.data,
  ].map((d) => d.toJSON());

  const rest = new REST().setToken(token);
  logger.info(
    testGuildId
      ? `Registering the verification command to test guild ${testGuildId}...`
      : `Registering ${commandData.length} slash command(s) globally...`,
  );
  if (testGuildId) {
    await rest.post(Routes.applicationGuildCommands(clientId, testGuildId), {
      body: verification.data.toJSON(),
    });
  } else {
    await rest.put(Routes.applicationCommands(clientId), {
      body: commandData,
    });
  }
  logger.info(
    testGuildId
      ? "Successfully registered the verification command to the test guild."
      : "Successfully registered all commands globally.",
  );
}

main().catch((err) => {
  logger.error("Failed to register commands:", err);
  process.exit(1);
});
