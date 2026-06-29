import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { securityManager } from "../lib/registry.js";
import {
  ALL_CATEGORIES,
  LOG_CATEGORY_LABELS,
  type LogCategory,
} from "../logging/types.js";

const CATEGORY_CHOICES = ALL_CATEGORIES.map((c) => ({
  name: LOG_CATEGORY_LABELS[c],
  value: c,
}));

export const data = new SlashCommandBuilder()
  .setName("logging")
  .setDescription("Configure the logging system")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName("status")
      .setDescription("Show which log categories are enabled and the current log channel")
  )
  .addSubcommand((sub) =>
    sub
      .setName("setchannel")
      .setDescription("Set the channel where all log events are sent")
      .addChannelOption((opt) =>
        opt.setName("channel").setDescription("The log channel").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("enable")
      .setDescription("Enable a log category")
      .addStringOption((opt) =>
        opt
          .setName("category")
          .setDescription("The category to enable")
          .setRequired(true)
          .addChoices(...CATEGORY_CHOICES)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("disable")
      .setDescription("Disable a log category")
      .addStringOption((opt) =>
        opt
          .setName("category")
          .setDescription("The category to disable")
          .setRequired(true)
          .addChoices(...CATEGORY_CHOICES)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("enableall")
      .setDescription("Enable all log categories at once")
  )
  .addSubcommand((sub) =>
    sub
      .setName("disableall")
      .setDescription("Disable all log categories at once")
  );

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({ content: "This command can only be used in a server.", ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  switch (sub) {
    case "status": {
      await handleStatus(interaction, guildId);
      break;
    }

    case "setchannel": {
      const channel = interaction.options.getChannel("channel", true);
      const config = securityManager.getConfig(guildId);
      await securityManager.updateConfig(guildId, {
        logChannelId: channel.id,
        logging: { ...config.logging, channelId: channel.id },
      });
      await interaction.reply({
        embeds: [card(`📋 Log channel set to <#${channel.id}>.\nAll enabled categories will be sent there.`, 0x57f287)],
        ephemeral: true,
      });
      break;
    }

    case "enable": {
      const category = interaction.options.getString("category", true) as LogCategory;
      await toggleCategory(guildId, category, true);
      await interaction.reply({
        embeds: [card(`✅ **${LOG_CATEGORY_LABELS[category]}** logs enabled.`, 0x57f287)],
        ephemeral: true,
      });
      break;
    }

    case "disable": {
      const category = interaction.options.getString("category", true) as LogCategory;
      await toggleCategory(guildId, category, false);
      await interaction.reply({
        embeds: [card(`🔴 **${LOG_CATEGORY_LABELS[category]}** logs disabled.`, 0xed4245)],
        ephemeral: true,
      });
      break;
    }

    case "enableall": {
      await setAllCategories(guildId, true);
      await interaction.reply({
        embeds: [card("✅ All log categories enabled.", 0x57f287)],
        ephemeral: true,
      });
      break;
    }

    case "disableall": {
      await setAllCategories(guildId, false);
      await interaction.reply({
        embeds: [card("🔴 All log categories disabled.", 0xed4245)],
        ephemeral: true,
      });
      break;
    }
  }
}

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  guildId: string
): Promise<void> {
  const config = securityManager.getConfig(guildId);
  const { logging } = config;

  const channelId = logging.channelId ?? config.logChannelId;
  const categoryFields = ALL_CATEGORIES.map((c) => ({
    name: LOG_CATEGORY_LABELS[c],
    value: logging.categories[c] ? "🟢 On" : "🔴 Off",
    inline: true,
  }));

  const embed = new EmbedBuilder()
    .setTitle("📋 Logging Configuration")
    .setColor(0x5865f2)
    .addFields(
      {
        name: "Log Channel",
        value: channelId ? `<#${channelId}>` : "Not set — use `/logging setchannel`",
        inline: false,
      },
      { name: "\u200b", value: "**Categories**", inline: false },
      ...categoryFields
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function toggleCategory(guildId: string, category: LogCategory, enabled: boolean): Promise<void> {
  const config = securityManager.getConfig(guildId);
  await securityManager.updateConfig(guildId, {
    logging: { ...config.logging, categories: { ...config.logging.categories, [category]: enabled } },
  });
}

async function setAllCategories(guildId: string, enabled: boolean): Promise<void> {
  const config = securityManager.getConfig(guildId);
  const categories = Object.fromEntries(ALL_CATEGORIES.map((c) => [c, enabled])) as Record<LogCategory, boolean>;
  await securityManager.updateConfig(guildId, { logging: { ...config.logging, categories } });
}

function card(description: string, color: number): EmbedBuilder {
  return new EmbedBuilder().setDescription(description).setColor(color).setTimestamp();
}
