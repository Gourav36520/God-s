import {
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { securityManager } from "../lib/registry.js";
import {
  arrowLine,
  createGodsEmbed,
  GODS_EMOJI,
} from "./ui.js";

export const data = new SlashCommandBuilder()
  .setName("set")
  .setDescription("Configure server settings")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("prefix")
      .setDescription("Set the server's message prefix")
      .addStringOption((option) =>
        option
          .setName("prefix")
          .setDescription("The new message prefix")
          .setMinLength(1)
          .setMaxLength(5)
          .setRequired(true),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Server Required",
          description: "Run this setting from inside the server you want to update.",
          emoji: GODS_EMOJI.settings,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Administrator Permission Required",
          description: "Only a server Administrator can change the message prefix.",
          emoji: GODS_EMOJI.settings,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
    return;
  }

  const prefix = interaction.options.getString("prefix", true);
  if (!prefix || /\s/u.test(prefix) || [...prefix].length > 5) {
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Prefix Not Saved",
          description: [
            "Choose a prefix containing 1–5 characters and no spaces.",
            "",
            arrowLine("Try next", "Enter a shorter prefix without spaces."),
          ].join("\n"),
          emoji: GODS_EMOJI.settings,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
    return;
  }

  await securityManager.updateConfig(guildId, { prefix });
  await interaction.reply({
    embeds: [
      createGodsEmbed({
        title: "Prefix Updated",
        description: [
          "Your server's message prefix has been saved.",
          "",
          arrowLine("New prefix", `\`${prefix}\``),
          arrowLine("Try next", `Use \`${prefix}help\` to open the Help Centre.`),
        ].join("\n"),
        emoji: GODS_EMOJI.settings,
        tone: "success",
      }),
    ],
    ephemeral: true,
  });
}