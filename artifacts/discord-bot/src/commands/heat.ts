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
import {
  arrowLine,
  createGodsEmbed,
  GODS_EMOJI,
} from "./ui.js";

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
      embeds: [
        createGodsEmbed({
          title: "Server Required",
          description: "Run Heat commands inside the server where the member is located.",
          emoji: GODS_EMOJI.heat,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
    return;
  }

  if (!authorization.canManageHeat(interaction)) {
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Manage Server Permission Required",
          description: "You need the **Manage Server** permission to use Heat commands.",
          emoji: GODS_EMOJI.heat,
          tone: "error",
        }),
      ],
      ephemeral: true,
    });
    return;
  }

  const target = interaction.options.getMember("user") as GuildMember | null;
  const targetUser = interaction.options.getUser("user", true);
  if (!target) {
    await interaction.reply({
      embeds: [
        createGodsEmbed({
          title: "Member Not Found",
          description: "That user is not currently a member of this server. Select a current member and try again.",
          emoji: GODS_EMOJI.heat,
          tone: "error",
        }),
      ],
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

  const requestedAction =
    subcommand === "add"
      ? `Increase requested: +${interaction.options.getInteger("amount", true)} Heat`
      : subcommand === "remove"
        ? `Decrease requested: ${interaction.options.getInteger("amount", true)} Heat`
        : subcommand === "reset"
          ? "Reset requested"
          : "Current Heat record";

  await interaction.reply({
    embeds: [buildHeatEmbed(subcommand, targetUser.id, result, requestedAction)],
    ephemeral: true,
  });
}

function buildHeatEmbed(
  action: string,
  userId: string,
  result: HeatResult,
  requestedAction: string
): EmbedBuilder {
  const lastViolation = result.record.lastViolationType
    ? formatLabel(result.record.lastViolationType)
    : "No violation type recorded";
  const reason = result.record.lastReason?.trim()
    ? result.record.lastReason.trim().slice(0, 800)
    : "No reason recorded";
  const escalation = [
    arrowLine("Stage", `${result.record.escalationCount} / 10`),
    ...(result.record.escalationWarningIssued
      ? [arrowLine("Warning", "An escalation warning has been issued.")]
      : []),
    arrowLine(
      "Last escalation",
      result.record.lastEscalationAt
        ? `<t:${Math.floor(new Date(result.record.lastEscalationAt).getTime() / 1_000)}:R>`
        : "No escalation recorded",
    ),
  ].join("\n");
  const punishment = formatLabel(result.punishment.punishment);
  const title =
    action === "view" ? "Heat Status" : "Heat Action Result";

  return createGodsEmbed({
    title,
    emoji: GODS_EMOJI.heat,
    tone: result.record.heat > 0 ? "warning" : "info",
    description: [
      arrowLine("Member", `<@${userId}>`),
      arrowLine("Request", requestedAction),
      "The details below show the current Heat record.",
    ].join("\n"),
  })
    .addFields(
      {
        name: "Current Status",
        value: [
          arrowLine("Heat", String(result.record.heat)),
          arrowLine("Severity", formatLabel(result.severity)),
          arrowLine("Resulting action", punishment),
        ].join("\n"),
        inline: false,
      },
      {
        name: "Recent Activity",
        value: [
          arrowLine("Recorded events", String(result.record.events)),
          arrowLine("Last violation", lastViolation),
          arrowLine("Reason", reason),
        ].join("\n"),
        inline: false,
      },
      { name: "Escalation", value: escalation, inline: false },
    );
}

function formatLabel(value: string): string {
  if (value === "none") return "No punishment triggered";
  if (value === "judgment") return "God's Judgment";
  return value
    .replace(/([a-z])([A-Z])/gu, "$1 $2")
    .replace(/[_-]/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}