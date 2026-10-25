import {
  PermissionFlagsBits,
  ChatInputCommandInteraction,
} from "discord.js";
import { arrowLine, createGodsEmbed, GODS_EMOJI } from "./ui.js";
import type { GreetingKind } from "../welcome-goodbye/types.js";

export async function requireGuildAdministrator(
  interaction: ChatInputCommandInteraction,
): Promise<string | null> {
  if (!interaction.guildId) {
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Server Required",
          description: "Run this command inside the server you want to configure.",
          emoji: GODS_EMOJI.settings,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
    return null;
  }
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) {
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Administrator Permission Required",
          description: "Only a server Administrator can change Welcome or Goodbye settings.",
          emoji: GODS_EMOJI.settings,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
    return null;
  }
  return interaction.guildId;
}

export function settingSavedEmbed(
  kind: GreetingKind,
  setting: string,
  value: string,
) {
  const label = kind === "welcome" ? "Welcome" : "Goodbye";
  return createGodsEmbed({
    title: `${label} Updated`,
    description: [
      `${label} ${setting} has been saved for this server.`,
      "",
      arrowLine("Saved", value),
    ].join("\n"),
    emoji: GODS_EMOJI.settings,
    tone: "success",
  });
}