import {
  ChatInputCommandInteraction,
  Guild,
  SlashCommandBuilder,
} from "discord.js";
import {
  arrowLine,
  createGodsEmbed,
  GODS_EMOJI,
} from "./ui.js";

export const data = new SlashCommandBuilder()
  .setName("info")
  .setDescription("Show information about the current server");

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const guild = interaction.guild as Guild | null;

  if (!guild) {
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Server Information Unavailable",
          description: "Run this command inside a server to view its details.",
          emoji: GODS_EMOJI.logo,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
    return;
  }

  const owner = await guild.fetchOwner();

  const createdAt = Math.floor(guild.createdTimestamp / 1000);
  const embed = createGodsEmbed({
    title: "Server Overview",
    emoji: GODS_EMOJI.logo,
    tone: "info",
    description: `A clear snapshot of **${guild.name}**.`,
  })
    .setThumbnail(guild.iconURL())
    .addFields(
      {
        name: "Server Owner",
        value: `${arrowLine("Owner", `<@${owner.id}> · \`${owner.user.tag}\``)}`,
        inline: false,
      },
      {
        name: "Community",
        value: [
          arrowLine("Members", guild.memberCount.toLocaleString()),
          arrowLine("Channels", guild.channels.cache.size.toLocaleString()),
          arrowLine("Roles", guild.roles.cache.size.toLocaleString()),
        ].join("\n"),
        inline: false,
      },
      {
        name: "Server Created",
        value: `${arrowLine("Date", `<t:${createdAt}:D> · <t:${createdAt}:R>`)}`,
        inline: false,
      },
      {
        name: "Server ID",
        value: `${arrowLine("ID", `\`${guild.id}\``)}`,
        inline: false,
      },
    )

  await interaction.reply({ embeds: [embed] });
}
