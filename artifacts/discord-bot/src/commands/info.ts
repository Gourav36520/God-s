import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  Guild,
  SlashCommandBuilder,
} from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("info")
  .setDescription("Show information about the current server");

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const guild = interaction.guild as Guild | null;

  if (!guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const owner = await guild.fetchOwner();

  const embed = new EmbedBuilder()
    .setTitle(guild.name)
    .setColor(0x57f287)
    .setThumbnail(guild.iconURL())
    .addFields(
      { name: "Owner", value: owner.user.tag, inline: true },
      { name: "Members", value: guild.memberCount.toString(), inline: true },
      { name: "Channels", value: guild.channels.cache.size.toString(), inline: true },
      { name: "Roles", value: guild.roles.cache.size.toString(), inline: true },
      { name: "Created", value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true },
      { name: "Server ID", value: guild.id, inline: true }
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
