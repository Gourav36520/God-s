import { PermissionFlagsBits, SlashCommandBuilder } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { antiNukeService } from "../lib/registry.js";
import { resolveInteractionGuild } from "../lib/interactionGuildContext.js";
import { isGuildOwner } from "../security/antinuke/policy.js";

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
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "Use this command in a server.", ephemeral: true });
    return;
  }
  const context = await resolveInteractionGuild(interaction);
  if (
    context.kind !== "guild" ||
    !isGuildOwner(interaction.user.id, context.guild.ownerId)
  ) {
    await interaction.reply({
      content: "Only the server owner can configure Anti-Nuke security.",
      ephemeral: true,
    });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  await antiNukeService.ensureConfig(guildId);
  const enabled = interaction.options.getBoolean("enabled", true);
  await antiNukeService.updateConfig(guildId, (current) => ({
    ...current,
    unverifiedBotKick: enabled,
  }));
  await antiNukeService.recordSystemIncident({
    guild: interaction.guild?.id === guildId ? interaction.guild : undefined,
    guildId,
    action: "unverified-bot-kick-config",
    executorId: interaction.user.id,
    outcome: `Unapproved bot kick ${enabled ? "enabled" : "disabled"}.`,
    details: { enabled },
  });
  await interaction.editReply({
    content: `Unapproved bot kick ${enabled ? "enabled" : "disabled"}. Blacklisted bots are still kicked when possible.`,
  });
}
