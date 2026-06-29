import {
  Client,
  GatewayIntentBits,
  IntentsBitField,
} from "discord.js";
import { logger } from "./lib/logger.js";
import { commands, loggingService, securityManager } from "./lib/registry.js";
import type { Command } from "./lib/registry.js";
import { GodsJudgment } from "./security/modules/GodsJudgment.js";
import { AntiSpam } from "./security/modules/AntiSpam.js";
import { AntiLink } from "./security/modules/AntiLink.js";
import { registerLoggingHandlers } from "./logging/handlers.js";

function envBool(key: string): boolean {
  return ["true", "1", "yes"].includes(
    (process.env[key] ?? "").trim().toLowerCase()
  );
}

async function loginWithFallback(
  token: string,
  wantMessageContent: boolean,
  wantGuildMembers: boolean
): Promise<{ client: Client; messageContentGranted: boolean; guildMembersGranted: boolean }> {
  let messageContentGranted = wantMessageContent;
  let guildMembersGranted   = wantGuildMembers;

  function buildIntents(mc: boolean, gm: boolean): GatewayIntentBits[] {
    return [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildModeration,
      ...(mc ? [GatewayIntentBits.MessageContent] : []),
      ...(gm ? [GatewayIntentBits.GuildMembers]   : []),
    ];
  }

  {
    const intents = buildIntents(messageContentGranted, guildMembersGranted);
    logger.info(
      `[LOGIN] Attempting login with intents: MessageContent=${messageContentGranted} GuildMembers=${guildMembersGranted} bitmask=${intents.reduce((a, b) => a | b, 0)}`
    );
    const client = new Client({ intents });
    try {
      await client.login(token);
      logger.info("[LOGIN] ✓ Login succeeded with all requested intents");
      return { client, messageContentGranted, guildMembersGranted };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("disallowed intents")) throw err;
      logger.error(
        `[LOGIN] ✗ Discord rejected intent(s): "${msg}". Retrying without privileged intents.`
      );
      await client.destroy();
    }
  }

  messageContentGranted = false;
  guildMembersGranted   = false;
  {
    const intents = buildIntents(false, false);
    logger.warn("[LOGIN] Falling back to base intents only. Anti-Link and Anti-Spam content detection will NOT work.");
    const client = new Client({ intents });
    await client.login(token);
    logger.warn("[LOGIN] ✓ Degraded login succeeded.");
    return { client, messageContentGranted, guildMembersGranted };
  }
}

async function loadCommands(): Promise<void> {
  const ping     = await import("./commands/ping.js");
  const help     = await import("./commands/help.js");
  const info     = await import("./commands/info.js");
  const security = await import("./commands/security.js");
  const judgment = await import("./commands/judgment.js");
  const logging  = await import("./commands/logging.js");

  commands.set(ping.data.name,     ping as Command);
  commands.set(help.data.name,     help as Command);
  commands.set(info.data.name,     info as Command);
  commands.set(security.data.name, security as Command);
  commands.set(judgment.data.name, judgment as Command);
  commands.set(logging.data.name,  logging as Command);
  commands.set(judgment.releaseData.name, {
    data: judgment.releaseData,
    execute: judgment.executeRelease,
  });

  logger.info(`Loaded ${commands.size} command(s): ${[...commands.keys()].join(", ")}`);
}

async function loadEvents(client: Client): Promise<void> {
  const mods = [
    await import("./events/ready.js"),
    await import("./events/interactionCreate.js"),
  ];
  for (const mod of mods) {
    if (mod.once) {
      client.once(mod.name, (...args) => mod.execute(...args as [never]));
    } else {
      client.on(mod.name, (...args) => mod.execute(...args as [never]));
    }
  }
  logger.info(`Registered ${mods.length} core event listener(s)`);
}

async function main(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    logger.error("DISCORD_BOT_TOKEN is not set.");
    process.exit(1);
  }

  const wantMessageContent = envBool("INTENT_MESSAGE_CONTENT");
  const wantGuildMembers   = envBool("INTENT_GUILD_MEMBERS");

  logger.info(
    `[INTENT DIAGNOSTIC] ` +
    `INTENT_MESSAGE_CONTENT raw="${process.env.INTENT_MESSAGE_CONTENT ?? "<unset>"}" → envBool=${wantMessageContent} | ` +
    `INTENT_GUILD_MEMBERS raw="${process.env.INTENT_GUILD_MEMBERS ?? "<unset>"}" → envBool=${wantGuildMembers}`
  );

  await loadCommands();

  const { client, messageContentGranted } = await loginWithFallback(
    token,
    wantMessageContent,
    wantGuildMembers
  );

  const grantedBitfield = (client.options.intents as IntentsBitField).bitfield;
  const mcActuallyActive = (grantedBitfield & GatewayIntentBits.MessageContent) !== 0;

  logger.info(
    `[INTENT DIAGNOSTIC] Post-login: granted bitfield=${grantedBitfield} ` +
    `MessageContent=${mcActuallyActive ? "ACTIVE ✓" : "NOT ACTIVE ✗"}`
  );

  if (wantMessageContent && !mcActuallyActive) {
    logger.error(
      "═══════════════════════════════════════════════════════════════\n" +
      "  PORTAL ACTION REQUIRED — MessageContent intent was REJECTED\n" +
      "  1. Go to: https://discord.com/developers/applications\n" +
      "  2. Select your application → Click 'Bot'\n" +
      "  3. Scroll to 'Privileged Gateway Intents'\n" +
      "  4. Toggle 'Message Content Intent' → ON\n" +
      "  5. Click 'Save Changes' then restart this bot\n" +
      "  Anti-Link will NOT detect URLs until this is done.\n" +
      "═══════════════════════════════════════════════════════════════"
    );
  }

  await loadEvents(client);
  await securityManager.init(client);
  loggingService.init(client, securityManager);
  registerLoggingHandlers(client);

  const godsJudgment = new GodsJudgment(securityManager);
  securityManager.registerModule(godsJudgment);

  const antiLink = new AntiLink(securityManager);
  securityManager.registerModule(antiLink);
  antiLink.register(client);

  const antiSpam = new AntiSpam(securityManager);
  securityManager.registerModule(antiSpam);
  antiSpam.register(client);

  logger.info(`[STARTUP COMPLETE] Bot running. MessageContent active: ${mcActuallyActive}`);
}

main().catch((err) => {
  logger.error(`Fatal startup error: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
