import {
  ActionRowBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { requireGuildAdministrator } from "./welcome-goodbye-helpers.js";

export const data = new SlashCommandBuilder()
  .setName("add")
  .setDescription("Add a saved embed")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommandGroup((group) =>
    group
      .setName("raw")
      .setDescription("Advanced saved-embed import")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("json")
          .setDescription("Import a saved embed from raw Discord Embed JSON"),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = await requireGuildAdministrator(interaction);
  if (!guildId) return;

  const input = new TextInputBuilder()
    .setCustomId("json")
    .setLabel("Discord Embed JSON (up to 4000 characters)")
    .setStyle(TextInputStyle.Paragraph)
    .setMaxLength(4000)
    .setRequired(false)
    .setPlaceholder("Paste one embed JSON object. It is parsed as data only.");
  const modal = new ModalBuilder()
    .setCustomId(`wg:rawjson:submit:${guildId}:${interaction.user.id}`)
    .setTitle("Import raw embed JSON")
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  await interaction.showModal(modal);
}