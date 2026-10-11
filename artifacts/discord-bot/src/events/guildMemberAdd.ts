import {
  ChannelType,
  Events,
  PermissionFlagsBits,
} from "discord.js";
import type { GuildMember } from "discord.js";
import { assignAutoRole } from "../autorole/service.js";
import { sendMemberWelcome } from "../welcome-goodbye/service.js";
import { logger } from "../lib/logger.js";
import { securityManager } from "../lib/registry.js";
import { inviteTracker } from "../trackers/invite-tracker.js";

export const name = Events.GuildMemberAdd;
export const once = false;

type TrackedJoin = ReturnType<typeof inviteTracker.getLatestJoin>;

async function sendInviteNotification(
  member: GuildMember,
  trackedJoin: TrackedJoin,
): Promise<void> {
  const channelId = securityManager.getConfig(member.guild.id).inviteChannelId;
  if (!channelId) return;

  const channel = await member.guild.channels.fetch(channelId).catch(() => null);
  if (
    !channel ||
    (channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement)
  ) {
    logger.warn(
      `Invite notification channel ${channelId} is missing or is not a text channel in guild ${member.guild.id}.`,
    );
    return;
  }

  const botMember = member.guild.members.me;
  const permissions = botMember ? channel.permissionsFor(botMember) : null;
  if (
    !permissions?.has(PermissionFlagsBits.ViewChannel) ||
    !permissions.has(PermissionFlagsBits.SendMessages)
  ) {
    logger.warn(
      `Invite notification skipped in guild ${member.guild.id}: the bot cannot view or send messages in channel ${channelId}.`,
    );
    return;
  }

  const isVerified = Boolean(trackedJoin?.verified && trackedJoin.inviterId);
  const inviterId = isVerified ? trackedJoin?.inviterId : null;
  const inviter = inviterId
    ? await member.client.users.fetch(inviterId).catch(() => null)
    : null;
  const inviterDisplay = inviterId
    ? `<@${inviterId}>${inviter ? ` (${inviter.username})` : ""}`
    : "Unknown";
  const inviteCode =
    isVerified && trackedJoin?.inviteCode
      ? `\`${trackedJoin.inviteCode}\``
      : "Unknown";

  await channel
    .send({
      content: [
        `**New member:** <@${member.id}> (${member.user.username})`,
        `**Inviter:** ${inviterDisplay}`,
        `**Invite code:** ${inviteCode}`,
      ].join("\n"),
      allowedMentions: {
        parse: [],
        users: [member.id, ...(inviterId ? [inviterId] : [])],
      },
    })
    .catch((error: unknown) => {
      logger.warn(
        `Could not send invite notification in guild ${member.guild.id}, channel ${channelId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
}

async function recordJoinAndNotify(member: GuildMember): Promise<void> {
  let trackedJoin: TrackedJoin = null;
  try {
    await inviteTracker.recordJoin(member);
    trackedJoin = inviteTracker.getLatestJoin(member.guild.id, member.id);
  } catch (error) {
    logger.error(
      `Invite tracking failed for member ${member.id}: ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }`,
    );
  }
  await sendInviteNotification(member, trackedJoin);
}

export async function execute(member: GuildMember): Promise<void> {
  void recordJoinAndNotify(member).catch((error: unknown) => {
    logger.error(
      `Invite notification failed for member ${member.id}: ${
        error instanceof Error ? error.stack ?? error.message : String(error)
      }`,
    );
  });
  await assignAutoRole(member);
  await sendMemberWelcome(member);
}