import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { AntiSpamAction, ModuleKey } from "../security/types.js";
import { securityManager } from "../lib/registry.js";
import type { AntiSpam } from "../security/modules/AntiSpam.js";
import {
  isValidConfiguredWord,
  normalizeConfiguredWord,
} from "../security/modules/BadWordProtection.js";
import { logger } from "../lib/logger.js";
import {
  arrowLine,
  createGodsEmbed,
  GODS_EMOJI,
  GOLDEN_ARROW,
} from "./ui.js";
import type { EmbedTone } from "./ui.js";

const MODULE_LABELS: Record<ModuleKey, string> = {
  antiSpam: "Anti-Spam",
  antiMention: "Anti-Mention",
  antiLink: "Anti-Link",
  antiInvite: "Anti-Invite",
  antiRaid: "Anti-Raid",
  badWord: "Bad Word Protection",
  godsJudgment: "God's Judgment",
};

const MODULE_EMOJIS: Record<ModuleKey, string> = {
  antiSpam: GODS_EMOJI.security,
  antiMention: GODS_EMOJI.antiMention,
  antiLink: GODS_EMOJI.antiLink,
  antiInvite: GODS_EMOJI.antiInvite,
  antiRaid: GODS_EMOJI.security,
  badWord: GODS_EMOJI.badWord,
  godsJudgment: GODS_EMOJI.judgment,
};

const MODULE_CHOICES = (Object.keys(MODULE_LABELS) as ModuleKey[])
  .filter((key) => key !== "badWord")
  .map((key) => ({ name: MODULE_LABELS[key], value: key }));

export const data = new SlashCommandBuilder()
  .setName("security")
  .setDescription("Manage God's Bot security settings")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)

  .addSubcommandGroup((group) =>
    group
      .setName("general")
      .setDescription("Configure global security settings")
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
      .addSubcommand((sub) =>
        sub
          .setName("exempt-add")
          .setDescription("Add a Heat Exception Role")
          .addRoleOption((opt) =>
            opt.setName("role").setDescription("Role exempt from Heat").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("exempt-remove")
          .setDescription("Remove a Heat Exception Role")
          .addRoleOption((opt) =>
            opt.setName("role").setDescription("Role to remove from Heat exceptions").setRequired(true)
          )
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
          .setDescription("Update the Anti-Spam trigger thresholds")
          .addIntegerOption((opt) =>
            opt.setName("threshold").setDescription("Max messages allowed in the window (default 5)").setMinValue(2).setMaxValue(100).setRequired(false)
          )
          .addIntegerOption((opt) =>
            opt.setName("window").setDescription("Time window in seconds (default 5)").setMinValue(1).setMaxValue(60).setRequired(false)
          )
      )

      .addSubcommand((sub) =>
        sub
          .setName("bypass-add")
          .setDescription("Add an Anti-Spam exception role or user")
          .addRoleOption((opt) => opt.setName("role").setDescription("Role ignored by Anti-Spam").setRequired(false))
          .addUserOption((opt) => opt.setName("user").setDescription("User to whitelist").setRequired(false))
      )

      .addSubcommand((sub) =>
        sub
          .setName("bypass-remove")
          .setDescription("Remove an Anti-Spam exception role or user")
          .addRoleOption((opt) => opt.setName("role").setDescription("Role to stop ignoring").setRequired(false))
          .addUserOption((opt) => opt.setName("user").setDescription("User to remove").setRequired(false))
      )
  )

  .addSubcommandGroup((group) =>
    group
      .setName("antilink")
      .setDescription("Configure the Anti-Link module")
      .addSubcommand((sub) =>
        sub
          .setName("bypass-add")
          .setDescription("Add an Anti-Link exception role")
          .addRoleOption((opt) =>
            opt.setName("role").setDescription("Role ignored by Anti-Link").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("bypass-remove")
          .setDescription("Remove an Anti-Link exception role")
          .addRoleOption((opt) =>
            opt.setName("role").setDescription("Role to stop ignoring").setRequired(true)
          )
      )
  )

  .addSubcommandGroup((group) =>
    group
      .setName("badword")
      .setDescription("Configure Bad Word Protection")
      .addSubcommand((sub) =>
        sub
          .setName("add")
          .setDescription("Add a bad word to the guild list")
          .addStringOption((opt) =>
            opt.setName("word").setDescription("Word or phrase to detect").setRequired(true).setMaxLength(100)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("remove")
          .setDescription("Remove a bad word from the guild list")
          .addStringOption((opt) =>
            opt.setName("word").setDescription("Word or phrase to remove").setRequired(true).setMaxLength(100)
          )
      )
      .addSubcommand((sub) =>
        sub.setName("list").setDescription("Show the configured bad words")
      )
      .addSubcommand((sub) =>
        sub
          .setName("exception-add")
          .setDescription("Add a Bad Word Exception Role")
          .addRoleOption((opt) =>
            opt.setName("role").setDescription("Role ignored by Bad Word Protection").setRequired(true)
          )
      )
      .addSubcommand((sub) =>
        sub
          .setName("exception-remove")
          .setDescription("Remove a Bad Word Exception Role")
          .addRoleOption((opt) =>
            opt.setName("role").setDescription("Role to stop ignoring").setRequired(true)
          )
      )
  );

export async function execute(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Server Required",
          description: "Run Security commands inside the server you want to configure.",
          emoji: GODS_EMOJI.security,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
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
      default:              return handleUnknownSecuritySubcommand(interaction);
    }
  }

  if (group === "antilink") {
    switch (sub) {
      case "bypass-add": return handleAntiLinkBypassAdd(interaction, guildId);
      case "bypass-remove": return handleAntiLinkBypassRemove(interaction, guildId);
      default: return handleUnknownSecuritySubcommand(interaction);
    }
  }

  if (group === "badword") {
    switch (sub) {
      case "add": return handleBadWordAdd(interaction, guildId);
      case "remove": return handleBadWordRemove(interaction, guildId);
      case "list": return handleBadWordList(interaction, guildId);
      case "exception-add": return handleBadWordExceptionAdd(interaction, guildId);
      case "exception-remove": return handleBadWordExceptionRemove(interaction, guildId);
      default: return handleUnknownSecuritySubcommand(interaction);
    }
  }

  if (group === "general") {
    switch (sub) {
      case "status":  return handleGlobalStatus(interaction, guildId);
      case "enable":  return handleModuleEnable(interaction, guildId);
      case "disable": return handleModuleDisable(interaction, guildId);
      case "setlog":  return handleSetLog(interaction, guildId);
      case "exempt-add": return handleExemptRoleAdd(interaction, guildId);
      case "exempt-remove": return handleExemptRoleRemove(interaction, guildId);
      default: return handleUnknownSecuritySubcommand(interaction);
    }
  }

  return handleUnknownSecuritySubcommand(interaction);
}

async function handleGlobalStatus(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const config = securityManager.getConfig(guildId);
  const status = securityManager.getModuleStatus(guildId);

  const moduleLines = (Object.entries(status) as [ModuleKey, boolean][]).map(
    ([key, enabled]) =>
      `${GOLDEN_ARROW} ${MODULE_EMOJIS[key]} **${MODULE_LABELS[key]}:** ${enabled ? "Enabled" : "Disabled"}`
  );

  const embed = createGodsEmbed({
    title: "Security Overview",
    emoji: GODS_EMOJI.security,
    tone: "info",
    description: "Current protection settings and module status for this server.",
  })
    .addFields(
      {
        name: "Security Log Channel",
        value: config.logChannelId
          ? arrowLine("Destination", `<#${config.logChannelId}>`)
          : `Not set.\n${arrowLine("Set one", "`/security general setlog #channel`")}`,
        inline: false,
      },
      {
        name: `Heat Exception Roles (${config.exemptRoles.length})`,
        value: config.exemptRoles.length > 0
          ? config.exemptRoles.map((roleId) => arrowLine("Role", `<@&${roleId}>`)).join("\n")
          : "None configured.",
        inline: false,
      },
      {
        name: "Protection Modules",
        value: moduleLines.join("\n"),
        inline: false,
      },
      {
        name: "Last Updated",
        value: arrowLine("Updated", new Date(config.updatedAt).toLocaleString()),
        inline: false,
      },
    )

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleModuleEnable(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const module = interaction.options.getString("module", true) as ModuleKey;
  await securityManager.setModuleEnabled(guildId, module, true);
  await interaction.reply({
    embeds: [
      securityCard(
        "Protection Enabled",
        `${arrowLine("Module", MODULE_LABELS[module])}\n${arrowLine("Status", "Enabled")}`,
        "success",
        MODULE_EMOJIS[module],
      ),
    ],
    ephemeral: true,
  });
}

async function handleModuleDisable(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const module = interaction.options.getString("module", true) as ModuleKey;
  await securityManager.setModuleEnabled(guildId, module, false);
  await interaction.reply({
    embeds: [
      securityCard(
        "Protection Disabled",
        `${arrowLine("Module", MODULE_LABELS[module])}\n${arrowLine("Status", "Disabled")}`,
        "warning",
        MODULE_EMOJIS[module],
      ),
    ],
    ephemeral: true,
  });
}

async function handleSetLog(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const channel = interaction.options.getChannel("channel", true);
  await securityManager.updateConfig(guildId, { logChannelId: channel.id });
  await interaction.reply({
    embeds: [
      securityCard(
        "Security Log Destination Updated",
        arrowLine("Channel", `<#${channel.id}>`),
        "success",
        GODS_EMOJI.security,
      ),
    ],
    ephemeral: true,
  });
}

async function handleUnknownSecuritySubcommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({
    embeds: [
      securityCard(
        "Security Action Unavailable",
        [
          "Select an available Security option from the slash-command menu.",
          "",
          arrowLine("Heat exceptions", "Use `/security general exempt-add` or `/security general exempt-remove`."),
        ].join("\n"),
        "error",
      ),
    ],
    ephemeral: true,
  });
}

async function handleExemptRoleAdd(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const role = interaction.options.getRole("role", true);
  const current = securityManager.getConfig(guildId).exemptRoles;

  if (current.includes(role.id)) {
    await interaction.editReply({
      embeds: [
        securityCard(
          "Role Already Exempt",
          arrowLine("Role", `<@&${role.id}> is already a Heat Exception Role.`),
          "info",
          GODS_EMOJI.heat,
        ),
      ],
    });
    return;
  }

  await securityManager.updateConfig(guildId, {
    exemptRoles: [...current, role.id],
  });
  await interaction.editReply({
    embeds: [
      securityCard(
        "Heat Exception Role Added",
        arrowLine("Role", `<@&${role.id}> is now exempt from Heat.`),
        "success",
        GODS_EMOJI.heat,
      ),
    ],
  });
}

async function handleExemptRoleRemove(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const role = interaction.options.getRole("role", true);
  const current = securityManager.getConfig(guildId).exemptRoles;

  if (!current.includes(role.id)) {
    await interaction.editReply({
      embeds: [
        securityCard(
          "Role Not Configured",
          arrowLine("Role", `<@&${role.id}> is not a Heat Exception Role.`),
          "info",
          GODS_EMOJI.heat,
        ),
      ],
    });
    return;
  }

  await securityManager.updateConfig(guildId, {
    exemptRoles: current.filter((roleId) => roleId !== role.id),
  });
  await interaction.editReply({
    embeds: [
      securityCard(
        "Heat Exception Role Removed",
        arrowLine("Role", `<@&${role.id}> is no longer exempt from Heat.`),
        "success",
        GODS_EMOJI.heat,
      ),
    ],
  });
}

async function handleAntiSpamEnable(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  await securityManager.setModuleEnabled(guildId, "antiSpam", true);
  logger.info(`security antispam enable: enabled in guild ${guildId}`);
  await interaction.reply({
    embeds: [
      securityCard(
        "Anti-Spam Enabled",
        arrowLine("Status", "Anti-Spam is now enabled."),
        "success",
        GODS_EMOJI.security,
      ),
    ],
    ephemeral: true,
  });
}

async function handleAntiSpamDisable(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  await securityManager.setModuleEnabled(guildId, "antiSpam", false);
  logger.info(`security antispam disable: disabled in guild ${guildId}`);
  await interaction.reply({
    embeds: [
      securityCard(
        "Anti-Spam Disabled",
        arrowLine("Status", "Anti-Spam is now disabled."),
        "warning",
        GODS_EMOJI.security,
      ),
    ],
    ephemeral: true,
  });
}

async function handleAntiSpamStatus(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const cfg = securityManager.getConfig(guildId).antiSpam;
  const antiSpam = securityManager.getModule<AntiSpam>("antiSpam");
  const trackedUsers = antiSpam?.getTrackedUserCount(guildId) ?? 0;

  const embed = createGodsEmbed({
    title: "Anti-Spam Status",
    emoji: GODS_EMOJI.security,
    tone: cfg.enabled ? "success" : "warning",
    description: [
      arrowLine("Status", cfg.enabled ? "Enabled" : "Disabled"),
      arrowLine("Tracking", `${trackedUsers.toLocaleString()} users currently tracked`),
    ].join("\n"),
  })
    .addFields(
      {
        name: "Detection Settings",
        value: [
          arrowLine("Rate limit", `${cfg.maxMessages} messages / ${cfg.timeWindowMs / 1_000}s`),
          arrowLine("Punishment model", "Fixed progression by confirmed violation count"),
        ].join("\n"),
        inline: false,
      },
      {
        name: "Punishment Progression",
        value: [
          arrowLine("Violations 1–2", "Warn"),
          arrowLine("Violations 3–4", "10m"),
          arrowLine("Violations 5–6", "30m"),
          arrowLine("Violations 7–8", "1h"),
          arrowLine("Violation 9", "6h"),
          arrowLine("Violation 10", "God's Judgment"),
        ].join("\n"),
        inline: false,
      },
      {
        name: `Exception Roles (${cfg.bypassRoles.length})`,
        value: cfg.bypassRoles.length > 0
          ? cfg.bypassRoles.map((roleId) => arrowLine("Role", `<@&${roleId}>`)).join("\n")
          : "None configured.",
        inline: false,
      },
      {
        name: `Bypass Users (${cfg.bypassUsers.length})`,
        value: cfg.bypassUsers.length > 0
          ? cfg.bypassUsers.map((userId) => arrowLine("User", `<@${userId}>`)).join("\n")
          : "None configured.",
        inline: false,
      },
      {
        name: "Always Exempt",
        value: "The server owner and Administrators are always exempt.",
        inline: false,
      },
    );

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleAntiSpamConfig(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const threshold = interaction.options.getInteger("threshold");
  const window = interaction.options.getInteger("window");

  if (threshold === null && window === null) {
    await interaction.reply({
      embeds: [
        securityCard(
          "No Settings Changed",
          "Provide at least one setting to update: `threshold`, `window`, or both.",
          "error",
          GODS_EMOJI.security,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  const current = securityManager.getConfig(guildId).antiSpam;
  const patch: Partial<typeof current> = {};
  const lines: string[] = [];

  if (threshold !== null)    { patch.maxMessages = threshold;                 lines.push(arrowLine("Rate limit", `${threshold} messages`)); }
  if (window !== null)       { patch.timeWindowMs = window * 1_000;           lines.push(arrowLine("Time window", `${window}s`)); }

  await securityManager.updateModuleConfig(guildId, "antiSpam", patch);

  await interaction.reply({
    embeds: [
      securityCard(
        "Anti-Spam Settings Updated",
        lines.join("\n"),
        "success",
        GODS_EMOJI.security,
      ),
    ],
    ephemeral: true,
  });
}

async function handleBypassAdd(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const role = interaction.options.getRole("role");
  const user = interaction.options.getUser("user");

  if (!role && !user) {
    await interaction.reply({
      embeds: [
        securityCard(
          "Role or User Required",
          "Select a role, a user, or both to add to the Anti-Spam bypass list.",
          "error",
          GODS_EMOJI.security,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  const current = securityManager.getConfig(guildId).antiSpam;
  const patch: Partial<typeof current> = {};
  const lines: string[] = [];

  if (role && !current.bypassRoles.includes(role.id)) {
    patch.bypassRoles = [...current.bypassRoles, role.id];
    lines.push(arrowLine("Role added", `<@&${role.id}>`));
  } else if (role) lines.push(arrowLine("Already bypassed", `<@&${role.id}>`));

  if (user && !current.bypassUsers.includes(user.id)) {
    patch.bypassUsers = [...current.bypassUsers, user.id];
    lines.push(arrowLine("User added", `<@${user.id}>`));
  } else if (user) lines.push(arrowLine("Already bypassed", `<@${user.id}>`));

  const changed = Object.keys(patch).length > 0;
  if (changed) await securityManager.updateModuleConfig(guildId, "antiSpam", patch);

  await interaction.reply({
    embeds: [
      securityCard(
        changed ? "Bypass List Updated" : "Bypass Already Set",
        lines.join("\n"),
        changed ? "success" : "info",
        GODS_EMOJI.security,
      ),
    ],
    ephemeral: true,
  });
}

async function handleBypassRemove(interaction: ChatInputCommandInteraction, guildId: string): Promise<void> {
  const role = interaction.options.getRole("role");
  const user = interaction.options.getUser("user");

  if (!role && !user) {
    await interaction.reply({
      embeds: [
        securityCard(
          "Role or User Required",
          "Select a role, a user, or both to remove from the Anti-Spam bypass list.",
          "error",
          GODS_EMOJI.security,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  const current = securityManager.getConfig(guildId).antiSpam;
  const patch: Partial<typeof current> = {};
  const lines: string[] = [];

  if (role) {
    if (current.bypassRoles.includes(role.id)) {
      patch.bypassRoles = current.bypassRoles.filter((id) => id !== role.id);
      lines.push(arrowLine("Role removed", `<@&${role.id}>`));
    } else lines.push(arrowLine("Not bypassed", `<@&${role.id}>`));
  }

  if (user) {
    if (current.bypassUsers.includes(user.id)) {
      patch.bypassUsers = current.bypassUsers.filter((id) => id !== user.id);
      lines.push(arrowLine("User removed", `<@${user.id}>`));
    } else lines.push(arrowLine("Not bypassed", `<@${user.id}>`));
  }

  const changed = Object.keys(patch).length > 0;
  if (changed) await securityManager.updateModuleConfig(guildId, "antiSpam", patch);

  await interaction.reply({
    embeds: [
      securityCard(
        changed ? "Bypass List Updated" : "Bypass Already Clear",
        lines.join("\n"),
        changed ? "success" : "info",
        GODS_EMOJI.security,
      ),
    ],
    ephemeral: true,
  });
}

async function handleAntiLinkBypassAdd(
  interaction: ChatInputCommandInteraction,
  guildId: string
): Promise<void> {
  const role = interaction.options.getRole("role", true);
  const current = securityManager.getConfig(guildId).antiLink.bypassRoles;

  if (current.includes(role.id)) {
    await interaction.reply({
      embeds: [
        securityCard(
          "Role Already Exempt",
          arrowLine("Role", `<@&${role.id}> is already an Anti-Link exception role.`),
          "info",
          GODS_EMOJI.antiLink,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  await securityManager.updateModuleConfig(guildId, "antiLink", {
    bypassRoles: [...current, role.id],
  });
  await interaction.reply({
    embeds: [
      securityCard(
        "Anti-Link Exception Added",
        arrowLine("Role", `<@&${role.id}> is now exempt from Anti-Link protection.`),
        "success",
        GODS_EMOJI.antiLink,
      ),
    ],
    ephemeral: true,
  });
}

async function handleAntiLinkBypassRemove(
  interaction: ChatInputCommandInteraction,
  guildId: string
): Promise<void> {
  const role = interaction.options.getRole("role", true);
  const current = securityManager.getConfig(guildId).antiLink.bypassRoles;

  if (!current.includes(role.id)) {
    await interaction.reply({
      embeds: [
        securityCard(
          "Role Not Configured",
          arrowLine("Role", `<@&${role.id}> is not an Anti-Link exception role.`),
          "info",
          GODS_EMOJI.antiLink,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  await securityManager.updateModuleConfig(guildId, "antiLink", {
    bypassRoles: current.filter((roleId) => roleId !== role.id),
  });
  await interaction.reply({
    embeds: [
      securityCard(
        "Anti-Link Exception Removed",
        arrowLine("Role", `<@&${role.id}> is no longer exempt from Anti-Link protection.`),
        "success",
        GODS_EMOJI.antiLink,
      ),
    ],
    ephemeral: true,
  });
}

async function handleBadWordAdd(
  interaction: ChatInputCommandInteraction,
  guildId: string
): Promise<void> {
  const word = normalizeConfiguredWord(interaction.options.getString("word", true));
  if (!word || !isValidConfiguredWord(word)) {
    await interaction.reply({
      embeds: [
        securityCard(
          "Word Not Added",
          "Enter a word or phrase containing at least one letter or number.",
          "error",
          GODS_EMOJI.badWord,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  const current = securityManager.getConfig(guildId).badWord.words;
  if (current.includes(word)) {
    await interaction.reply({
      embeds: [
        securityCard(
          "Word Already Configured",
          arrowLine("Word", `\`${word}\` is already in Bad Word Protection.`),
          "info",
          GODS_EMOJI.badWord,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  await securityManager.updateModuleConfig(guildId, "badWord", {
    words: [...current, word],
  });
  await interaction.reply({
    embeds: [
      securityCard(
        "Word Added",
        arrowLine("Configured word", `\`${word}\``),
        "success",
        GODS_EMOJI.badWord,
      ),
    ],
    ephemeral: true,
  });
}

async function handleBadWordRemove(
  interaction: ChatInputCommandInteraction,
  guildId: string
): Promise<void> {
  const word = normalizeConfiguredWord(interaction.options.getString("word", true));
  const current = securityManager.getConfig(guildId).badWord.words;
  if (!current.includes(word)) {
    await interaction.reply({
      embeds: [
        securityCard(
          "Word Not Found",
          arrowLine("Configured word", `\`${word}\` is not in Bad Word Protection.`),
          "info",
          GODS_EMOJI.badWord,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  await securityManager.updateModuleConfig(guildId, "badWord", {
    words: current.filter((configuredWord) => configuredWord !== word),
  });
  await interaction.reply({
    embeds: [
      securityCard(
        "Word Removed",
        arrowLine("Removed word", `\`${word}\``),
        "success",
        GODS_EMOJI.badWord,
      ),
    ],
    ephemeral: true,
  });
}

async function handleBadWordList(
  interaction: ChatInputCommandInteraction,
  guildId: string
): Promise<void> {
  const config = securityManager.getConfig(guildId).badWord;
  const words = config.words.length > 0
    ? config.words.map((word, index) => `${GOLDEN_ARROW} ${index + 1}. \`${word}\``).join("\n")
    : "No bad words configured.";
  const roleList = config.exceptionRoles.length > 0
    ? config.exceptionRoles.map((roleId) => arrowLine("Role", `<@&${roleId}>`)).join("\n")
    : "None configured.";

  const embed = createGodsEmbed({
    title: "Bad Word Protection",
    emoji: GODS_EMOJI.badWord,
    tone: config.words.length > 0 ? "info" : "warning",
    description: "Configured words and roles exempt from detection.",
  })
    .addFields(
      {
        name: `Configured Words (${config.words.length})`,
        value: words.slice(0, 1_024),
        inline: false,
      },
      {
        name: `Exception Roles (${config.exceptionRoles.length})`,
        value: roleList.slice(0, 1_024),
        inline: false,
      },
    );

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleBadWordExceptionAdd(
  interaction: ChatInputCommandInteraction,
  guildId: string
): Promise<void> {
  const role = interaction.options.getRole("role", true);
  const current = securityManager.getConfig(guildId).badWord.exceptionRoles;
  if (current.includes(role.id)) {
    await interaction.reply({
      embeds: [
        securityCard(
          "Role Already Exempt",
          arrowLine("Role", `<@&${role.id}> is already a Bad Word Exception Role.`),
          "info",
          GODS_EMOJI.badWord,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  await securityManager.updateModuleConfig(guildId, "badWord", {
    exceptionRoles: [...current, role.id],
  });
  await interaction.reply({
    embeds: [
      securityCard(
        "Bad Word Exception Added",
        arrowLine("Role", `<@&${role.id}> is now exempt from Bad Word Protection.`),
        "success",
        GODS_EMOJI.badWord,
      ),
    ],
    ephemeral: true,
  });
}

async function handleBadWordExceptionRemove(
  interaction: ChatInputCommandInteraction,
  guildId: string
): Promise<void> {
  const role = interaction.options.getRole("role", true);
  const current = securityManager.getConfig(guildId).badWord.exceptionRoles;
  if (!current.includes(role.id)) {
    await interaction.reply({
      embeds: [
        securityCard(
          "Role Not Configured",
          arrowLine("Role", `<@&${role.id}> is not a Bad Word Exception Role.`),
          "info",
          GODS_EMOJI.badWord,
        ),
      ],
      ephemeral: true,
    });
    return;
  }

  await securityManager.updateModuleConfig(guildId, "badWord", {
    exceptionRoles: current.filter((roleId) => roleId !== role.id),
  });
  await interaction.reply({
    embeds: [
      securityCard(
        "Bad Word Exception Removed",
        arrowLine("Role", `<@&${role.id}> is no longer exempt from Bad Word Protection.`),
        "success",
        GODS_EMOJI.badWord,
      ),
    ],
    ephemeral: true,
  });
}

function securityCard(
  title: string,
  description: string,
  tone: EmbedTone,
  emoji: string = GODS_EMOJI.security,
): EmbedBuilder {
  return createGodsEmbed({ title, description, tone, emoji });
}
