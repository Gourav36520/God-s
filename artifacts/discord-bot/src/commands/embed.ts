import {
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { buildSavedEmbedPicker } from "../welcome-goodbye/views.js";
import { welcomeGoodbyeStore } from "../welcome-goodbye/config-store.js";
import { requireGuildAdministrator } from "./welcome-goodbye-helpers.js";
import { createGodsEmbed, GODS_EMOJI } from "./ui.js";

export const data = new SlashCommandBuilder()
  .setName("embed")
  .setDescription("Browse saved server embeds")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("list")
      .setDescription("Show and preview this server's saved embeds"),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = await requireGuildAdministrator(interaction);
  if (!guildId) return;
  try {
    await interaction.reply({
      ...buildSavedEmbedPicker({
        kind: "list",
        guildId,
        userId: interaction.user.id,
        page: 0,
        config: welcomeGoodbyeStore.get(guildId),
      }),
      ephemeral: true,
    });
  } catch {
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Embeds Could Not Be Loaded",
          description: "The saved embeds could not be loaded. Please try again.",
          emoji: GODS_EMOJI.settings,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
  }
}