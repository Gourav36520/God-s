import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  SlashCommandBuilder,
} from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("help")
  .setDescription("List all available commands");

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const embed = new EmbedBuilder()
    .setTitle("God's Bot — Commands")
    .setColor(0x5865f2)
    .addFields(
      {
        name: "General",
        value: "`/ping` — Check latency\n`/help` — Show this message\n`/info` — Server info",
        inline: false,
      },
      {
        name: "Security (Admin)",
        value:
          "`/security status` — View all module states\n" +
          "`/security enable <module>` — Enable a module\n" +
          "`/security disable <module>` — Disable a module\n" +
          "`/security setlog <channel>` — Set the security log channel",
        inline: false,
      },
      {
        name: "God's Judgment (Mod)",
        value:
          "`/judgment setup` — Create the judgment role & channel *(Admin)*\n" +
          "`/judgment user <user> [reason]` — Place a user under judgment\n" +
          "`/judgment status` — View active judgments & config\n" +
          "`/release <user> [reason]` — Release a user and restore their roles",
        inline: false,
      },
      {
        name: "Logging (Admin)",
        value:
          "`/logging status` — View log channel and category toggles\n" +
          "`/logging setchannel <channel>` — Set the log channel\n" +
          "`/logging enable <category>` — Enable a log category\n" +
          "`/logging disable <category>` — Disable a log category\n" +
          "`/logging enableall` — Enable all categories\n" +
          "`/logging disableall` — Disable all categories",
        inline: false,
      }
    )
    .setFooter({ text: "God's Bot Security System" })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
