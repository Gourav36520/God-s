import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { AntiSpamAction, ModuleKey } from "../security/types.js";
import { securityManager } from "../lib/registry.js";
import type { AntiSpam } from "../security/modules/AntiSpam.js";
import { logger } from "../lib/logger.js";

const MODULE_LABELS: Record<ModuleKey, string> = {
  antiSpam: "Anti-Spam",
  antiLink: "Anti-Link",
  antiInvite: "Anti-Invite",
  antiRaid: "Anti-Raid",
  godsJudgment: "God's Judgment",
};

const MODULE_CHOICES = (Object.keys(MODULE_LABELS) as ModuleKey[]).map((key) => ({
  name: MODULE_LABELS[key],
  value: key,
}));

const ACTION_LABELS: Record<AntiSpamAction, string> = {
  warn: "⚠️ Warn",
  timeout: "⏱️ Timeout",
  judgment: "⚖️ God's Judgment",
};

export const data = new SlashCommandBuilder()
  .setName("security")
  .setDescription("Manage God's Bot security settings")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  .addSubcommand((sub) =>
    sub.setName("status").setDescription("Show all module states and global settings")
  )
  .addSubcommand((sub) =>
    sub
      .setName("enable")
      .setDescription("Enable a security module")
      .addStringOption((opt) =>
        opt.setName("module").setDescription("Module to enable").setRequired(true).addChoices(...MODULE_CHOICES)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("disable")
      .setDescription("Disable a security module")
      .addStringOption((opt) =>
        opt.setName("module").setDescription("Module to disable").setRequired(true).addChoices(...MODULE_CHOICES)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("setlog")
      .setDescription("Set the channel where security events are logged")
      .addChannelOption((opt) =>
        opt.setName("channel").setDescription("The log channel").setRequired(true)
      )
  )

  .addSubcommandGroup((group) =>
    group
      .setName("antispam")
      .setDescription("Configure the Anti-Spam module")

      .addSubcommand((sub) => sub.setName("enable").setDescription("Enable Anti-Spam"))
      .addSubcommand((sub) => sub.setName("disable").setDescription("Disable Anti-Spam"))
      .addSubcommand((sub) => sub.setName("status").setDescription("Show Anti-Spam configuration and live stats"))

      .addSubcommand((sub) =>
        sub
          .setName("config")
          .setDescription("Update Anti-Spam thresholds and action")
          .addIntegerOption((opt) =>
            opt.setName("threshold").setDescription("Max messages allowed in the window (default 5)").setMinValue(2).setMaxValue(100).setRequired(false)
          )
          .addIntegerOption((opt) =>
            opt.setName("window").setDescription("Time window in seconds (default 5)").setMinValue(1).setMaxValue(60).setRequired(false)
          )
          .addStringOption((opt) =>
            opt
              .setName("action")
              .setDescription("Punishment when spam is detected")
              .setRequired(false)
              .addChoices(
                { name: "⚠️ Warn (DM + escalate on threshold)", value: "warn" },
                { name: "⏱️ Timeout", value: "timeout" },
                { name: "⚖️ God's Judgment", value: "judgment" }
              )
          )
          .addIntegerOption((opt) =>
            opt.setName("timeout-duration").setDescription("Timeout duration in minutes (default 5)").setMinValue(1).setMaxValue(1440).setRequired(false)
          )
          .addIntegerOption((opt) =>
            opt.setName("warn-threshold").setDescription("Warnings before escalating to God's Judgment (default 3)").setMinValue(1).setMaxValue(20).setRequired(false)
          )
      )

      .addSubcommand((sub) =>
        sub
          .setName("bypass-add")
          .setDescription("Add a role or user to the Anti-Spam whitelist")
          .addRoleOption((opt) => opt.setName("role").setDescription("Role to whitelist").setRequired(false))
          .addUserOption((opt) => opt.setName("user").setDescription("User to whitelist").setRequired(false))
      )

      .addSubcommand((sub) =>
        sub
          .setName("bypass-remove")
          .setDescription("Remove a role or user from the Anti-Spam whitelist")
          .addRoleOption((opt) => opt.setName("role").setDescription("Role to remove").setRequired(false))
          .addUserOption((opt) => opt.setName("user").setDescription("User to remove").setRequired(false))
      )
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
    return;
  }

  const guildId = interaction.guildId;
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand();

  if (group === "antispam") {
    switch (sub) {
      case "enable":        return handleAntiSpamEnable(interaction, guildId);
      case "disable":       return handleAntiSpamDisable(interaction, guildId);
      case "status":        return handleAntiSpamStatus(interaction, guildId);
      case "config":        return handleAntiSpamConfig(interaction, guildId);
      case "bypass-add":    return handleBypassAdd(interaction, guildId);
      case "bypass-remove": return handleBypassRemove(interaction, guildId);
    }
    return;
  }

  switch (sub) {
    case "status":  return handleGlobalStatus(interaction, guildId);
    case "enable":  return handleModuleEnable(interaction, guildId);
    case "disable": return handleModuleDisable(interaction, guildId);
    case "setlog":  return handleSetLog(interaction, guildId);
  }
}

async function handleGlobalStatus(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const config = securityManager.getConfig(guildId);
  const status = securityManager.getModuleStatus(guildId);

  const moduleFields = (Object.entries(status) as [ModuleKey, boolean][]).map(([key, enabled]) => ({
    name: MODULE_LABELS[key],
    value: enabled ? "🟢 Enabled" : "🔴 Disabled",
    inline: true,
  }));

  const embed = new EmbedBuilder()
    .setTitle("🛡️ Security Configuration")
    .setColor(0x5865f2)
    .addFields(
      { name: "Log Channel", value: config.logChannelId ? `<#${config.logChannelId}>` : "Not set — use `/security setlog`", inline: false },
      { name: "Exempt Roles", value: config.exemptRoles.length > 0 ? config.exemptRoles.map((r) => `<@&${r}>`).join(", ") : "None", inline: false },
      { name: "\u200b", value: "**Modules**", inline: false },
      ...moduleFields
    )
    .setFooter({ text: `Updated: ${new Date(config.updatedAt).toLocaleString()}` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleModuleEnable(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const module = interaction.options.getString("module", true) as ModuleKey;
  await securityManager.setModuleEnabled(guildId, module, true);
  await interaction.reply({ embeds: [card(`✅ **${MODULE_LABELS[module]}** has been **enabled**.`, 0x57f287)], ephemeral: true });
}

async function handleModuleDisable(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const module = interaction.options.getString("module", true) as ModuleKey;
  await securityManager.setModuleEnabled(guildId, module, false);
  await interaction.reply({ embeds: [card(`🔴 **${MODULE_LABELS[module]}** has been **disabled**.`, 0xed4245)], ephemeral: true });
}

async function handleSetLog(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const channel = interaction.options.getChannel("channel", true);
  await securityManager.updateConfig(guildId, { logChannelId: channel.id });
  await interaction.reply({ embeds: [card(`📋 Security log channel set to <#${channel.id}>.`, 0x57f287)], ephemeral: true });
}

async function handleAntiSpamEnable(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  await securityManager.setModuleEnabled(guildId, "antiSpam", true);
  logger.info(`security antispam enable: enabled in guild ${guildId}`);
  await interaction.reply({ embeds: [card("✅ **Anti-Spam** is now **enabled**.", 0x57f287)], ephemeral: true });
}

async function handleAntiSpamDisable(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  await securityManager.setModuleEnabled(guildId, "antiSpam", false);
  logger.info(`security antispam disable: disabled in guild ${guildId}`);
  await interaction.reply({ embeds: [card("🔴 **Anti-Spam** is now **disabled**.", 0xed4245)], ephemeral: true });
}

async function handleAntiSpamStatus(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const cfg = securityManager.getConfig(guildId).antiSpam;
  const antiSpam = securityManager.getModule<AntiSpam>("antiSpam");
  const trackedUsers = antiSpam?.getTrackedUserCount(guildId) ?? 0;

  const embed = new EmbedBuilder()
    .setTitle("🔫 Anti-Spam Status")
    .setColor(cfg.enabled ? 0x57f287 : 0xed4245)
    .addFields(
      { name: "Status", value: cfg.enabled ? "🟢 Enabled" : "🔴 Disabled", inline: true },
      { name: "Action", value: ACTION_LABELS[cfg.action], inline: true },
      { name: "Live Tracked Users", value: trackedUsers.toString(), inline: true },
      { name: "Rate Limit", value: `${cfg.maxMessages} messages / ${cfg.timeWindowMs / 1_000}s`, inline: true },
      { name: cfg.action === "warn" ? "Warn → Escalate After" : "Warn Threshold", value: `${cfg.warnThreshold} warnings`, inline: true },
      { name: "Timeout Duration", value: cfg.action === "timeout" ? `${Math.round(cfg.timeoutDurationMs / 60_000)} minutes` : "N/A", inline: true },
      { name: `Bypass Roles (${cfg.bypassRoles.length})`, value: cfg.bypassRoles.length > 0 ? cfg.bypassRoles.map((r) => `<@&${r}>`).join(", ") : "None", inline: false },
      { name: `Bypass Users (${cfg.bypassUsers.length})`, value: cfg.bypassUsers.length > 0 ? cfg.bypassUsers.map((u) => `<@${u}>`).join(", ") : "None", inline: false }
    )
    .setFooter({ text: "Server owner and Administrators are always exempt." })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleAntiSpamConfig(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const threshold = interaction.options.getInteger("threshold");
  const window = interaction.options.getInteger("window");
  const action = interaction.options.getString("action") as AntiSpamAction | null;
  const timeoutMin = interaction.options.getInteger("timeout-duration");
  const warnThreshold = interaction.options.getInteger("warn-threshold");

  if (!threshold && !window && !action && !timeoutMin && !warnThreshold) {
    await interaction.reply({ content: "Provide at least one option to update.", ephemeral: true });
    return;
  }

  const current = securityManager.getConfig(guildId).antiSpam;
  const patch: Partial<typeof current> = {};
  const lines: string[] = [];

  if (threshold !== null)    { patch.maxMessages = threshold;                 lines.push(`• Rate limit: **${threshold}** messages`); }
  if (window !== null)       { patch.timeWindowMs = window * 1_000;           lines.push(`• Time window: **${window}s**`); }
  if (action !== null)       { patch.action = action;                         lines.push(`• Action: **${ACTION_LABELS[action]}**`); }
  if (timeoutMin !== null)   { patch.timeoutDurationMs = timeoutMin * 60_000; lines.push(`• Timeout duration: **${timeoutMin} min**`); }
  if (warnThreshold !== null){ patch.warnThreshold = warnThreshold;           lines.push(`• Warn threshold: **${warnThreshold}** warnings`); }

  await securityManager.updateModuleConfig(guildId, "antiSpam", patch);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle("✅ Anti-Spam Configuration Updated")
        .setColor(0x57f287)
        .setDescription(lines.join("\n"))
        .setTimestamp(),
    ],
    ephemeral: true,
  });
}

async function handleBypassAdd(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const role = interaction.options.getRole("role");
  const user = interaction.options.getUser("user");

  if (!role && !user) {
    await interaction.reply({ content: "Provide a role or user to whitelist.", ephemeral: true });
    return;
  }

  const current = securityManager.getConfig(guildId).antiSpam;
  const patch: Partial<typeof current> = {};
  const lines: string[] = [];

  if (role && !current.bypassRoles.includes(role.id)) {
    patch.bypassRoles = [...current.bypassRoles, role.id];
    lines.push(`• Role added: <@&${role.id}>`);
  } else if (role) lines.push(`• Role <@&${role.id}> is already whitelisted`);

  if (user && !current.bypassUsers.includes(user.id)) {
    patch.bypassUsers = [...current.bypassUsers, user.id];
    lines.push(`• User added: <@${user.id}>`);
  } else if (user) lines.push(`• User <@${user.id}> is already whitelisted`);

  if (Object.keys(patch).length > 0) await securityManager.updateModuleConfig(guildId, "antiSpam", patch);

  await interaction.reply({
    embeds: [new EmbedBuilder().setTitle("✅ Bypass List Updated").setColor(0x57f287).setDescription(lines.join("\n")).setTimestamp()],
    ephemeral: true,
  });
}

async function handleBypassRemove(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const role = interaction.options.getRole("role");
  const user = interaction.options.getUser("user");

  if (!role && !user) {
    await interaction.reply({ content: "Provide a role or user to remove from the whitelist.", ephemeral: true });
    return;
  }

  const current = securityManager.getConfig(guildId).antiSpam;
  const patch: Partial<typeof current> = {};
  const lines: string[] = [];

  if (role) {
    if (current.bypassRoles.includes(role.id)) {
      patch.bypassRoles = current.bypassRoles.filter((id) => id !== role.id);
      lines.push(`• Role removed: <@&${role.id}>`);
    } else lines.push(`• Role <@&${role.id}> was not in the whitelist`);
  }

  if (user) {
    if (current.bypassUsers.includes(user.id)) {
      patch.bypassUsers = current.bypassUsers.filter((id) => id !== user.id);
      lines.push(`• User removed: <@${user.id}>`);
    } else lines.push(`• User <@${user.id}> was not in the whitelist`);
  }

  if (Object.keys(patch).length > 0) await securityManager.updateModuleConfig(guildId, "antiSpam", patch);

  await interaction.reply({
    embeds: [new EmbedBuilder().setTitle("🔴 Bypass List Updated").setColor(0xed4245).setDescription(lines.join("\n")).setTimestamp()],
    ephemeral: true,
  });
}

function card(description: string, color: number): EmbedBuilder {
  return new EmbedBuilder().setDescription(description).setColor(color).setTimestamp();
}
