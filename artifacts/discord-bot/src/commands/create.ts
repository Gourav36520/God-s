import {
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { createEmbedDraft } from "../welcome-goodbye/drafts.js";
import { buildEmbedBuilderPanel } from "../welcome-goodbye/views.js";
import { requireGuildAdministrator } from "./welcome-goodbye-helpers.js";
import { createGodsEmbed, GODS_EMOJI } from "./ui.js";

export const data = new SlashCommandBuilder()
  .setName("create")
  .setDescription("Create a reusable server embed")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("embed")
      .setDescription("Build and save an embed for this server")
      .addStringOption((option) =>
        option
          .setName("name")
          .setDescription("A short name to recognize this embed")
          .setMinLength(1)
          .setMaxLength(80)
          .setRequired(true),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = await requireGuildAdministrator(interaction);
  if (!guildId) return;
  const name = interaction.options.getString("name", true).trim();
  if (!name) {
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Embed Name Needed",
          description: "Enter a name so you can find this embed later.",
          emoji: GODS_EMOJI.settings,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
    return;
  }

  const draft = createEmbedDraft(guildId, interaction.user.id, name);
  await interaction.reply({
    ...buildEmbedBuilderPanel(draft),
    ephemeral: true,
  });
}