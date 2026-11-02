import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildBan,
  type GuildMember,
  type SlashCommandStringOption,
  type SlashCommandUserOption,
  type SharedSlashCommand,
  type TextChannel,
} from "discord.js";
import {
  createModerationBanExpiration,
  createModerationCase,
  listModerationCases,
  listModerationWarnings,
  resolveAllModerationWarnings,
  resolveModerationBanExpirationsForTarget,
  resolveModerationWarning,
} from "@workspace/db";
import type { ModerationCase } from "@workspace/db";
import type { Command } from "../lib/registry.js";
import { loggingService } from "../lib/registry.js";
import { logger } from "../lib/logger.js";
import { arrowLine, createGodsEmbed } from "./ui.js";
import {
  replyPrivate,
  requireModerationContext,
  roleHierarchyError,
  targetHierarchyError,
  type ModerationContext,
} from "../moderation/permissions.js";

const memberOption = (name = "member", description = "The server member") =>
  (option: SlashCommandUserOption) =>
    option.setName(name).setDescription(description).setRequired(true);

const optionalReason = (required = false) =>
  (option: SlashCommandStringOption) => {
    const builder = option
      .setName("reason")
      .setDescription("Why this moderation action is being taken")
      .setMaxLength(512);
    return required ? builder.setRequired(true) : builder;
  };

const kickData = new SlashCommandBuilder()
  .setName("kick")
  .setDescription("Remove a member from this server")
  .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
  .addUserOption(memberOption())
  .addStringOption(optionalReason());

const banData = new SlashCommandBuilder()
  .setName("ban")
  .setDescription("Ban a member from this server")
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addUserOption(memberOption())
  .addStringOption((option) =>
    option
      .setName("duration")
      .setDescription(
        "Optional duration such as 15m, 2h, or 7d; maximum 68 years",
      )
      .setMinLength(2)
      .setMaxLength(8),
  )
  .addStringOption(optionalReason());

const unbanData = new SlashCommandBuilder()
  .setName("unban")
  .setDescription("Remove a server ban by user ID")
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addStringOption((option) =>
    option
      .setName("user_id")
      .setDescription("The banned user's Discord ID")
      .setRequired(true)
      .setMinLength(16)
      .setMaxLength(20),
  )
  .addStringOption(optionalReason());

const timeoutData = new SlashCommandBuilder()
  .setName("timeout")
  .setDescription("Temporarily prevent a member from messaging or speaking")
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(memberOption())
  .addStringOption((option) =>
    option
      .setName("duration")
      .setDescription("Duration such as 15m, 2h, or 7d; maximum 28d")
      .setRequired(true)
      .setMinLength(2)
      .setMaxLength(8),
  )
  .addStringOption(optionalReason());

const untimeoutData = new SlashCommandBuilder()
  .setName("untimeout")
  .setDescription("Remove a member's active timeout")
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(memberOption())
  .addStringOption(optionalReason());

const softbanData = new SlashCommandBuilder()
  .setName("softban")
  .setDescription("Ban and immediately unban a member to remove recent messages")
  .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
  .addUserOption(memberOption())
  .addStringOption(optionalReason());

const warnData = new SlashCommandBuilder()
  .setName("warn")
  .setDescription("Save a persistent warning for a member")
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(memberOption())
  .addStringOption(optionalReason());

const warningsData = new SlashCommandBuilder()
  .setName("warnings")
  .setDescription("View a member's active warnings")
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(memberOption());

const unwarnData = new SlashCommandBuilder()
  .setName("unwarn")
  .setDescription("Remove an active warning by case number")
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(memberOption())
  .addIntegerOption((option) =>
    option
      .setName("case_id")
      .setDescription("The warning case number")
      .setRequired(true)
      .setMinValue(1),
  )
  .addStringOption(optionalReason());

const clearWarningsData = new SlashCommandBuilder()
  .setName("clearwarnings")
  .setDescription("Clear all active warnings for a member")
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(memberOption())
  .addStringOption(optionalReason());

const purgeData = new SlashCommandBuilder()
  .setName("purge")
  .setDescription("Delete recent messages from this channel")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
  .addIntegerOption((option) =>
    option
      .setName("amount")
      .setDescription("Number of recent messages to review (1–100)")
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(100),
  )
  .addStringOption(optionalReason());

const lockData = new SlashCommandBuilder()
  .setName("lock")
  .setDescription("Prevent members from sending messages in this channel")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addStringOption(optionalReason());

const unlockData = new SlashCommandBuilder()
  .setName("unlock")
  .setDescription("Remove this channel's send-message lock")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addStringOption(optionalReason());

const slowmodeData = new SlashCommandBuilder()
  .setName("slowmode")
  .setDescription("Set a channel's slowmode in seconds")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels)
  .addIntegerOption((option) =>
    option
      .setName("seconds")
      .setDescription("Delay between messages (0–21600 seconds)")
      .setRequired(true)
      .setMinValue(0)
      .setMaxValue(21_600),
  )
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("Channel to configure; defaults to this channel")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  )
  .addStringOption(optionalReason());

const roleAddData = new SlashCommandBuilder()
  .setName("role-add")
  .setDescription("Add a role to a member")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addUserOption(memberOption())
  .addRoleOption((option) =>
    option.setName("role").setDescription("Role to add").setRequired(true),
  )
  .addStringOption(optionalReason());

const roleRemoveData = new SlashCommandBuilder()
  .setName("role-remove")
  .setDescription("Remove a role from a member")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addUserOption(memberOption())
  .addRoleOption((option) =>
    option.setName("role").setDescription("Role to remove").setRequired(true),
  )
  .addStringOption(optionalReason());

const nicknameData = new SlashCommandBuilder()
  .setName("nickname")
  .setDescription("Change or reset a member's server nickname")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageNicknames)
  .addUserOption(memberOption())
  .addStringOption((option) =>
    option
      .setName("nickname")
      .setDescription("New nickname; leave blank to reset")
      .setMaxLength(32),
  )
  .addStringOption(optionalReason());

const serverMuteData = new SlashCommandBuilder()
  .setName("server-mute")
  .setDescription("Mute a member in voice channels")
  .setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers)
  .addUserOption(memberOption())
  .addStringOption(optionalReason());

const serverUnmuteData = new SlashCommandBuilder()
  .setName("server-unmute")
  .setDescription("Unmute a member in voice channels")
  .setDefaultMemberPermissions(PermissionFlagsBits.MuteMembers)
  .addUserOption(memberOption())
  .addStringOption(optionalReason());

const serverDeafenData = new SlashCommandBuilder()
  .setName("server-deafen")
  .setDescription("Deafen a member in voice channels")
  .setDefaultMemberPermissions(PermissionFlagsBits.DeafenMembers)
  .addUserOption(memberOption())
  .addStringOption(optionalReason());

const serverUndeafenData = new SlashCommandBuilder()
  .setName("server-undeafen")
  .setDescription("Remove server deafen from a member")
  .setDefaultMemberPermissions(PermissionFlagsBits.DeafenMembers)
  .addUserOption(memberOption())
  .addStringOption(optionalReason());

const casesData = new SlashCommandBuilder()
  .setName("mod-cases")
  .setDescription("View a member's recent moderation case history")
  .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
  .addUserOption(memberOption());

const commandData: SharedSlashCommand[] = [
  kickData,
  banData,
  unbanData,
  timeoutData,
  untimeoutData,
  softbanData,
  warnData,
  warningsData,
  unwarnData,
  clearWarningsData,
  purgeData,
  lockData,
  unlockData,
  slowmodeData,
  roleAddData,
  roleRemoveData,
  nicknameData,
  serverMuteData,
  serverUnmuteData,
  serverDeafenData,
  serverUndeafenData,
  casesData,
];

type Confirmation =
  | {
      kind: "purge";
      userId: string;
      guildId: string;
      channelId: string;
      amount: number;
      reason: string;
      expiresAt: number;
    }
  | {
      kind: "clear-warnings";
      userId: string;
      guildId: string;
      targetId: string;
      reason: string;
      expiresAt: number;
    };

const pendingConfirmations = new Map<string, Confirmation>();
const CONFIRM_PREFIX = "moderation-confirm:";
const CANCEL_PREFIX = "moderation-cancel:";
const CONFIRMATION_LIFETIME_MS = 60_000;
const SNOWFLAKE_PATTERN = /^\d{16,20}$/;
const TIMEOUT_MAX_MS = 28 * 24 * 60 * 60 * 1000;
const BAN_MAX_DURATION_SECONDS = 2_147_483_647;
const MESSAGE_BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000 - 60_000;
type ConfirmationRequest =
  | Omit<Extract<Confirmation, { kind: "purge" }>, "expiresAt">
  | Omit<Extract<Confirmation, { kind: "clear-warnings" }>, "expiresAt">;

function replyEmbed(
  interaction: ChatInputCommandInteraction,
  embed: ReturnType<typeof createGodsEmbed>,
  components: ActionRowBuilder<ButtonBuilder>[] = [],
): Promise<unknown> {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply({ embeds: [embed], components });
  }
  return interaction.reply({ embeds: [embed], components, ephemeral: true });
}

function reasonFor(interaction: ChatInputCommandInteraction): string {
  return (
    interaction.options.getString("reason")?.trim().slice(0, 512) ||
    "No reason provided"
  );
}

function parseDuration(input: string): number | null {
  const match = /^(\d{1,6})(s|m|h|d)$/i.exec(input.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase();
  const multiplier =
    unit === "s"
      ? 1_000
      : unit === "m"
        ? 60_000
        : unit === "h"
          ? 3_600_000
          : unit === "d"
            ? 86_400_000
            : 0;
  return amount > 0 && multiplier ? amount * multiplier : null;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3_600 === 0) return `${seconds / 3_600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

function actionEmbed(options: {
  title: string;
  targetId: string;
  targetLabel: string;
  moderatorId: string;
  reason: string;
  duration?: string;
  caseId?: number | null;
  note?: string;
  tone?: "success" | "error" | "warning" | "info";
}) {
  const embed = createGodsEmbed({
    title: options.title,
    description: options.note ?? "The moderation action completed.",
    tone: options.tone ?? "success",
  }).addFields(
    {
      name: "Target",
      value: `${options.targetLabel}\n<@${options.targetId}>`,
      inline: true,
    },
    { name: "Moderator", value: `<@${options.moderatorId}>`, inline: true },
    { name: "Reason", value: options.reason, inline: false },
  );

  if (options.duration) {
    embed.addFields({ name: "Duration", value: options.duration, inline: true });
  }
  if (options.caseId) {
    embed.addFields({ name: "Case", value: `#${options.caseId}`, inline: true });
  }
  return embed;
}

function targetDisplay(target: GuildMember): string {
  return target.user.tag || target.user.username;
}

function getDiscordErrorCode(error: unknown): number | null {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "number"
  ) {
    return error.code;
  }
  return null;
}

async function memberTarget(
  interaction: ChatInputCommandInteraction,
  context: ModerationContext,
): Promise<GuildMember | null> {
  const user = interaction.options.getUser("member", true);
  let target: GuildMember;
  try {
    target = await context.guild.members.fetch(user.id);
  } catch (error) {
    if (getDiscordErrorCode(error) === 10007) {
      await replyPrivate(
        interaction,
        "Member Not Found",
        "That user is not currently a member of this server.",
      );
    } else {
      logger.warn(`Member lookup failed in guild=${context.guild.id}:`, error instanceof Error ? error.name : "unknown error");
      await replyPrivate(
        interaction,
        "Member Lookup Failed",
        "Discord could not verify that member right now.",
      );
    }
    return null;
  }

  const hierarchyError = targetHierarchyError(context, target);
  if (hierarchyError) {
    await replyPrivate(interaction, "Target Not Allowed", hierarchyError);
    return null;
  }
  return target;
}

async function saveCase(options: {
  guildId: string;
  targetId: string;
  moderatorId: string;
  action: string;
  reason: string;
  durationSeconds?: number | null;
}): Promise<number | null> {
  try {
    return await createModerationCase({
      guildId: options.guildId,
      targetId: options.targetId,
      moderatorId: options.moderatorId,
      action: options.action,
      reason: options.reason,
      durationSeconds: options.durationSeconds ?? null,
    });
  } catch (error) {
    logger.error(
      `Moderation case persistence failed for action=${options.action}:`,
      error instanceof Error ? error.name : "unknown error",
    );
    return null;
  }
}

async function logModeration(options: {
  guildId: string;
  targetId: string;
  targetLabel: string;
  moderatorId: string;
  action: string;
  reason: string;
  duration?: string;
  caseId?: number | null;
}): Promise<void> {
  try {
    await loggingService.logModerationCommand(options);
  } catch (error) {
    logger.warn(
      `Moderation log delivery failed for action=${options.action}:`,
      error instanceof Error ? error.name : "unknown error",
    );
  }
}

function caseHistoryLine(record: ModerationCase): string {
  const date = Math.floor(record.createdAt.getTime() / 1_000);
  const state = record.resolvedAt ? " · cleared" : "";
  const reason =
    record.reason.length > 240
      ? `${record.reason.slice(0, 237)}…`
      : record.reason;
  const duration = record.durationSeconds
    ? `\nDuration: ${formatDuration(record.durationSeconds * 1_000)}`
    : "";
  return [
    `**#${record.id} · ${record.action}**${state}`,
    `Moderator: <@${record.moderatorId}> · <t:${date}:R>`,
    `Reason: ${reason}${duration}`,
  ].join("\n");
}

function confirmationRow(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CONFIRM_PREFIX}${id}`)
      .setLabel("Confirm")
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`${CANCEL_PREFIX}${id}`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
}

async function requestConfirmation(
  interaction: ChatInputCommandInteraction,
  confirmation: ConfirmationRequest,
  message: string,
): Promise<void> {
  const id = randomUUID();
  pendingConfirmations.set(id, {
    ...confirmation,
    expiresAt: Date.now() + CONFIRMATION_LIFETIME_MS,
  } as Confirmation);
  const cleanup = setTimeout(() => pendingConfirmations.delete(id), CONFIRMATION_LIFETIME_MS);
  cleanup.unref?.();

  await replyEmbed(
    interaction,
    createGodsEmbed({
      title: "Confirm Moderation Action",
      description: message,
      tone: "warning",
    }),
    [confirmationRow(id)],
  );
}

async function requireButtonContext(
  interaction: ButtonInteraction,
  permission: bigint,
): Promise<ModerationContext | null> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.update({
      embeds: [
        createGodsEmbed({
          title: "Server Only",
          description: "This moderation action can only be completed in a server.",
          tone: "error",
        }),
      ],
      components: [],
    });
    return null;
  }

  const [moderator, botMember] = await Promise.all([
    guild.members.fetch(interaction.user.id).catch(() => null),
    guild.members.me
      ? Promise.resolve(guild.members.me)
      : guild.members.fetchMe().catch(() => null),
  ]);
  if (!moderator || !botMember) {
    await interaction.update({
      embeds: [
        createGodsEmbed({
          title: "Member Unavailable",
          description: "The moderator or bot could not be verified in this server.",
          tone: "error",
        }),
      ],
      components: [],
    });
    return null;
  }
  if (!moderator.permissions.has(permission) || !botMember.permissions.has(permission)) {
    await interaction.update({
      embeds: [
        createGodsEmbed({
          title: "Permission Changed",
          description: "The required moderator or bot permission is no longer available.",
          tone: "error",
        }),
      ],
      components: [],
    });
    return null;
  }
  return { guild, moderator, botMember };
}

export function isModerationConfirmation(customId: string): boolean {
  return (
    customId.startsWith(CONFIRM_PREFIX) ||
    customId.startsWith(CANCEL_PREFIX)
  );
}

export async function handleModerationConfirmation(
  interaction: ButtonInteraction,
): Promise<void> {
  const isConfirm = interaction.customId.startsWith(CONFIRM_PREFIX);
  const id = interaction.customId.slice(
    isConfirm ? CONFIRM_PREFIX.length : CANCEL_PREFIX.length,
  );
  const pending = pendingConfirmations.get(id);

  if (!pending || pending.expiresAt < Date.now()) {
    pendingConfirmations.delete(id);
    await interaction.update({
      embeds: [
        createGodsEmbed({
          title: "Confirmation Expired",
          description: "Run the moderation command again to start a new confirmation.",
          tone: "warning",
        }),
      ],
      components: [],
    });
    return;
  }

  if (
    pending.userId !== interaction.user.id ||
    pending.guildId !== interaction.guildId
  ) {
    await interaction.reply({
      content: "Only the moderator who started this confirmation can use it.",
      ephemeral: true,
    });
    return;
  }

  pendingConfirmations.delete(id);
  if (!isConfirm) {
    await interaction.update({
      embeds: [
        createGodsEmbed({
          title: "Action Cancelled",
          description: "No messages or warnings were changed.",
          tone: "info",
        }),
      ],
      components: [],
    });
    return;
  }

  const permission =
    pending.kind === "purge"
      ? PermissionFlagsBits.ManageMessages
      : PermissionFlagsBits.ModerateMembers;
  const context = await requireButtonContext(interaction, permission);
  if (!context) return;
  await interaction.deferUpdate();

  if (pending.kind === "purge") {
    const channel = await context.guild.channels
      .fetch(pending.channelId)
      .catch(() => null);
    if (
      !channel ||
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
    ) {
      await interaction.editReply({
        embeds: [
          createGodsEmbed({
            title: "Channel Unavailable",
            description: "The original text channel could not be found.",
            tone: "error",
          }),
        ],
        components: [],
      });
      return;
    }

    try {
      const textChannel = channel as TextChannel;
      const moderatorChannelPermissions =
        textChannel.permissionsFor(context.moderator);
      const channelPermissions = textChannel.permissionsFor(context.botMember);
      if (
        !moderatorChannelPermissions?.has(PermissionFlagsBits.ManageMessages) ||
        !moderatorChannelPermissions.has(PermissionFlagsBits.ReadMessageHistory) ||
        !channelPermissions?.has(PermissionFlagsBits.ManageMessages) ||
        !channelPermissions.has(PermissionFlagsBits.ReadMessageHistory)
      ) {
        await interaction.editReply({
          embeds: [
            createGodsEmbed({
              title: "Channel Permission Missing",
              description: "Both you and Gods Bot need Manage Messages and Read Message History in this channel.",
              tone: "error",
            }),
          ],
          components: [],
        });
        return;
      }
      const fetched = await textChannel.messages.fetch({ limit: pending.amount });
      const eligible = fetched.filter(
        (message) =>
          Date.now() - message.createdTimestamp < MESSAGE_BULK_DELETE_MAX_AGE_MS,
      );
      const skipped = fetched.size - eligible.size;
      let deleted = 0;

      if (eligible.size === 1) {
        const message = eligible.first();
        if (message) {
          await message.delete();
          deleted = 1;
        }
      } else if (eligible.size > 1) {
        deleted = (await textChannel.bulkDelete(eligible)).size;
      }

      const reason = `Purged ${deleted} message(s) from #${textChannel.name}. ${pending.reason}`;
      await logModeration({
        guildId: context.guild.id,
        targetId: context.moderator.id,
        targetLabel: context.moderator.user.tag,
        moderatorId: context.moderator.id,
        action: "purge",
        reason,
      });
      await interaction.editReply({
        embeds: [
          actionEmbed({
            title: "Messages Purged",
            targetId: textChannel.id,
            targetLabel: `#${textChannel.name}`,
            moderatorId: context.moderator.id,
            reason: pending.reason,
            note: [
              `Deleted **${deleted}** message(s) from <#${textChannel.id}>.`,
              skipped > 0
                ? `Skipped **${skipped}** message(s) older than Discord's 14-day bulk-delete limit.`
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
          }),
        ],
        components: [],
      });
    } catch (error) {
      logger.warn(
        `Purge failed in guild=${context.guild.id} channel=${pending.channelId}:`,
        error instanceof Error ? error.name : "unknown error",
      );
      await interaction.editReply({
        embeds: [
          createGodsEmbed({
            title: "Purge Failed",
            description: "Discord could not delete those messages. Check channel permissions and try again.",
            tone: "error",
          }),
        ],
        components: [],
      });
    }
    return;
  }

  const target = await context.guild.members
    .fetch(pending.targetId)
    .catch(() => null);
  if (!target) {
    await interaction.editReply({
      embeds: [
        createGodsEmbed({
          title: "Member Not Found",
          description: "That member is no longer in this server.",
          tone: "error",
        }),
      ],
      components: [],
    });
    return;
  }
  const hierarchyError = targetHierarchyError(context, target);
  if (hierarchyError) {
    await interaction.editReply({
      embeds: [
        createGodsEmbed({
          title: "Target Not Allowed",
          description: hierarchyError,
          tone: "error",
        }),
      ],
      components: [],
    });
    return;
  }

  try {
    const cleared = await resolveAllModerationWarnings(
      context.guild.id,
      target.id,
      context.moderator.id,
    );
    const reason = `Cleared ${cleared} active warning(s). ${pending.reason}`;
    const caseId = await saveCase({
      guildId: context.guild.id,
      targetId: target.id,
      moderatorId: context.moderator.id,
      action: "clear-warnings",
      reason,
    });
    await logModeration({
      guildId: context.guild.id,
      targetId: target.id,
      targetLabel: targetDisplay(target),
      moderatorId: context.moderator.id,
      action: "clear-warnings",
      reason,
      caseId,
    });
    await interaction.editReply({
      embeds: [
        actionEmbed({
          title: "Warnings Cleared",
          targetId: target.id,
          targetLabel: targetDisplay(target),
          moderatorId: context.moderator.id,
          reason: pending.reason,
          caseId,
          note:
            cleared > 0
              ? `Cleared **${cleared}** active warning(s). The warning history remains available in case history.${caseId ? "" : " The clear action could not be added as a new case."}`
              : "This member had no active warnings.",
        }),
      ],
      components: [],
    });
  } catch (error) {
    logger.warn(
      `Warning clear failed in guild=${context.guild.id} target=${target.id}:`,
      error instanceof Error ? error.name : "unknown error",
    );
    await interaction.editReply({
      embeds: [
        createGodsEmbed({
          title: "Could Not Clear Warnings",
          description: "The warning records could not be updated. No success was reported.",
          tone: "error",
        }),
      ],
      components: [],
    });
  }
}

async function executeKick(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const context = await requireModerationContext(interaction, PermissionFlagsBits.KickMembers);
  if (!context) return;
  const target = await memberTarget(interaction, context);
  if (!target) return;
  const reason = reasonFor(interaction);

  try {
    await target.kick(reason);
    const caseId = await saveCase({
      guildId: context.guild.id,
      targetId: target.id,
      moderatorId: context.moderator.id,
      action: "kick",
      reason,
    });
    await replyEmbed(
      interaction,
      actionEmbed({
        title: "Member Kicked",
        targetId: target.id,
        targetLabel: targetDisplay(target),
        moderatorId: context.moderator.id,
        reason,
        caseId,
        note: caseId
          ? "The member was removed and the action was recorded."
          : "The member was removed, but the case could not be saved.",
      }),
    );
  } catch (error) {
    logger.warn(`Kick failed in guild=${context.guild.id}:`, error instanceof Error ? error.name : "unknown error");
    await replyPrivate(interaction, "Kick Failed", "Discord could not kick that member. Check the bot's permissions and role position.");
  }
}

async function executeBan(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const context = await requireModerationContext(interaction, PermissionFlagsBits.BanMembers);
  if (!context) return;
  const target = await memberTarget(interaction, context);
  if (!target) return;
  const reason = reasonFor(interaction);
  const durationInput = interaction.options.getString("duration");
  const durationMs = durationInput ? parseDuration(durationInput) : null;
  if (
    durationInput &&
    (!durationMs ||
      durationMs < 60_000 ||
      Math.floor(durationMs / 1_000) > BAN_MAX_DURATION_SECONDS)
  ) {
    await replyPrivate(
      interaction,
      "Invalid Duration",
      "Use a duration from 1m through 68 years, such as 15m, 2h, or 7d.",
    );
    return;
  }

  try {
    // A new ban must not inherit an older expiry for the same user.
    await resolveModerationBanExpirationsForTarget(
      context.guild.id,
      target.id,
    );
  } catch (error) {
    logger.warn(
      `Ban expiry preflight failed in guild=${context.guild.id}:`,
      error instanceof Error ? error.name : "unknown error",
    );
    await replyPrivate(
      interaction,
      "Ban Not Applied",
      "The ban could not be applied because its expiry schedule could not be updated safely.",
    );
    return;
  }

  const expiresAt = durationMs ? new Date(Date.now() + durationMs) : null;
  if (expiresAt) {
    try {
      await createModerationBanExpiration({
        guildId: context.guild.id,
        targetId: target.id,
        expiresAt,
      });
    } catch (error) {
      logger.warn(
        `Ban expiry could not be persisted in guild=${context.guild.id}:`,
        error instanceof Error ? error.name : "unknown error",
      );
      await replyPrivate(
        interaction,
        "Ban Not Applied",
        "The temporary ban could not be applied because its expiry could not be saved.",
      );
      return;
    }
  }

  try {
    await context.guild.members.ban(target.id, { reason });
  } catch (error) {
    // Keep the persisted schedule: the request may have succeeded remotely even
    // if Discord's response was lost. At expiry, an absent ban is completed safely.
    logger.warn(`Ban failed in guild=${context.guild.id}:`, error instanceof Error ? error.name : "unknown error");
    await replyPrivate(interaction, "Ban Failed", "Discord could not ban that member. Check the bot's permissions and role position.");
    return;
  }

  const caseId = await saveCase({
    guildId: context.guild.id,
    targetId: target.id,
    moderatorId: context.moderator.id,
    action: "ban",
    reason,
    durationSeconds: durationMs ? Math.floor(durationMs / 1_000) : null,
  });
  const expiryNote = expiresAt
    ? ` The ban is scheduled to expire <t:${Math.floor(expiresAt.getTime() / 1_000)}:R>.`
    : "";
  await replyEmbed(
    interaction,
    actionEmbed({
      title: "Member Banned",
      targetId: target.id,
      targetLabel: targetDisplay(target),
      moderatorId: context.moderator.id,
      reason,
      duration: durationMs ? formatDuration(durationMs) : undefined,
      caseId,
      note: caseId
        ? `The member was banned and the action was recorded.${expiryNote}`
        : `The member was banned, but the case could not be saved.${expiryNote}`,
    }),
  );
}

async function executeUnban(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const context = await requireModerationContext(interaction, PermissionFlagsBits.BanMembers);
  if (!context) return;
  const targetId = interaction.options.getString("user_id", true).trim();
  if (!SNOWFLAKE_PATTERN.test(targetId)) {
    await replyPrivate(interaction, "Invalid User ID", "Enter a valid Discord user ID.");
    return;
  }
  const reason = reasonFor(interaction);
  let ban: GuildBan;
  try {
    ban = await context.guild.bans.fetch(targetId);
  } catch (error) {
    if (getDiscordErrorCode(error) === 10026) {
      await replyPrivate(interaction, "Ban Not Found", "That user is not currently banned from this server.");
    } else {
      logger.warn(`Ban lookup failed in guild=${context.guild.id}:`, error instanceof Error ? error.name : "unknown error");
      await replyPrivate(interaction, "Ban Lookup Failed", "Discord could not verify that user's ban status.");
    }
    return;
  }

  try {
    await context.guild.bans.remove(targetId, reason);
    try {
      await resolveModerationBanExpirationsForTarget(
        context.guild.id,
        targetId,
      );
    } catch (error) {
      logger.warn(
        `Ban expiry cleanup failed after unban in guild=${context.guild.id}:`,
        error instanceof Error ? error.name : "unknown error",
      );
    }
    const caseId = await saveCase({
      guildId: context.guild.id,
      targetId,
      moderatorId: context.moderator.id,
      action: "unban",
      reason,
    });
    await replyEmbed(
      interaction,
      actionEmbed({
        title: "Member Unbanned",
        targetId,
        targetLabel: ban.user.tag || ban.user.username,
        moderatorId: context.moderator.id,
        reason,
        caseId,
        note: caseId
          ? "The server ban was removed and the action was recorded."
          : "The server ban was removed, but the case could not be saved.",
      }),
    );
  } catch (error) {
    logger.warn(`Unban failed in guild=${context.guild.id}:`, error instanceof Error ? error.name : "unknown error");
    await replyPrivate(interaction, "Unban Failed", "Discord could not remove that ban. Check the bot's permissions.");
  }
}

async function executeTimeout(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const context = await requireModerationContext(interaction, PermissionFlagsBits.ModerateMembers);
  if (!context) return;
  const target = await memberTarget(interaction, context);
  if (!target) return;
  const durationInput = interaction.options.getString("duration", true);
  const durationMs = parseDuration(durationInput);
  if (!durationMs || durationMs < 60_000 || durationMs > TIMEOUT_MAX_MS) {
    await replyPrivate(interaction, "Invalid Duration", "Use a duration from 1m through 28d, such as 15m, 2h, or 7d.");
    return;
  }
  const duration = formatDuration(durationMs);
  const reason = reasonFor(interaction);

  try {
    await target.timeout(durationMs, reason);
    const caseId = await saveCase({
      guildId: context.guild.id,
      targetId: target.id,
      moderatorId: context.moderator.id,
      action: "timeout",
      reason,
      durationSeconds: Math.floor(durationMs / 1_000),
    });
    await replyEmbed(
      interaction,
      actionEmbed({
        title: "Member Timed Out",
        targetId: target.id,
        targetLabel: targetDisplay(target),
        moderatorId: context.moderator.id,
        reason,
        duration,
        caseId,
        note: caseId
          ? "The timeout was applied and the action was recorded."
          : "The timeout was applied, but the case could not be saved.",
      }),
    );
  } catch (error) {
    logger.warn(`Timeout failed in guild=${context.guild.id}:`, error instanceof Error ? error.name : "unknown error");
    await replyPrivate(interaction, "Timeout Failed", "Discord could not apply that timeout. Check the bot's permissions and role position.");
  }
}

async function executeUntimeout(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const context = await requireModerationContext(interaction, PermissionFlagsBits.ModerateMembers);
  if (!context) return;
  const target = await memberTarget(interaction, context);
  if (!target) return;
  const reason = reasonFor(interaction);

  try {
    await target.timeout(null, reason);
    const caseId = await saveCase({
      guildId: context.guild.id,
      targetId: target.id,
      moderatorId: context.moderator.id,
      action: "untimeout",
      reason,
    });
    await replyEmbed(
      interaction,
      actionEmbed({
        title: "Timeout Removed",
        targetId: target.id,
        targetLabel: targetDisplay(target),
        moderatorId: context.moderator.id,
        reason,
        caseId,
        note: caseId
          ? "The timeout was removed and the action was recorded."
          : "The timeout was removed, but the case could not be saved.",
      }),
    );
  } catch (error) {
    logger.warn(`Timeout removal failed in guild=${context.guild.id}:`, error instanceof Error ? error.name : "unknown error");
    await replyPrivate(interaction, "Timeout Removal Failed", "Discord could not remove that timeout. Check the bot's permissions and role position.");
  }
}

async function executeSoftban(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const context = await requireModerationContext(interaction, PermissionFlagsBits.BanMembers);
  if (!context) return;
  const target = await memberTarget(interaction, context);
  if (!target) return;
  const reason = reasonFor(interaction);

  try {
    await context.guild.members.ban(target.id, {
      reason,
      deleteMessageSeconds: 86_400,
    });
    try {
      await context.guild.bans.remove(target.id, `Softban completed: ${reason}`);
    } catch (unbanError) {
      logger.warn(`Softban unban step failed in guild=${context.guild.id}:`, unbanError instanceof Error ? unbanError.name : "unknown error");
      const caseId = await saveCase({
        guildId: context.guild.id,
        targetId: target.id,
        moderatorId: context.moderator.id,
        action: "softban-partial",
        reason,
      });
      await replyEmbed(
        interaction,
        actionEmbed({
          title: "Softban Partially Completed",
          targetId: target.id,
          targetLabel: targetDisplay(target),
          moderatorId: context.moderator.id,
          reason,
          caseId,
          tone: "warning",
          note: "Recent messages were removed, but Discord could not remove the ban. The member may remain banned.",
        }),
      );
      return;
    }

    const caseId = await saveCase({
      guildId: context.guild.id,
      targetId: target.id,
      moderatorId: context.moderator.id,
      action: "softban",
      reason,
    });
    await replyEmbed(
      interaction,
      actionEmbed({
        title: "Softban Completed",
        targetId: target.id,
        targetLabel: targetDisplay(target),
        moderatorId: context.moderator.id,
        reason,
        caseId,
        note: caseId
          ? "The member was unbanned after the softban; up to 24 hours of recent messages were removed."
          : "The softban completed, but the case could not be saved.",
      }),
    );
  } catch (error) {
    logger.warn(`Softban failed in guild=${context.guild.id}:`, error instanceof Error ? error.name : "unknown error");
    await replyPrivate(interaction, "Softban Failed", "Discord could not complete the softban. Check the bot's permissions and role position.");
  }
}

async function executeWarn(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const context = await requireModerationContext(interaction, PermissionFlagsBits.ModerateMembers);
  if (!context) return;
  const target = await memberTarget(interaction, context);
  if (!target) return;
  const reason = reasonFor(interaction);
  const caseId = await saveCase({
    guildId: context.guild.id,
    targetId: target.id,
    moderatorId: context.moderator.id,
    action: "warn",
    reason,
  });
  if (!caseId) {
    await replyPrivate(interaction, "Warning Not Saved", "The warning could not be stored, so no warning was issued. Try again later.");
    return;
  }

  await logModeration({
    guildId: context.guild.id,
    targetId: target.id,
    targetLabel: targetDisplay(target),
    moderatorId: context.moderator.id,
    action: "warn",
    reason,
    caseId,
  });
  await replyEmbed(
    interaction,
    actionEmbed({
      title: "Warning Issued",
      targetId: target.id,
      targetLabel: targetDisplay(target),
      moderatorId: context.moderator.id,
      reason,
      caseId,
    }),
  );
}

async function executeWarnings(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const context = await requireModerationContext(interaction, PermissionFlagsBits.ModerateMembers);
  if (!context) return;
  const target = await memberTarget(interaction, context);
  if (!target) return;

  try {
    const warnings = await listModerationWarnings(context.guild.id, target.id, 10);
    const description =
      warnings.length > 0
        ? warnings
            .map((record) => caseHistoryLine(record))
            .join("\n\n")
        : "This member has no active warnings.";
    const embed = createGodsEmbed({
      title: `Warnings · ${target.user.username}`,
      description,
      tone: warnings.length > 0 ? "warning" : "info",
    }).addFields({
      name: "Recent Active Warnings",
      value: String(warnings.length),
      inline: true,
    });
    if (warnings.length === 10) {
      embed.setFooter({
        text: "Gods Bot • Showing up to the 10 most recent active warnings",
      });
    }
    await replyEmbed(interaction, embed);
  } catch (error) {
    logger.warn(`Warnings lookup failed in guild=${context.guild.id}:`, error instanceof Error ? error.name : "unknown error");
    await replyPrivate(interaction, "Warnings Unavailable", "The warning records could not be loaded right now.");
  }
}

async function executeUnwarn(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const context = await requireModerationContext(interaction, PermissionFlagsBits.ModerateMembers);
  if (!context) return;
  const target = await memberTarget(interaction, context);
  if (!target) return;
  const caseId = interaction.options.getInteger("case_id", true);
  let updated: boolean;
  try {
    updated = await resolveModerationWarning(
      context.guild.id,
      target.id,
      caseId,
      context.moderator.id,
    );
  } catch (error) {
    logger.warn(`Warning removal failed in guild=${context.guild.id}:`, error instanceof Error ? error.name : "unknown error");
    await replyPrivate(interaction, "Warning Update Failed", "The warning record could not be updated right now.");
    return;
  }
  if (!updated) {
    await replyPrivate(interaction, "Warning Not Found", "No active warning with that case number belongs to this member.");
    return;
  }

  const reason = reasonFor(interaction);
  const actionReason = `Warning #${caseId} removed. ${reason}`;
  const removalCaseId = await saveCase({
    guildId: context.guild.id,
    targetId: target.id,
    moderatorId: context.moderator.id,
    action: "warn-remove",
    reason: actionReason,
  });
  await logModeration({
    guildId: context.guild.id,
    targetId: target.id,
    targetLabel: targetDisplay(target),
    moderatorId: context.moderator.id,
    action: "warn-remove",
    reason: actionReason,
    caseId: removalCaseId,
  });
  await replyEmbed(
    interaction,
    actionEmbed({
      title: "Warning Removed",
      targetId: target.id,
      targetLabel: targetDisplay(target),
      moderatorId: context.moderator.id,
      reason: actionReason,
      caseId: removalCaseId,
      note: `Warning **#${caseId}** was marked as cleared; it remains in case history.`,
    }),
  );
}

async function executeClearWarnings(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const context = await requireModerationContext(interaction, PermissionFlagsBits.ModerateMembers);
  if (!context) return;
  const target = await memberTarget(interaction, context);
  if (!target) return;
  const reason = reasonFor(interaction);

  await requestConfirmation(
    interaction,
    {
      kind: "clear-warnings",
      userId: context.moderator.id,
      guildId: context.guild.id,
      targetId: target.id,
      reason,
    },
    `Clear all active warnings for **${targetDisplay(target)}**? The action is recorded, and cleared warnings remain in the case history.\n\nReason: ${reason}`,
  );
}

async function executePurge(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const context = await requireModerationContext(interaction, PermissionFlagsBits.ManageMessages);
  if (!context) return;
  const channel = interaction.channel;
  if (
    !channel ||
    ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
  ) {
    await replyPrivate(interaction, "Unsupported Channel", "Purge can only be used in a server text or announcement channel.");
    return;
  }
  const textChannel = channel as TextChannel;
  const channelPermissions = textChannel.permissionsFor(context.botMember);
  if (
    !channelPermissions?.has(PermissionFlagsBits.ManageMessages) ||
    !channelPermissions.has(PermissionFlagsBits.ReadMessageHistory)
  ) {
    await replyPrivate(interaction, "Channel Permission Missing", "Gods Bot needs Manage Messages and Read Message History in this channel.");
    return;
  }
  const amount = interaction.options.getInteger("amount", true);
  const reason = reasonFor(interaction);
  await requestConfirmation(
    interaction,
    {
      kind: "purge",
      userId: context.moderator.id,
      guildId: context.guild.id,
      channelId: textChannel.id,
      amount,
      reason,
    },
    `Delete up to **${amount}** recent messages from <#${textChannel.id}>? Messages older than Discord's 14-day bulk-delete limit will be skipped.\n\nReason: ${reason}`,
  );
}

async function channelCommand(
  interaction: ChatInputCommandInteraction,
  action: "lock" | "unlock" | "slowmode",
): Promise<void> {
  const context = await requireModerationContext(interaction, PermissionFlagsBits.ManageChannels);
  if (!context) return;
  const selectedChannel =
    action === "slowmode"
      ? interaction.options.getChannel("channel") ?? interaction.channel
      : interaction.channel;
  if (
    !selectedChannel ||
    ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(
      selectedChannel.type,
    )
  ) {
    await replyPrivate(interaction, "Unsupported Channel", "Choose a server text or announcement channel.");
    return;
  }

  const channel = selectedChannel as TextChannel;
  const moderatorChannelPermissions = channel.permissionsFor(context.moderator);
  const botChannelPermissions = channel.permissionsFor(context.botMember);
  if (
    !moderatorChannelPermissions?.has(PermissionFlagsBits.ManageChannels) ||
    !botChannelPermissions?.has(PermissionFlagsBits.ManageChannels)
  ) {
    await replyPrivate(interaction, "Channel Permission Missing", "Both you and Gods Bot need Manage Channels in the selected channel.");
    return;
  }
  const seconds =
    action === "slowmode"
      ? interaction.options.getInteger("seconds", true)
      : null;
  const reason =
    reasonFor(interaction);

  try {
    if (action === "lock") {
      await channel.permissionOverwrites.edit(
        context.guild.roles.everyone,
        { SendMessages: false },
        { reason: `Locked by ${context.moderator.user.tag}: ${reason}` },
      );
    } else if (action === "unlock") {
      await channel.permissionOverwrites.edit(
        context.guild.roles.everyone,
        { SendMessages: null },
        { reason: `Unlocked by ${context.moderator.user.tag}: ${reason}` },
      );
    } else if (seconds !== null) {
      await channel.setRateLimitPerUser(
        seconds,
        `Changed by ${context.moderator.user.tag}: ${reason}`,
      );
    }

    await logModeration({
      guildId: context.guild.id,
      targetId: channel.id,
      targetLabel: `#${channel.name}`,
      moderatorId: context.moderator.id,
      action,
      reason,
    });
    const title =
      action === "lock"
        ? "Channel Locked"
        : action === "unlock"
          ? "Channel Unlocked"
          : "Slowmode Updated";
    const extra =
      action === "slowmode"
        ? `Slowmode is now **${seconds} second(s)**.`
        : action === "lock"
          ? "Members can no longer send messages unless another permission override allows it."
          : "The explicit send-message lock was removed; inherited channel permissions now apply.";
    await replyEmbed(
      interaction,
      createGodsEmbed({
        title,
        description: `${extra}\n\n${arrowLine("Channel", `<#${channel.id}>`)}\n${arrowLine("Moderator", `<@${context.moderator.id}>`)}\n${arrowLine("Reason", reason)}`,
        tone: "success",
      }),
    );
  } catch (error) {
    logger.warn(`Channel moderation failed in guild=${context.guild.id}:`, error instanceof Error ? error.name : "unknown error");
    await replyPrivate(interaction, "Channel Update Failed", "Discord could not update that channel. Check the bot's channel permissions.");
  }
}

async function executeRole(
  interaction: ChatInputCommandInteraction,
  action: "role-add" | "role-remove",
): Promise<void> {
  const context = await requireModerationContext(interaction, PermissionFlagsBits.ManageRoles);
  if (!context) return;
  const target = await memberTarget(interaction, context);
  if (!target) return;
  const selectedRole = interaction.options.getRole("role", true);
  const role = context.guild.roles.cache.get(selectedRole.id);
  if (!role) {
    await replyPrivate(interaction, "Role Not Found", "That role is no longer available in this server.");
    return;
  }
  const hierarchyError = roleHierarchyError(context, target, role.id);
  if (hierarchyError) {
    await replyPrivate(interaction, "Role Not Allowed", hierarchyError);
    return;
  }
  const reason = reasonFor(interaction);

  try {
    if (action === "role-add") {
      await target.roles.add(role, reason);
    } else {
      await target.roles.remove(role, reason);
    }
    const actionReason = `Role ${role.name}: ${reason}`;
    const caseId = await saveCase({
      guildId: context.guild.id,
      targetId: target.id,
      moderatorId: context.moderator.id,
      action,
      reason: actionReason,
    });
    await logModeration({
      guildId: context.guild.id,
      targetId: target.id,
      targetLabel: targetDisplay(target),
      moderatorId: context.moderator.id,
      action,
      reason: actionReason,
      caseId,
    });
    await replyEmbed(
      interaction,
      actionEmbed({
        title: action === "role-add" ? "Role Added" : "Role Removed",
        targetId: target.id,
        targetLabel: targetDisplay(target),
        moderatorId: context.moderator.id,
        reason,
        caseId,
        note: `${action === "role-add" ? "Added" : "Removed"} <@&${role.id}> ${action === "role-add" ? "to" : "from"} the member.`,
      }).addFields({ name: "Role", value: role.name, inline: true }),
    );
  } catch (error) {
    logger.warn(`Role moderation failed in guild=${context.guild.id}:`, error instanceof Error ? error.name : "unknown error");
    await replyPrivate(interaction, "Role Update Failed", "Discord could not update that role assignment. Check the bot's role position and permissions.");
  }
}

async function executeNickname(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const context = await requireModerationContext(interaction, PermissionFlagsBits.ManageNicknames);
  if (!context) return;
  const target = await memberTarget(interaction, context);
  if (!target) return;
  const nickname = interaction.options.getString("nickname")?.trim() || null;
  const reason = reasonFor(interaction);

  try {
    await target.setNickname(nickname, reason);
    const actionReason = `${nickname ? `Nickname set to ${nickname}` : "Nickname reset"}: ${reason}`;
    const caseId = await saveCase({
      guildId: context.guild.id,
      targetId: target.id,
      moderatorId: context.moderator.id,
      action: "nickname",
      reason: actionReason,
    });
    await logModeration({
      guildId: context.guild.id,
      targetId: target.id,
      targetLabel: targetDisplay(target),
      moderatorId: context.moderator.id,
      action: "nickname",
      reason: actionReason,
      caseId,
    });
    await replyEmbed(
      interaction,
      actionEmbed({
        title: nickname ? "Nickname Changed" : "Nickname Reset",
        targetId: target.id,
        targetLabel: targetDisplay(target),
        moderatorId: context.moderator.id,
        reason,
        caseId,
        note: nickname
          ? `Nickname is now **${nickname}**.`
          : "The member's server nickname was reset.",
      }),
    );
  } catch (error) {
    logger.warn(`Nickname update failed in guild=${context.guild.id}:`, error instanceof Error ? error.name : "unknown error");
    await replyPrivate(interaction, "Nickname Update Failed", "Discord could not change that nickname. Check the bot's permissions and role position.");
  }
}

async function executeVoiceModeration(
  interaction: ChatInputCommandInteraction,
  action: "server-mute" | "server-unmute" | "server-deafen" | "server-undeafen",
): Promise<void> {
  const permission =
    action === "server-mute" || action === "server-unmute"
      ? PermissionFlagsBits.MuteMembers
      : PermissionFlagsBits.DeafenMembers;
  const context = await requireModerationContext(interaction, permission);
  if (!context) return;
  const target = await memberTarget(interaction, context);
  if (!target) return;
  if (!target.voice.channelId) {
    await replyPrivate(interaction, "Member Not In Voice", "That member must be connected to a voice channel.");
    return;
  }
  const reason = reasonFor(interaction);
  const isMute = action === "server-mute" || action === "server-unmute";
  const enabled = action === "server-mute" || action === "server-deafen";

  try {
    if (isMute) {
      await target.voice.setMute(enabled, reason);
    } else {
      await target.voice.setDeaf(enabled, reason);
    }
    const caseId = await saveCase({
      guildId: context.guild.id,
      targetId: target.id,
      moderatorId: context.moderator.id,
      action,
      reason,
    });
    await logModeration({
      guildId: context.guild.id,
      targetId: target.id,
      targetLabel: targetDisplay(target),
      moderatorId: context.moderator.id,
      action,
      reason,
      caseId,
    });
    const title =
      action === "server-mute"
        ? "Member Server Muted"
        : action === "server-unmute"
          ? "Member Server Unmuted"
          : action === "server-deafen"
            ? "Member Server Deafened"
            : "Member Server Undeafened";
    await replyEmbed(
      interaction,
      actionEmbed({
        title,
        targetId: target.id,
        targetLabel: targetDisplay(target),
        moderatorId: context.moderator.id,
        reason,
        caseId,
      }),
    );
  } catch (error) {
    logger.warn(`Voice moderation failed in guild=${context.guild.id}:`, error instanceof Error ? error.name : "unknown error");
    await replyPrivate(interaction, "Voice Update Failed", "Discord could not update that voice state. Check the bot's permissions.");
  }
}

async function executeCases(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const context = await requireModerationContext(interaction, PermissionFlagsBits.ModerateMembers);
  if (!context) return;
  const target = await memberTarget(interaction, context);
  if (!target) return;

  try {
    const cases = await listModerationCases(context.guild.id, target.id, 10);
    const description =
      cases.length > 0
        ? cases.map((record) => caseHistoryLine(record)).join("\n\n")
        : "No moderation cases have been recorded for this member.";
    const embed = createGodsEmbed({
      title: `Moderation Cases · ${target.user.username}`,
      description,
      tone: cases.length > 0 ? "info" : "success",
    }).addFields(
      { name: "Target", value: `<@${target.id}>`, inline: true },
      { name: "Shown", value: `${cases.length} / 10`, inline: true },
    );
    await replyEmbed(interaction, embed);
  } catch (error) {
    logger.warn(`Case history lookup failed in guild=${context.guild.id}:`, error instanceof Error ? error.name : "unknown error");
    await replyPrivate(interaction, "Case History Unavailable", "The moderation case history could not be loaded right now.");
  }
}

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  await interaction.deferReply({ ephemeral: true });

  try {
    switch (interaction.commandName) {
      case "kick":
        await executeKick(interaction);
        break;
      case "ban":
        await executeBan(interaction);
        break;
      case "unban":
        await executeUnban(interaction);
        break;
      case "timeout":
        await executeTimeout(interaction);
        break;
      case "untimeout":
        await executeUntimeout(interaction);
        break;
      case "softban":
        await executeSoftban(interaction);
        break;
      case "warn":
        await executeWarn(interaction);
        break;
      case "warnings":
        await executeWarnings(interaction);
        break;
      case "unwarn":
        await executeUnwarn(interaction);
        break;
      case "clearwarnings":
        await executeClearWarnings(interaction);
        break;
      case "purge":
        await executePurge(interaction);
        break;
      case "lock":
      case "unlock":
      case "slowmode":
        await channelCommand(
          interaction,
          interaction.commandName as "lock" | "unlock" | "slowmode",
        );
        break;
      case "role-add":
      case "role-remove":
        await executeRole(
          interaction,
          interaction.commandName as "role-add" | "role-remove",
        );
        break;
      case "nickname":
        await executeNickname(interaction);
        break;
      case "server-mute":
      case "server-unmute":
      case "server-deafen":
      case "server-undeafen":
        await executeVoiceModeration(
          interaction,
          interaction.commandName as
            | "server-mute"
            | "server-unmute"
            | "server-deafen"
            | "server-undeafen",
        );
        break;
      case "mod-cases":
        await executeCases(interaction);
        break;
      default:
        await replyPrivate(
          interaction,
          "Unknown Moderation Command",
          "This moderation command is not available.",
        );
    }
  } catch (error) {
    logger.error(
      `Moderation handler failed for command=${interaction.commandName}:`,
      error instanceof Error ? error.name : "unknown error",
    );
    await replyPrivate(
      interaction,
      "Moderation Command Failed",
      "The action could not be completed. No internal details were exposed.",
    ).catch(() => undefined);
  }
}

export const moderationCommands: Command[] = commandData.map((data) => ({
  data,
  execute,
}));
