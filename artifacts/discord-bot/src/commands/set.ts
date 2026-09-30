import {
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { securityManager } from "../lib/registry.js";

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
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      content: "You need Administrator permission to change the prefix.",
      ephemeral: true,
    });
    return;
  }

  const prefix = interaction.options.getString("prefix", true);
  if (!prefix || /\s/u.test(prefix) || [...prefix].length > 5) {
    await interaction.reply({
      content: "Choose a prefix of 1–5 characters with no spaces.",
      ephemeral: true,
    });
    return;
  }

  await securityManager.updateConfig(guildId, { prefix });
  await interaction.reply({
    content: "Server prefix saved. Text commands will now use the configured prefix.",
    ephemeral: true,
  });
}