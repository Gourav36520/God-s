import {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type {
  ChatInputCommandInteraction,
  Guild,
  SlashCommandSubcommandBuilder,
  TextChannel,
} from "discord.js";
import { antiNukeService } from "../lib/registry.js";
import { resolveInteractionGuild } from "../lib/interactionGuildContext.js";
import { ANTI_NUKE_DETECTORS } from "../security/antinuke/types.js";
import type { AntiNukeDetector, AntiNukeResponse } from "../security/antinuke/types.js";
import { isAntiNukeDetector } from "../security/antinuke/policy.js";

const burstDetectors = new Set<AntiNukeDetector>([
  "channel-create",
  "channel-delete",
  "member-kick",
  "member-ban",
  "role-create",
  "role-delete",
  "mass-role-add",
  "mass-role-remove",
  "webhook-create",
  "webhook-delete",
  "webhook-update",
  "integration-change",
  "bot-add",
  "emoji-sticker-change",
  "invite-create",
  "invite-delete",
]);

const requiredThresholds = new Set<AntiNukeDetector>([
  "channel-create",
  "channel-delete",
  "member-kick",
  "member-ban",
  "role-create",
  "role-delete",
]);

const ANTI_NUKE_EMOJI = "<:Anti_nuke:1565312687322439730>";
const ANIMATED_ARROW = "<a:arrow_arrow_1:1554486982439079966>";

const coreCommands = [
  helpCommand("help", "Show this guide."),
  helpCommand("status", "Show state and thresholds."),
  helpCommand("enable", "Enable protection."),
  helpCommand("disable", "Disable automatic responses."),
  helpCommand("config view", "View this server's config."),
  helpCommand("config reset", "Reset config; retain incidents."),
  helpCommand("dry-run enabled:<bool>", "Toggle dry-run mode."),
  helpCommand("incident id:<id>", "View this server's incident."),
];
const directDetectorCommands = [
  helpCommand("channel-create enabled:true limit:3 window:3", "Channel creation; default threshold is 3 in 3s."),
  helpCommand("channel-delete enabled:true limit:3 window:3", "Channel deletion; default threshold is 3 in 3s."),
  helpCommand("channel-update enabled:<bool>", "Channel updates."),
  helpCommand("member-kick enabled:true limit:3 window:5", "Member kicks; default threshold is 3 in 5s."),
  helpCommand("member-ban enabled:true limit:3 window:5", "Member bans; default threshold is 3 in 5s."),
  helpCommand("role-create enabled:<bool> limit:<n> window:<s>", "Role creation."),
  helpCommand("role-delete enabled:<bool> limit:<n> window:<s>", "Role deletion."),
  helpCommand("role-update enabled:<bool>", "Role updates."),
  helpCommand("role-permissions enabled:<bool>", "Role permission changes."),
  helpCommand("mass-role-add enabled:<bool> [limit] [window]", "Mass role additions."),
  helpCommand("mass-role-remove enabled:<bool> [limit] [window]", "Mass role removals."),
];
const additionalDetectorCommands = [
  helpCommand("detectors webhook-create enabled:<bool> [limit] [window]", "Webhook creation."),
  helpCommand("detectors webhook-delete enabled:<bool> [limit] [window]", "Webhook deletion."),
  helpCommand("detectors webhook-update enabled:<bool> [limit] [window]", "Webhook updates."),
  helpCommand("detectors integration-change enabled:<bool> [limit] [window]", "Integration changes."),
  helpCommand("detectors bot-add enabled:<bool> [limit] [window]", "Bot additions."),
  helpCommand("detectors guild-update enabled:<bool>", "Server updates."),
  helpCommand("detectors emoji-sticker-change enabled:<bool> [limit] [window]", "Emoji and sticker changes."),
  helpCommand("detectors invite-create enabled:<bool> [limit] [window]", "Invite creation."),
  helpCommand("detectors invite-delete enabled:<bool> [limit] [window]", "Invite deletion."),
];
const responseAndLogCommands = [
  helpCommand("response action:<detector> mode:<mode>", "Modes: log, judgement, kick, lockdown; blacklisted-human-join has no lockdown."),
  helpCommand("logs setup", "Create or reuse private Anti-Nuke logs."),
  helpCommand("logs-config [channel] [alerts-enabled] [mention-owner]", "View or update log settings."),
  helpCommand("logs recent", "Show recent server incidents."),
  helpCommand("logs user target:<user-id>", "Show incidents for a user or bot."),
  helpCommand("logs detector name:<detector|system>", "Show detector or system incidents."),
  helpCommand("logs-test", "Save a test incident and try log delivery."),
];
const judgementAndLockdownCommands = [
  helpCommand("judgement-role view", "View the God's Judgment quarantine role."),
  helpCommand("judgement-role set role:<role>", "Set the existing quarantine role."),
  helpCommand("lockdown enabled enabled:<bool>", "Toggle targeted automatic lockdown."),
  helpCommand("lockdown status", "View targets and saved snapshots."),
  helpCommand("lockdown restore", "Restore unchanged targets."),
  helpCommand("lockdown target-add channel:<channel>", "Add a lockdown target."),
  helpCommand("lockdown target-remove channel:<channel>", "Remove a lockdown target."),
];

export const data = buildCommand();

function buildCommand() {
  const command = new SlashCommandBuilder()
    .setName("antinuke")
    .setDescription("Configure and inspect Anti-Nuke protection")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) =>
      sub.setName("help").setDescription("Show Anti-Nuke commands and permissions"),
    )
    .addSubcommand((sub) =>
      sub.setName("status").setDescription("Show Anti-Nuke status"),
    )
    .addSubcommand((sub) =>
      sub.setName("enable").setDescription("Enable Anti-Nuke protection"),
    )
    .addSubcommand((sub) =>
      sub.setName("disable").setDescription("Disable automatic Anti-Nuke responses"),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("config")
        .setDescription("View or reset Anti-Nuke configuration")
        .addSubcommand((sub) =>
          sub.setName("view").setDescription("View Anti-Nuke configuration"),
        )
        .addSubcommand((sub) =>
          sub.setName("reset").setDescription("Reset Anti-Nuke configuration defaults"),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("dry-run")
        .setDescription("Record intended responses without applying punishments")
        .addBooleanOption((option) =>
          option.setName("enabled").setDescription("Enable dry-run").setRequired(true),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("incident")
        .setDescription("View a stored Anti-Nuke incident")
        .addStringOption((option) =>
          option.setName("id").setDescription("Incident ID").setRequired(true),
        ),
    );

  for (const detector of [
    "channel-create",
    "channel-delete",
    "channel-update",
    "member-kick",
    "member-ban",
    "role-create",
    "role-delete",
    "role-update",
    "role-permissions",
    "mass-role-add",
    "mass-role-remove",
  ] as const) {
    command.addSubcommand((sub) => detectorSubcommand(sub, detector));
  }

  command
    .addSubcommandGroup((group) =>
      group
        .setName("detectors")
        .setDescription("Configure webhook, integration, guild and invite detectors")
        .addSubcommand((sub) => detectorSubcommand(sub, "webhook-create"))
        .addSubcommand((sub) => detectorSubcommand(sub, "webhook-delete"))
        .addSubcommand((sub) => detectorSubcommand(sub, "webhook-update"))
        .addSubcommand((sub) => detectorSubcommand(sub, "integration-change"))
        .addSubcommand((sub) => detectorSubcommand(sub, "bot-add"))
        .addSubcommand((sub) => detectorSubcommand(sub, "guild-update"))
        .addSubcommand((sub) => detectorSubcommand(sub, "emoji-sticker-change"))
        .addSubcommand((sub) => detectorSubcommand(sub, "invite-create"))
        .addSubcommand((sub) => detectorSubcommand(sub, "invite-delete")),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("judgement-role")
        .setDescription("Configure the existing God's Judgment quarantine role")
        .addSubcommand((sub) =>
          sub
            .setName("set")
            .setDescription("Set the quarantine role")
            .addRoleOption((option) =>
              option.setName("role").setDescription("Quarantine role").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName("view").setDescription("View the configured quarantine role"),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("logs-config")
        .setDescription("Set the Anti-Nuke log channel and alert settings")
        .addChannelOption((option) =>
          option
            .setName("channel")
            .setDescription("Dedicated Anti-Nuke text channel")
            .addChannelTypes(ChannelType.GuildText),
        )
        .addBooleanOption((option) =>
          option.setName("alerts-enabled").setDescription("Post alerts in the log channel"),
        )
        .addBooleanOption((option) =>
          option.setName("mention-owner").setDescription("Mention the server owner on threshold alerts"),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("logs")
        .setDescription("Query Anti-Nuke incident records")
        .addSubcommand((sub) =>
          sub.setName("recent").setDescription("Show recent Anti-Nuke incidents"),
        )
        .addSubcommand((sub) =>
          sub
            .setName("user")
            .setDescription("Show Anti-Nuke incidents for an ID")
            .addStringOption((option) =>
              option.setName("target").setDescription("User or bot ID").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("detector")
            .setDescription("Show incidents for a detector")
            .addStringOption((option) =>
              option
                .setName("name")
                .setDescription("Detector name")
                .setRequired(true)
                .addChoices(
                  ...ANTI_NUKE_DETECTORS.map((name) => ({ name, value: name })),
                  { name: "system", value: "system" },
                ),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName("setup").setDescription("Create or reuse private Anti-Nuke Logs"),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName("logs-test").setDescription("Write a test Anti-Nuke log entry"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("response")
        .setDescription("Set a detector's response policy")
        .addStringOption((option) =>
          option
            .setName("action")
            .setDescription("Detector")
            .setRequired(true)
            .addChoices(
              ...ANTI_NUKE_DETECTORS.map((name) => ({ name, value: name })),
              { name: "blacklisted-human-join", value: "blacklisted-human-join" },
            ),
        )
        .addStringOption((option) =>
          option
            .setName("mode")
            .setDescription("Response")
            .setRequired(true)
            .addChoices(
              { name: "Log only", value: "log" },
              { name: "God's Judgment", value: "judgement" },
              { name: "Kick", value: "kick" },
              { name: "Lockdown configured channels", value: "lockdown" },
            ),
        ),
    )
    .addSubcommandGroup((group) =>
      group
        .setName("lockdown")
        .setDescription("Configure and safely restore targeted channel lockdowns")
        .addSubcommand((sub) =>
          sub
            .setName("enabled")
            .setDescription("Enable or disable automatic targeted lockdown")
            .addBooleanOption((option) =>
              option.setName("enabled").setDescription("Enable lockdown").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub.setName("status").setDescription("Show lockdown configuration and snapshots"),
        )
        .addSubcommand((sub) =>
          sub.setName("restore").setDescription("Restore unchanged lockdown targets"),
        )
        .addSubcommand((sub) =>
          sub
            .setName("target-add")
            .setDescription("Add one channel to configured lockdown targets")
            .addChannelOption((option) =>
              option.setName("channel").setDescription("Target channel").setRequired(true),
            ),
        )
        .addSubcommand((sub) =>
          sub
            .setName("target-remove")
            .setDescription("Remove one configured lockdown target")
            .addChannelOption((option) =>
              option.setName("channel").setDescription("Target channel").setRequired(true),
            ),
        ),
    );

  return command;
}

function helpCommand(usage: string, description: string): string {
  return `${ANIMATED_ARROW} \`/antinuke ${usage}\` — ${description}`;
}

function buildAntiNukeHelpEmbeds(): EmbedBuilder[] {
  const detectorDetails =
    "All detectors require enabled. Burst detectors accept limit (1–100) and window (1–3600 seconds); both are required for channel create/delete, member kick/ban, and role create/delete. Other burst thresholds are optional.";
  const permissionDetails = [
    "**Who can use these commands:** Administrator permission is required.",
    "**Bot permissions depend on configuration:** View Audit Log for audit-based detection; Kick Members, Ban Members, or Manage Roles for matching responses; Manage Channels for lockdown; Manage Roles for quarantine actions.",
    "Log delivery needs View Channel, Send Messages, and Embed Links. The bot role must be high enough to manage selected roles.",
  ].join("\n\n");

  return [
    antiNukeHelpEmbed(
      "Core and detector settings",
      [
        "**Core and configuration**",
        ...coreCommands,
        "",
        "**Direct detector controls**",
        ...directDetectorCommands,
        "",
        detectorDetails,
      ].join("\n"),
    ),
    antiNukeHelpEmbed(
      "More detectors, responses, and logs",
      [
        "**Additional detector controls**",
        ...additionalDetectorCommands,
        "",
        "**Responses and incident logs**",
        ...responseAndLogCommands,
      ].join("\n"),
    ),
    antiNukeHelpEmbed(
      "God's Judgment and lockdown",
      [
        "**God's Judgment integration**",
        ...judgementAndLockdownCommands.slice(0, 2),
        "",
        "**Targeted lockdown**",
        ...judgementAndLockdownCommands.slice(2),
        "",
        permissionDetails,
      ].join("\n"),
    ),
  ];
}

function antiNukeHelpEmbed(section: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${ANTI_NUKE_EMOJI} Anti-Nuke Help · ${section}`)
    .setColor(0xd4af37)
    .setDescription(description)
    .setFooter({ text: "Gods Bot • Your Server's Guardian" });
}

function detectorSubcommand(
  sub: SlashCommandSubcommandBuilder,
  detector: AntiNukeDetector,
) {
  sub
    .setName(detector)
    .setDescription(`Configure ${detector} detection`)
    .addBooleanOption((option) =>
      option.setName("enabled").setDescription("Enable this detector").setRequired(true),
    );
  if (burstDetectors.has(detector)) {
    const required = requiredThresholds.has(detector);
    sub
      .addIntegerOption((option) => {
        const result = option
          .setName("limit")
          .setDescription("Events required to reach the threshold")
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(required);
        return result;
      })
      .addIntegerOption((option) =>
        option
          .setName("window")
          .setDescription("Rolling window in seconds")
          .setMinValue(1)
          .setMaxValue(3600)
          .setRequired(required),
      );
  }
  return sub;
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "Use this command in a server.", ephemeral: true });
    return;
  }

  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();
  await interaction.deferReply({ ephemeral: true });
  let guild: Guild | null = null;
  let guildLookupAttempted = false;
  const resolveGuild = async (): Promise<Guild | null> => {
    if (guildLookupAttempted) return guild;
    guildLookupAttempted = true;
    const context = await resolveInteractionGuild(interaction);
    guild = context.kind === "guild" ? context.guild : null;
    return guild;
  };
  const requireGuild = async (): Promise<Guild | null> => {
    const resolvedGuild = await resolveGuild();
    if (!resolvedGuild) {
      await interaction.editReply(
        "This action needs access to server resources. Confirm God's Bot is a member of this server and has the required permissions.",
      );
    }
    return resolvedGuild;
  };

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    const resolvedGuild = await resolveGuild();
    if (interaction.user.id === resolvedGuild?.ownerId) {
      // The server owner is authorized even if the interaction permission
      // snapshot does not include Administrator.
    } else {
      await interaction.editReply("Administrator permission is required.");
      return;
    }
  }

  if (sub === "help") {
    await interaction.editReply({ embeds: buildAntiNukeHelpEmbeds() });
    return;
  }

  await antiNukeService.ensureConfig(guildId);

  if (group === "config") {
    if (sub === "reset") {
      await antiNukeService.resetConfig(guildId);
      await auditConfigChange(interaction, guildId, guild, "config-reset");
      await interaction.editReply("Anti-Nuke configuration reset. Incident history was retained.");
    } else {
      const config = antiNukeService.getConfig(guildId);
      const detectorDetails = ANTI_NUKE_DETECTORS.map((name) => {
        const detector = config.detectors[name];
        return `${name}: ${detector.enabled ? "on" : "off"} · ${detector.limit}/${detector.windowSeconds}s · ${detector.responseMode ?? "default"}`;
      });
      await interaction.editReply(
        [
          `Anti-Nuke: ${config.enabled ? "enabled" : "disabled"} · dry-run: ${config.dryRun ? "on" : "off"}`,
          "Detector policies:",
          ...detectorDetails,
          `Whitelist: ${Object.keys(config.whitelist).length} · blacklist: ${Object.keys(config.blacklist).length}`,
          `Unapproved bot kick: ${config.unverifiedBotKick ? "on" : "off"}`,
          `Logs: ${config.logs.channelId ? `<#${config.logs.channelId}>` : "not configured"}`,
          `Lockdown targets: ${config.lockdown.targets.length}`,
        ].join("\n").slice(0, 1_900),
      );
    }
    return;
  }

  if (group === "judgement-role") {
    if (sub === "view") {
      const roleId = antiNukeService.getConfig(guildId).judgementRoleId;
      await interaction.editReply(
        roleId ? `Configured quarantine role: <@&${roleId}> (\`${roleId}\`)` : "No quarantine role is configured.",
      );
      return;
    }
    const actionGuild = await requireGuild();
    if (!actionGuild) return;
    const selectedRole = interaction.options.getRole("role", true);
    const role = await actionGuild.roles.fetch(selectedRole.id).catch(() => null);
    if (!role) {
      await interaction.editReply("That role is no longer available in this server.");
      return;
    }
    const bot = actionGuild.members.me;
    if (
      role.id === actionGuild.roles.everyone.id ||
      role.managed ||
      !bot?.permissions.has(PermissionFlagsBits.ManageRoles) ||
      !role.editable
    ) {
      await interaction.editReply("That role cannot be assigned by the bot. Check Manage Roles and role hierarchy.");
      return;
    }
    const { securityManager } = await import("../lib/registry.js");
    await securityManager.updateModuleConfig(guildId, "godsJudgment", {
      judgmentRoleId: role.id,
    });
    await antiNukeService.updateConfig(guildId, (current) => ({
      ...current,
      judgementRoleId: role.id,
    }));
    await auditConfigChange(interaction, guildId, actionGuild, "judgement-role-set", role.id);
    await interaction.editReply(`God's Judgment quarantine role set to <@&${role.id}>.`);
    return;
  }

  if (group === "logs") {
    if (sub === "setup") {
      const actionGuild = await requireGuild();
      if (!actionGuild) return;
      const result = await antiNukeService.setupLogs(actionGuild);
      await antiNukeService.recordSystemIncident({
        guild: actionGuild,
        guildId,
        action: "logs-setup",
        executorId: interaction.user.id,
        outcome: result.message,
        details: result,
      });
      await interaction.editReply(result.message);
    } else if (sub === "recent") {
      await showIncidents(interaction, guildId, {});
    } else if (sub === "user") {
      const targetId = parseSnowflake(interaction.options.getString("target", true));
      if (!targetId) {
        await interaction.editReply("Enter a numeric Discord user or bot ID.");
        return;
      }
      await showIncidents(interaction, guildId, { targetId });
    } else {
      await showIncidents(interaction, guildId, {
        detector: interaction.options.getString("name", true),
      });
    }
    return;
  }

  if (group === "detectors") {
    await updateDetector(interaction, guild, guildId, sub as AntiNukeDetector);
    return;
  }

  if (group === "lockdown") {
    const config = antiNukeService.getConfig(guildId);
    if (sub === "enabled") {
      const enabled = interaction.options.getBoolean("enabled", true);
      await antiNukeService.updateConfig(guildId, (current) => ({
        ...current,
        lockdown: { ...current.lockdown, enabled },
      }));
      await auditConfigChange(interaction, guildId, guild, "lockdown-enabled", undefined, { enabled });
      await interaction.editReply(`Automatic targeted lockdown ${enabled ? "enabled" : "disabled"}.`);
    } else if (sub === "status") {
      await interaction.editReply(
        `Automatic lockdown: ${config.lockdown.enabled ? "enabled" : "disabled"}\nTargets: ${
          config.lockdown.targets.length
            ? config.lockdown.targets.map((id) => `<#${id}>`).join(", ")
            : "none"
        }\nSaved restore snapshots: ${config.lockdown.snapshots.length}`,
      );
    } else if (sub === "restore") {
      const actionGuild = await requireGuild();
      if (!actionGuild) return;
      const result = await antiNukeService.restoreLockdown(actionGuild);
      await auditConfigChange(interaction, guildId, actionGuild, "lockdown-restore", undefined, result);
      await interaction.editReply(result.message);
    } else {
      const channel = interaction.options.getChannel("channel", true);
      if (
        !("permissionOverwrites" in channel) ||
        !("guildId" in channel) ||
        channel.guildId !== guildId
      ) {
        await interaction.editReply("Choose a server channel with permission overwrites.");
        return;
      }
      if (sub === "target-add") {
        await antiNukeService.updateConfig(guildId, (current) => ({
          ...current,
          lockdown: {
            ...current.lockdown,
            targets: [...new Set([...current.lockdown.targets, channel.id])],
          },
        }));
        await auditConfigChange(interaction, guildId, guild, "lockdown-target-add", channel.id);
        await interaction.editReply(`Configured <#${channel.id}> as a lockdown target.`);
      } else {
        await antiNukeService.updateConfig(guildId, (current) => ({
          ...current,
          lockdown: {
            ...current.lockdown,
            targets: current.lockdown.targets.filter((id) => id !== channel.id),
          },
        }));
        await auditConfigChange(interaction, guildId, guild, "lockdown-target-remove", channel.id);
        await interaction.editReply(`Removed <#${channel.id}> from lockdown targets.`);
      }
    }
    return;
  }

  if (sub === "status") {
    const config = antiNukeService.getConfig(guildId);
    const required = ["channel-delete", "channel-create", "member-kick", "member-ban"] as const;
    await interaction.editReply(
      [
        `Anti-Nuke: ${config.enabled ? "enabled" : "disabled"} · dry-run: ${config.dryRun ? "on" : "off"}`,
        ...required.map((name) => {
          const item = config.detectors[name];
          return `${name}: ${item.enabled ? "on" : "off"} · ${item.limit} in ${item.windowSeconds}s`;
        }),
        `Logs: ${config.logs.channelId ? `<#${config.logs.channelId}>` : "not configured"}`,
      ].join("\n"),
    );
    return;
  }
  if (sub === "enable" || sub === "disable") {
    const enabled = sub === "enable";
    await antiNukeService.updateConfig(guildId, (current) => ({ ...current, enabled }));
    await auditConfigChange(interaction, guildId, guild, `antinuke-${sub}`);
    await interaction.editReply(`Anti-Nuke ${enabled ? "enabled" : "disabled"}. Event logging continues.`);
    return;
  }
  if (sub === "dry-run") {
    const enabled = interaction.options.getBoolean("enabled", true);
    await antiNukeService.updateConfig(guildId, (current) => ({
      ...current,
      dryRun: enabled,
    }));
    await auditConfigChange(interaction, guildId, guild, "dry-run", undefined, { enabled });
    await interaction.editReply(`Dry-run ${enabled ? "enabled" : "disabled"}.`);
    return;
  }
  if (sub === "incident") {
    const incident = await antiNukeService.getIncident(
      guildId,
      interaction.options.getString("id", true),
    );
    await interaction.editReply(incident ? formatIncident(incident) : "Incident not found in this server.");
    return;
  }
  if (sub === "logs-config") {
    const selectedChannel = interaction.options.getChannel("channel");
    const alertsEnabled = interaction.options.getBoolean("alerts-enabled");
    const mentionOwner = interaction.options.getBoolean("mention-owner");
    if (!selectedChannel && alertsEnabled === null && mentionOwner === null) {
      const config = antiNukeService.getConfig(guildId).logs;
      await interaction.editReply(
        `Channel: ${config.channelId ? `<#${config.channelId}>` : "not configured"} · alerts: ${
          config.alertsEnabled ? "on" : "off"
        } · mention owner: ${config.mentionOwner ? "on" : "off"}`,
      );
      return;
    }
    let channel: TextChannel | null = null;
    const actionGuild = selectedChannel ? await requireGuild() : null;
    if (selectedChannel && !actionGuild) return;
    if (selectedChannel) {
      const fetched = await actionGuild!.channels.fetch(selectedChannel.id).catch(() => null);
      if (!fetched || fetched.type !== ChannelType.GuildText) {
        await interaction.editReply("The Anti-Nuke log channel must be a server text channel.");
        return;
      }
      channel = fetched;
    }
    if (channel) {
      const current = antiNukeService.getConfig(guildId).logs;
      const everyoneCanView = channel.permissionsFor(actionGuild!.roles.everyone)?.has(
        PermissionFlagsBits.ViewChannel,
      );
      if (!current.categoryId || channel.parentId !== current.categoryId || everyoneCanView) {
        await interaction.editReply(
          "Choose a private text channel inside the dedicated Anti-Nuke Logs category. Run /antinuke logs-setup first if needed.",
        );
        return;
      }
    }
    await antiNukeService.updateConfig(guildId, (current) => ({
      ...current,
      logs: {
        ...current.logs,
        ...(channel ? { channelId: channel.id } : {}),
        ...(alertsEnabled !== null ? { alertsEnabled } : {}),
        ...(mentionOwner !== null ? { mentionOwner } : {}),
      },
    }));
    await auditConfigChange(interaction, guildId, guild, "logs-config", channel?.id ?? undefined, {
      alertsEnabled,
      mentionOwner,
    });
    await interaction.editReply("Anti-Nuke log settings saved.");
    return;
  }
  if (sub === "logs-test") {
    const incident = await antiNukeService.recordSystemIncident({
      guild: (await resolveGuild()) ?? undefined,
      guildId,
      action: "logs-test",
      executorId: interaction.user.id,
      outcome: "Test entry recorded.",
      details: { test: true },
    });
    if (!incident) {
      await interaction.editReply("The test log could not be saved.");
      return;
    }
    const sent = incident.details.logSent === true;
    await interaction.editReply(
      sent
        ? `Test log was saved and sent to the configured channel. Incident ID: \`${incident.id}\``
        : `Test incident was saved, but it was not delivered. Check that alerts are enabled, a private log channel is configured, and the bot can post there. Incident ID: \`${incident.id}\``,
    );
    return;
  }
  if (sub === "response") {
    const action = interaction.options.getString("action", true);
    const mode = interaction.options.getString("mode", true) as AntiNukeResponse;
    if (action === "blacklisted-human-join") {
      if (mode === "lockdown") {
        await interaction.editReply("Lockdown is not a valid join response; choose log, judgement, or kick.");
        return;
      }
      await antiNukeService.updateConfig(guildId, (current) => ({
        ...current,
        blacklistedHumanJoinResponse: mode,
      }));
    } else if (isAntiNukeDetector(action)) {
      await antiNukeService.updateConfig(guildId, (current) => ({
        ...current,
        detectors: {
          ...current.detectors,
          [action]: { ...current.detectors[action], responseMode: mode },
        },
      }));
    } else {
      await interaction.editReply("Unknown detector.");
      return;
    }
    await auditConfigChange(interaction, guildId, guild, "response-policy", undefined, { action, mode });
    await interaction.editReply(`Response policy for ${action} set to ${mode}.`);
    return;
  }
  if (sub === "channel-create" || sub === "channel-delete" ||
      sub === "channel-update" || sub === "member-kick" || sub === "member-ban" ||
      sub === "role-create" || sub === "role-delete" || sub === "role-update" ||
      sub === "role-permissions" || sub === "mass-role-add" || sub === "mass-role-remove") {
    await updateDetector(interaction, guild, guildId, sub as AntiNukeDetector);
  }
}

async function updateDetector(
  interaction: ChatInputCommandInteraction,
  guild: Guild | null,
  guildId: string,
  detector: AntiNukeDetector,
): Promise<void> {
  const enabled = interaction.options.getBoolean("enabled", true);
  const limit = interaction.options.getInteger("limit");
  const window = interaction.options.getInteger("window");
  if ((limit === null) !== (window === null)) {
    await interaction.editReply("Set both limit and window, or leave both unchanged.");
    return;
  }
  if (requiredThresholds.has(detector) && (limit === null || window === null)) {
    await interaction.editReply("This burst detector requires both limit and window.");
    return;
  }
  await antiNukeService.updateConfig(guildId, (current) => ({
    ...current,
    detectors: {
      ...current.detectors,
      [detector]: {
        ...current.detectors[detector],
        enabled,
        ...(limit !== null ? { limit } : {}),
        ...(window !== null ? { windowSeconds: window } : {}),
      },
    },
  }));
  await antiNukeService.recordSystemIncident({
    guild: guild ?? undefined,
    guildId,
    action: "detector-config",
    executorId: interaction.user.id,
    targetId: detector,
    outcome: `Detector ${enabled ? "enabled" : "disabled"}.`,
    details: { detector, enabled, limit, windowSeconds: window },
  });
  const setting = antiNukeService.getConfig(guildId).detectors[detector];
  await interaction.editReply(
    `${detector} ${enabled ? "enabled" : "disabled"} · threshold ${setting.limit} event(s) in ${setting.windowSeconds}s.`,
  );
}

async function showIncidents(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  filters: { targetId?: string; detector?: string },
): Promise<void> {
  const incidents = await antiNukeService.listIncidents(
    guildId,
    filters.targetId ? { targetId: filters.targetId } : filters,
    10,
  );
  await interaction.editReply(
    incidents.length
      ? incidents.map(formatIncident).join("\n\n").slice(0, 1_900)
      : "No matching incidents were found.",
  );
}

function formatIncident(incident: {
  id: string;
  detector: string;
  executorId: string | null;
  targetId: string | null;
  action: string;
  thresholdCount: number;
  response: string;
  outcome: string;
  occurredAt: Date;
}): string {
  return [
    `**${incident.detector} · ${incident.action}** — <t:${Math.floor(incident.occurredAt.getTime() / 1_000)}:R>`,
    `Executor: ${incident.executorId ? `\`${incident.executorId}\`` : "unknown"} · Target: ${incident.targetId ? `\`${incident.targetId}\`` : "unknown"}`,
    `Count: ${incident.thresholdCount} · Response: ${incident.response} · ${incident.outcome}`,
    `ID: \`${incident.id}\``,
  ].join("\n");
}

async function auditConfigChange(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  guild: Guild | null,
  action: string,
  targetId?: string,
  details: Record<string, unknown> = {},
): Promise<void> {
  await antiNukeService.recordSystemIncident({
    guild: guild ?? undefined,
    guildId,
    action,
    executorId: interaction.user.id,
    targetId,
    outcome: "Configuration change saved.",
    details,
  });
}

function parseSnowflake(value: string): string | null {
  const match = value.match(/^(?:<@!?)?(\d{17,20})>?$/u);
  return match?.[1] ?? null;
}
