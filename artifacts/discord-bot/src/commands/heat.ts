import {
  ChatInputCommandInteraction,
  EmbedBuilder,
  GuildMember,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import { securityManager } from "../lib/registry.js";
import { Authorization } from "../security/heat/Authorization.js";
import type { HeatResult } from "../security/heat/HeatEngine.js";

const authorization = new Authorization();

export const data = new SlashCommandBuilder()
  .setName("heat")
  .setDescription("Manage a user's heat level")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((sub) =>
    sub
      .setName("view")
      .setDescription("View a user's heat")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("The user").setRequired(true)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("add")
      .setDescription("Add heat to a user")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("The user").setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt
          .setName("amount")
          .setDescription("Heat to add")
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("reason").setDescription("Reason").setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("remove")
      .setDescription("Remove heat from a user")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("The user").setRequired(true)
      )
      .addIntegerOption((opt) =>
        opt
          .setName("amount")
          .setDescription("Heat to remove")
          .setMinValue(1)
          .setMaxValue(100)
          .setRequired(true)
      )
      .addStringOption((opt) =>
        opt.setName("reason").setDescription("Reason").setRequired(false)
      )
  )
  .addSubcommand((sub) =>
    sub
      .setName("reset")
      .setDescription("Reset a user's heat")
      .addUserOption((opt) =>
        opt.setName("user").setDescription("The user").setRequired(true)
      )
  );

export async function execute(
  interaction: ChatInputCommandInteraction
): Promise<void> {
  if (!interaction.guildId || !interaction.guild) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  if (!authorization.canManageHeat(interaction)) {
    await interaction.reply({
      content: "You need Manage Server permission to use this command.",
      ephemeral: true,
    });
    return;
  }

  const target = interaction.options.getMember("user") as GuildMember | null;
  const targetUser = interaction.options.getUser("user", true);
  if (!target) {
    await interaction.reply({
      content: "That user is not currently a member of this server.",
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand();
  const engine = securityManager.getHeatEngine();
  let result: HeatResult;

  switch (subcommand) {
    case "view":
      result = await engine.view(interaction.guildId, targetUser.id);
      break;
    case "add":
      result = await engine.add(
        target,
        interaction.options.getInteger("amount", true),
        interaction.options.getString("reason")
      );
      break;
    case "remove":
      result = await engine.remove(
        interaction.guildId,
        targetUser.id,
        interaction.options.getInteger("amount", true),
        interaction.options.getString("reason")
      );
      break;
    case "reset":
      result = await engine.reset(interaction.guildId, targetUser.id);
      break;
    default:
      return;
  }

  await interaction.reply({
    embeds: [buildHeatEmbed(subcommand, targetUser.id, result)],
    ephemeral: true,
  });
}

function buildHeatEmbed(
  action: string,
  userId: string,
  result: HeatResult
): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`Heat ${action}`)
    .setColor(result.record.heat > 0 ? 0xed4245 : 0x57f287)
    .addFields(
      { name: "User", value: `<@${userId}>`, inline: true },
      { name: "Heat", value: String(result.record.heat), inline: true },
      { name: "Severity", value: result.severity, inline: true },
      {
        name: "Punishment",
        value: result.punishment.punishment,
        inline: true,
      }
    )
    .setTimestamp();
}