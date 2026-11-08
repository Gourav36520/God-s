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
      .setDescription("Show logging configuration — channels, categories, and effective routing")
  )

  .addSubcommand((sub) =>
    sub
      .setName("setchannel")
      .setDescription("Set a log channel — optionally scoped to a single category")
      .addChannelOption((opt) =>
        opt
          .setName("channel")
          .setDescription("The channel to send logs to")
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt
          .setName("category")
          .setDescription("Category to set (leave blank to set the global default channel)")
          .setRequired(false)
          .addChoices(...CATEGORY_CHOICES)
      )
  )

  .addSubcommand((sub) =>
    sub
      .setName("clearchannel")
      .setDescription("Remove a log channel override")
      .addStringOption((opt) =>
        opt
          .setName("category")
          .setDescription("Category to clear (leave blank to clear the global default channel)")
          .setRequired(false)
          .addChoices(...CATEGORY_CHOICES)
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
    sub.setName("enableall").setDescription("Enable all log categories at once")
  )

  .addSubcommand((sub) =>
    sub.setName("disableall").setDescription("Disable all log categories at once")
  );

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!interaction.guildId) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;

  switch (sub) {
    case "status":
      await handleStatus(interaction, guildId);
      break;

    case "setchannel":
      await handleSetChannel(interaction, guildId);
      break;

    case "clearchannel":
      await handleClearChannel(interaction, guildId);
      break;

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

    case "enableall":
      await setAllCategories(guildId, true);
      await interaction.reply({
        embeds: [card("✅ All log categories enabled.", 0x57f287)],
        ephemeral: true,
      });
      break;

    case "disableall":
      await setAllCategories(guildId, false);
      await interaction.reply({
        embeds: [card("🔴 All log categories disabled.", 0xed4245)],
        ephemeral: true,
      });
      break;
  }
}

// ─── Subcommand handlers ────────────────────────────────────────────────────

async function handleStatus(
  interaction: ChatInputCommandInteraction,
  guildId: string
): Promise<void> {
  const config = securityManager.getConfig(guildId);
  const { logging } = config;

  const globalChannelId = logging.channelId ?? config.logChannelId;

  const categoryFields = ALL_CATEGORIES.map((c) => {
    const perCategoryId = logging.channelIds?.[c];
    const effectiveId = perCategoryId ?? globalChannelId;
    const statusEmoji = logging.categories[c] ? "🟢" : "🔴";
    const channelText = effectiveId
      ? perCategoryId
        ? `<#${perCategoryId}> *(custom)*`
        : `<#${effectiveId}> *(global)*`
      : "— not set —";

    return {
      name: `${statusEmoji} ${LOG_CATEGORY_LABELS[c]}`,
      value: channelText,
      inline: true,
    };
  });

  const embed = new EmbedBuilder()
    .setTitle("📋 Logging Configuration")
    .setColor(0x5865f2)
    .addFields(
      {
        name: "Global Default Channel",
        value: globalChannelId
          ? `<#${globalChannelId}>`
          : "Not set — use `/logging setchannel #channel`",
        inline: false,
      },
      { name: "\u200b", value: "**Categories** — 🟢 On / 🔴 Off | channel (source)", inline: false },
      ...categoryFields
    )
    .setFooter({ text: "Use /logging setchannel #channel [category] to set per-category channels" })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleSetChannel(
  interaction: ChatInputCommandInteraction,
  guildId: string
): Promise<void> {
  const channel = interaction.options.getChannel("channel", true);
  const category = interaction.options.getString("category") as LogCategory | null;
  const config = securityManager.getConfig(guildId);

  if (category) {
    // Per-category channel
    const updatedChannelIds = {
      ...config.logging.channelIds,
      [category]: channel.id,
    };
    await securityManager.updateConfig(guildId, {
      logging: { ...config.logging, channelIds: updatedChannelIds },
    });
    await interaction.reply({
      embeds: [
        card(
          `📋 **${LOG_CATEGORY_LABELS[category]}** logs will now go to <#${channel.id}>.`,
          0x57f287
        ),
      ],
      ephemeral: true,
    });
  } else {
    // Global default channel
    await securityManager.updateConfig(guildId, {
      logChannelId: channel.id,
      logging: { ...config.logging, channelId: channel.id },
    });
    await interaction.reply({
      embeds: [
        card(
          `📋 Global log channel set to <#${channel.id}>.\nAll enabled categories without a specific channel will use this.`,
          0x57f287
        ),
      ],
      ephemeral: true,
    });
  }
}

async function handleClearChannel(
  interaction: ChatInputCommandInteraction,
  guildId: string
): Promise<void> {
  const category = interaction.options.getString("category") as LogCategory | null;
  const config = securityManager.getConfig(guildId);

  if (category) {
    const updatedChannelIds = { ...config.logging.channelIds };
    delete updatedChannelIds[category];
    await securityManager.updateConfig(guildId, {
      logging: { ...config.logging, channelIds: updatedChannelIds },
    });
    await interaction.reply({
      embeds: [
        card(
          `🗑️ **${LOG_CATEGORY_LABELS[category]}** channel override removed. It will now fall back to the global channel.`,
          0xe67e22
        ),
      ],
      ephemeral: true,
    });
  } else {
    await securityManager.updateConfig(guildId, {
      logChannelId: null,
      logging: { ...config.logging, channelId: null },
    });
    await interaction.reply({
      embeds: [card("🗑️ Global log channel cleared.", 0xe67e22)],
      ephemeral: true,
    });
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function toggleCategory(
  guildId: string,
  category: LogCategory,
  enabled: boolean
): Promise<void> {
  const config = securityManager.getConfig(guildId);
  await securityManager.updateConfig(guildId, {
    logging: {
      ...config.logging,
      categories: { ...config.logging.categories, [category]: enabled },
    },
  });
}

async function setAllCategories(guildId: string, enabled: boolean): Promise<void> {
  const config = securityManager.getConfig(guildId);
  const categories = Object.fromEntries(
    ALL_CATEGORIES.map((c) => [c, enabled])
  ) as Record<LogCategory, boolean>;
  await securityManager.updateConfig(guildId, {
    logging: { ...config.logging, categories },
  });
}

function card(description: string, color: number): EmbedBuilder {
  return new EmbedBuilder().setDescription(description).setColor(color).setTimestamp();
}
