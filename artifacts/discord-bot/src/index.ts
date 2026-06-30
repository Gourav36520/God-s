import {
  Client,
  Events,
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
  function buildIntents(mc: boolean, gm: boolean): GatewayIntentBits[] {
    return [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildModeration,
      ...(mc ? [GatewayIntentBits.MessageContent] : []),
      ...(gm ? [GatewayIntentBits.GuildMembers] : []),
    ];
  }

  async function tryLogin(
    mc: boolean,
    gm: boolean
  ): Promise<Client | null> {
    const intents = buildIntents(mc, gm);
    logger.info(
      `[LOGIN] Attempting login: MessageContent=${mc} GuildMembers=${gm} ` +
        `bitmask=${intents.reduce((a, b) => a | b, 0)}`
    );
    const client = new Client({ intents });
    try {
      await client.login(token);
      return client;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("disallowed intents")) throw err;
      logger.warn(`[LOGIN] ✗ Discord rejected intent(s) for MC=${mc} GM=${gm}: "${msg}"`);
      await client.destroy();
      return null;
    }
  }

  // Step 1: try both privileged intents together
  if (wantMessageContent || wantGuildMembers) {
    const client = await tryLogin(wantMessageContent, wantGuildMembers);
    if (client) {
      logger.info("[LOGIN] ✓ Login succeeded with all requested intents");
      return { client, messageContentGranted: wantMessageContent, guildMembersGranted: wantGuildMembers };
    }
  }

  // Step 2: try GuildMembers alone (member join/leave/update events)
  if (wantGuildMembers) {
    const client = await tryLogin(false, true);
    if (client) {
      logger.warn("[LOGIN] ✓ Login succeeded with GuildMembers only (MessageContent was rejected — Anti-Link URL detection will NOT work).");
      return { client, messageContentGranted: false, guildMembersGranted: true };
    }
  }

  // Step 3: try MessageContent alone (anti-link / anti-spam content scanning)
  if (wantMessageContent) {
    const client = await tryLogin(true, false);
    if (client) {
      logger.warn("[LOGIN] ✓ Login succeeded with MessageContent only (GuildMembers was rejected — member join/leave/role events will NOT fire).");
      return { client, messageContentGranted: true, guildMembersGranted: false };
    }
  }

  // Step 4: base intents only — fully degraded
  logger.error(
    "[LOGIN] All privileged intent combinations rejected. Falling back to base intents only.\n" +
    "  Member join/leave/role events and Anti-Link/Anti-Spam content detection will NOT work.\n" +
    "  Enable Server Members Intent and/or Message Content Intent in the Discord Developer Portal."
  );
  const intents = buildIntents(false, false);
  const client = new Client({ intents });
  await client.login(token);
  logger.warn("[LOGIN] ✓ Degraded login succeeded (base intents only).");
  return { client, messageContentGranted: false, guildMembersGranted: false };
}

async function loadCommands(): Promise<void> {
  const ping = await import("./commands/ping.js");
  const help = await import("./commands/help.js");
  const info = await import("./commands/info.js");
  const security = await import("./commands/security.js");
  const judgment = await import("./commands/judgment.js");
  const logging = await import("./commands/logging.js");

  commands.set(ping.data.name, { data: ping.data, execute: ping.execute });
  commands.set(help.data.name, { data: help.data, execute: help.execute });
  commands.set(info.data.name, { data: info.data, execute: info.execute });
  commands.set(security.data.name, { data: security.data, execute: security.execute });
  commands.set(judgment.data.name, { data: judgment.data, execute: judgment.execute });
  commands.set(logging.data.name, { data: logging.data, execute: logging.execute });
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
      client.once(mod.name, (...args) => mod.execute(...(args as [never])));
    } else {
      client.on(mod.name, (...args) => mod.execute(...(args as [never])));
    }
  }
  logger.info(`Registered ${mods.length} core event listener(s)`);
}

/**
 * After the bot is fully ready (guilds cached), run startup validation for
 * every guild that has God's Judgment configured. This repairs any channel
 * overwrites that were removed or are missing since the last run.
 */
function scheduleStartupValidation(client: Client, godsJudgment: GodsJudgment): void {
  client.once(Events.ClientReady, async (readyClient) => {
    logger.info(
      `[STARTUP VALIDATION] Beginning God's Judgment channel audit across ` +
        `${readyClient.guilds.cache.size} guild(s)...`
    );

    let totalChecked = 0;
    let totalRepaired = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    let guildsAudited = 0;

    for (const guild of readyClient.guilds.cache.values()) {
      const cfg = securityManager.getConfig(guild.id).godsJudgment;
      if (!cfg.enabled || !cfg.judgmentRoleId || !cfg.judgmentChannelId) continue;

      guildsAudited++;
      logger.info(`[STARTUP VALIDATION] Auditing guild: "${guild.name}" (${guild.id})`);

      const stats = await godsJudgment.validateAndRepair(guild).catch((err) => {
        logger.error(
          `[STARTUP VALIDATION] Error validating guild "${guild.name}": ` +
            (err instanceof Error ? err.message : String(err))
        );
        return null;
      });

      if (stats) {
        totalChecked += stats.checked;
        totalRepaired += stats.repaired;
        totalSkipped += stats.skipped;
        totalErrors += stats.errors;
      }
    }

    if (guildsAudited === 0) {
      logger.info(
        "[STARTUP VALIDATION] No guilds have God's Judgment configured yet. " +
          "Run `/judgment setup` to enable it."
      );
    } else {
      logger.info(
        `[STARTUP VALIDATION] ✓ Audit complete — ` +
          `guilds=${guildsAudited} checked=${totalChecked} repaired=${totalRepaired} ` +
          `skipped=${totalSkipped} errors=${totalErrors}`
      );
      if (totalRepaired > 0) {
        logger.warn(
          `[STARTUP VALIDATION] ⚠️  Repaired ${totalRepaired} channel overwrite(s). ` +
            `They were missing or incorrect since the last run.`
        );
      } else {
        logger.info("[STARTUP VALIDATION] ✓ All judgment channel overwrites are correct.");
      }
    }
  });
}

async function main(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    logger.error("DISCORD_BOT_TOKEN is not set.");
    process.exit(1);
  }

  const wantMessageContent = envBool("INTENT_MESSAGE_CONTENT");
  const wantGuildMembers = envBool("INTENT_GUILD_MEMBERS");

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
    `[INTENT DIAGNOSTIC] Post-login: bitfield=${grantedBitfield} ` +
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

  // ── Register modules ──────────────────────────────────────────────────────
  const godsJudgment = new GodsJudgment(securityManager);
  securityManager.registerModule(godsJudgment);
  godsJudgment.register(client); // channelCreate + messageCreate (leak repair)

  const antiLink = new AntiLink(securityManager);
  securityManager.registerModule(antiLink);
  antiLink.register(client);

  const antiSpam = new AntiSpam(securityManager);
  securityManager.registerModule(antiSpam);
  antiSpam.register(client);

  // ── Startup validation: audit + repair all guild channels once ready ───────
  scheduleStartupValidation(client, godsJudgment);

  logger.info(`[STARTUP COMPLETE] Bot running. MessageContent active: ${mcActuallyActive}`);
  void messageContentGranted;
}

main().catch((err) => {
  logger.error(`Fatal startup error: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(1);
});
