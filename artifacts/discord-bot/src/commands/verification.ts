import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import { VERIFICATION_BUTTON_ID } from "../verification/api.js";

export const data = new SlashCommandBuilder()
  .setName("verification")
  .setDescription("Post the persistent Discord account verification panel")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  if (
    !interaction.guildId ||
    !interaction.guild ||
    !interaction.channel?.isSendable()
  ) {
    await interaction.reply({
      content: "Use this command in a server text channel.",
      ephemeral: true,
    });
    return;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({
      content: "Manage Server permission is required to post this panel.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  try {
    const button = new ButtonBuilder()
      .setCustomId(VERIFICATION_BUTTON_ID)
      .setLabel("Verify with Discord")
      .setStyle(ButtonStyle.Primary);

    await interaction.channel.send({
      content:
        "**Discord account verification**\nPress the button to open a private verification link. Review the privacy notice before continuing.",
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(button),
      ],
    });
    await interaction.editReply("Verification panel posted in this channel.");
  } catch {
    await interaction.editReply("The verification panel could not be posted.");
  }
}
