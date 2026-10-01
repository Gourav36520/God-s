import {
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import { welcomeGoodbyeStore } from "../welcome-goodbye/config-store.js";
import type { GreetingKind } from "../welcome-goodbye/types.js";
import { requireGuildAdministrator } from "./welcome-goodbye-helpers.js";
import { arrowLine, createGodsEmbed, GODS_EMOJI } from "./ui.js";

export const data = new SlashCommandBuilder()
  .setName("remove")
  .setDescription("Remove a configured server channel")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommandGroup((group) =>
    group
      .setName("welcome")
      .setDescription("Welcome settings")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("channel")
          .setDescription("Remove only the configured Welcome channel"),
      ),
  )
  .addSubcommandGroup((group) =>
    group
      .setName("goodbye")
      .setDescription("Goodbye settings")
      .addSubcommand((subcommand) =>
        subcommand
          .setName("channel")
          .setDescription("Remove only the configured Goodbye channel"),
      ),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guildId = await requireGuildAdministrator(interaction);
  if (!guildId) return;
  const group = interaction.options.getSubcommandGroup(true) as GreetingKind;

  try {
    await welcomeGoodbyeStore.updateFlow(guildId, group, {
      channelId: null,
      enabled: false,
    });
    const label = group === "welcome" ? "Welcome" : "Goodbye";
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: `${label} Channel Removed`,
          description: [
            `The configured ${label.toLowerCase()} channel was removed and the flow was turned off. Your saved message and embeds are unchanged.`,
            "",
            arrowLine("Next", `Choose a new channel with \`/set ${group} channel\` to turn it back on.`),
          ].join("\n"),
          emoji: GODS_EMOJI.settings,
          tone: "success",
        }),
      ],
      ephemeral: true,
    });
  } catch {
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Channel Not Removed",
          description: "The channel setting could not be updated. Please try again.",
          emoji: GODS_EMOJI.settings,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
  }
}