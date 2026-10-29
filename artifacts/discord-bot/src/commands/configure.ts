import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { antiNukeService } from "../lib/registry.js";

export const data = new SlashCommandBuilder()
  .setName("configure")
  .setDescription("Configure server-level protection policies")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((sub) =>
    sub
      .setName("unverified-bot-kick")
      .setDescription("Kick bots not approved through this server's whitelist")
      .addBooleanOption((option) =>
        option.setName("enabled").setDescription("Enable unapproved bot kicks").setRequired(true),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: "Use this command in a server.", ephemeral: true });
    return;
  }
  if (
    interaction.user.id !== guild.ownerId &&
    !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  ) {
    await interaction.reply({ content: "Administrator permission is required.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const enabled = interaction.options.getBoolean("enabled", true);
  await antiNukeService.updateConfig(guild.id, (current) => ({
    ...current,
    unverifiedBotKick: enabled,
  }));
  await antiNukeService.recordSystemIncident({
    guild,
    action: "unverified-bot-kick-config",
    executorId: interaction.user.id,
    outcome: `Unapproved bot kick ${enabled ? "enabled" : "disabled"}.`,
    details: { enabled },
  });
  await interaction.editReply({
    content: `Unapproved bot kick ${enabled ? "enabled" : "disabled"}. Blacklisted bots are still kicked when possible.`,
  });
}
