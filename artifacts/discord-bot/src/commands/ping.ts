import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";

export const data = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("Check if the bot is alive and measure latency");

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const sent = await interaction.reply({
    content: "Pinging...",
    fetchReply: true,
  });
  const latency = sent.createdTimestamp - interaction.createdTimestamp;
  const wsLatency = interaction.client.ws.ping;

  await interaction.editReply(
    `🏓 Pong!\n> Round-trip: **${latency}ms**\n> WebSocket: **${wsLatency}ms**`
  );
}
