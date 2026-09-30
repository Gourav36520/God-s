import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import type { Message } from "discord.js";
import {
  arrowLine,
  createGodsEmbed,
  GODS_EMOJI,
} from "./ui.js";

export const data = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("Check if the bot is alive and measure latency");

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  const sent = await interaction.reply({
    content: "Checking the connection…",
    fetchReply: true,
  });
  const latency = sent.createdTimestamp - interaction.createdTimestamp;
  const wsLatency = interaction.client.ws.ping;

  const embed = createGodsEmbed({
    title: "Connection Check",
    emoji: GODS_EMOJI.logo,
    tone: "success",
    description: [
      arrowLine("Status", "The bot is online and responding."),
      arrowLine("Round-trip", `${latency} ms`),
      arrowLine("Discord gateway", `${wsLatency} ms`),
    ].join("\n"),
  });

  await interaction.editReply({ content: "", embeds: [embed] });
}

export async function executePrefix(message: Message): Promise<void> {
  const embed = createGodsEmbed({
    title: "Connection Check",
    emoji: GODS_EMOJI.logo,
    tone: "success",
    description: [
      arrowLine("Status", "The bot is online and responding."),
      arrowLine("Discord gateway", `${message.client.ws.ping} ms`),
    ].join("\n"),
  });
  await message.reply({ embeds: [embed] });
}
