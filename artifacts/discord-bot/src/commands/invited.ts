import {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { inviteTracker } from "../trackers/invite-tracker.js";
import { trackerEmbed } from "./tracker-command-utils.js";

export const data = new SlashCommandBuilder()
  .setName("invited")
  .setDescription("Show the recorded invite attribution for a member")
  .addUserOption((option) =>
    option
      .setName("user")
      .setDescription("The member to look up")
      .setRequired(true),
  );

export async function execute(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({
      content: "Invite attribution is only available inside a server.",
      ephemeral: true,
    });
    return;
  }

  const user = interaction.options.getUser("user", true);
  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) {
    await interaction.reply({
      content: "That user is not currently a member of this server.",
      ephemeral: true,
    });
    return;
  }

  const trackedJoin = inviteTracker.getLatestJoin(guild.id, user.id);
  const joinedAt = trackedJoin?.joinedAt ?? member.joinedAt?.toISOString() ?? null;
  const timestamp = joinedAt ? Math.floor(Date.parse(joinedAt) / 1_000) : null;
  const joinDisplay = timestamp
    ? `<t:${timestamp}:F> · <t:${timestamp}:R>`
    : "Unavailable";

  const attributionDisplay = !trackedJoin
    ? "Unknown — this member joined before tracking began or no join event was recorded."
    : trackedJoin.verified
      ? `Verified · invited by <@${trackedJoin.inviterId}>`
      : "Unknown — no unique invite-use increase could be confirmed.";
  const inviteCode = trackedJoin?.verified
    ? `\`${trackedJoin.inviteCode}\``
    : "Unavailable";

  await interaction.reply({
    embeds: [
      trackerEmbed(
        `Invite Record · ${member.user.username}`,
        [
          `**Member:** <@${member.id}>`,
          `**Joined:** ${joinDisplay}`,
          `**Attribution:** ${attributionDisplay}`,
          `**Invite code:** ${inviteCode}`,
        ].join("\n"),
      ),
    ],
  });
}
