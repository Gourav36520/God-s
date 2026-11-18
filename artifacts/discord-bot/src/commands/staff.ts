import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
  type Message,
} from "discord.js";
import {
  createModerationCase,
  getModerationRoleConfig,
  listModerationCases,
} from "@workspace/db";
import type { Command } from "../lib/registry.js";
import { getStaffGrantRoleId, setStaffGrantRoleId } from "../staff-role-config-store.js";
import { createGodsEmbed } from "./ui.js";
import { replyPrivate } from "../moderation/permissions.js";

type StaffReply = (
  title: string,
  description: string,
  tone?: "success" | "error" | "warning" | "info",
) => Promise<void>;

const staffGrantInProgress = new Set<string>();

async function replyToMessage(
  message: Message,
  title: string,
  description: string,
  tone: "success" | "error" | "warning" | "info" = "error",
): Promise<void> {
  await message.reply({
    embeds: [createGodsEmbed({ title, description, tone })],
    allowedMentions: { repliedUser: false },
  });
}

async function runStaffGrant(
  guild: Guild | null,
  memberId: string,
  reply: StaffReply,
): Promise<void> {
  if (!guild) {
    await reply("Server Only", "This command can only be used in a server.");
    return;
  }

  const assignmentKey = `${guild.id}:${memberId}`;
  if (staffGrantInProgress.has(assignmentKey)) {
    await reply(
      "Staff Request Already Processing",
      "Your staff role request is already being handled. No duplicate assignment was started.",
      "info",
    );
    return;
  }
  staffGrantInProgress.add(assignmentKey);
  try {
    await runStaffGrantForGuild(guild, memberId, reply);
  } finally {
    staffGrantInProgress.delete(assignmentKey);
  }
}

async function runStaffGrantForGuild(
  guild: Guild,
  memberId: string,
  reply: StaffReply,
): Promise<void> {
  let requestRoleId: string | null;
  let grantRoleId: string | null;
  try {
    const [moderationConfig, configuredGrantRoleId] = await Promise.all([
      getModerationRoleConfig(guild.id),
      getStaffGrantRoleId(guild.id),
    ]);
    requestRoleId = moderationConfig?.staffRequestRoleId ?? null;
    grantRoleId = configuredGrantRoleId;
  } catch {
    await reply(
      "Staff Settings Unavailable",
      "The configured staff roles could not be verified, so no role was assigned.",
    );
    return;
  }

  if (!requestRoleId || !grantRoleId) {
    await reply(
      "Staff Roles Not Configured",
      "The server owner must configure both the Staff Request Role and Staff Grant Role first.",
    );
    return;
  }
  if (requestRoleId === grantRoleId) {
    await reply(
      "Staff Roles Must Differ",
      "The Staff Request Role and Staff Grant Role must be separate roles.",
    );
    return;
  }

  const [requestRole, grantRole, member, botMember] = await Promise.all([
    guild.roles.fetch(requestRoleId).catch(() => null),
    guild.roles.fetch(grantRoleId).catch(() => null),
    guild.members.fetch(memberId).catch(() => null),
    guild.members.me
      ? Promise.resolve(guild.members.me)
      : guild.members.fetchMe().catch(() => null),
  ]);
  if (!requestRole || !grantRole || !member || !botMember) {
    await reply(
      "Staff Roles Unavailable",
      "A configured role, your server membership, or the bot membership could not be verified.",
    );
    return;
  }
  if (
    requestRole.id === grantRole.id ||
    requestRole.managed ||
    grantRole.managed ||
    grantRole.id === guild.id
  ) {
    await reply(
      "Staff Roles Invalid",
      "The configured Staff Request Role and Staff Grant Role are not assignable distinct roles.",
    );
    return;
  }
  if (!member.roles.cache.has(requestRole.id)) {
    await reply(
      "Staff Request Role Required",
      "Only members with the configured Staff Request Role can use this command.",
    );
    return;
  }
  if (member.roles.cache.has(grantRole.id)) {
    await reply(
      "Staff Role Already Assigned",
      "You already have the configured Staff Grant Role. No duplicate assignment was made.",
      "info",
    );
    return;
  }
  if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
    await reply(
      "Bot Permission Missing",
      "Gods Bot needs Manage Roles to grant staff access.",
    );
    return;
  }
  if (botMember.roles.highest.comparePositionTo(grantRole) <= 0) {
    await reply(
      "Role Hierarchy Blocked",
      "Gods Bot's highest role must be above the configured Staff Grant Role.",
    );
    return;
  }

  try {
    await member.roles.add(
      grantRole,
      `Staff Grant Role requested by ${member.user.tag} through /staff`,
    );
  } catch {
    await reply(
      "Staff Role Could Not Be Assigned",
      "Discord rejected the role assignment. Check the bot's Manage Roles permission and role position.",
    );
    return;
  }

  try {
    const caseId = await createModerationCase({
      guildId: guild.id,
      targetId: member.id,
      moderatorId: member.id,
      action: "staff-grant",
      reason: "Staff Grant Role assigned through /staff",
    });
    await reply(
      "Staff Role Granted",
      `The Staff Grant Role was assigned successfully. Assignment record: #${caseId}.`,
      "success",
    );
  } catch {
    await reply(
      "Staff Role Granted; Count Not Saved",
      "The role was assigned, but its count record could not be saved. Contact the server owner to review the count.",
      "warning",
    );
  }
}

const staffRoleData = new SlashCommandBuilder()
  .setName("staff-role")
  .setDescription("Configure the role granted by /staff")
  .setDefaultMemberPermissions(null)
  .addSubcommand((subcommand) =>
    subcommand
      .setName("add")
      .setDescription("Set the Staff Grant Role")
      .addRoleOption((option) =>
        option
          .setName("role")
          .setDescription("The role to grant after a staff request")
          .setRequired(true),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("remove")
      .setDescription("Clear the Staff Grant Role"),
  );

const staffData = new SlashCommandBuilder()
  .setName("staff")
  .setDescription("Request automatic assignment of the Staff Grant Role")
  .setDefaultMemberPermissions(null);

const manageData = new SlashCommandBuilder()
  .setName("manage")
  .setDescription("View successful Staff Grant Role assignments")
  .setDefaultMemberPermissions(null)
  .addUserOption((option) =>
    option
      .setName("member")
      .setDescription("Member whose successful staff-grant count to view"),
  );

async function executeStaffRole(
  interaction: ChatInputCommandInteraction,
): Promise<void> {
  const guild = interaction.guild;
  if (!guild) {
    await replyPrivate(interaction, "Server Only", "Staff role settings can only be changed in a server.");
    return;
  }
  if (interaction.user.id !== guild.ownerId) {
    await replyPrivate(
      interaction,
      "Server Owner Only",
      "Only this server's actual owner can configure the Staff Grant Role.",
    );
    return;
  }

  const action = interaction.options.getSubcommand();
  let currentGrantRoleId: string | null;
  try {
    currentGrantRoleId = await getStaffGrantRoleId(guild.id);
  } catch {
    await replyPrivate(
      interaction,
      "Staff Settings Unavailable",
      "The Staff Grant Role setting could not be loaded. No changes were made.",
    );
    return;
  }

  if (action === "remove") {
    if (!currentGrantRoleId) {
      await replyPrivate(interaction, "Role Not Configured", "No Staff Grant Role is currently configured.", "info");
      return;
    }
    try {
      await setStaffGrantRoleId(guild.id, null);
      await replyPrivate(
        interaction,
        "Staff Grant Role Removed",
        "The Staff Grant Role is no longer configured.",
        "success",
      );
    } catch {
      await replyPrivate(
        interaction,
        "Staff Settings Not Saved",
        "The Staff Grant Role setting could not be removed.",
      );
    }
    return;
  }

  const selectedRole = interaction.options.getRole("role", true);
  const role = await guild.roles.fetch(selectedRole.id).catch(() => null);
  if (!role || role.id === guild.id || role.managed) {
    await replyPrivate(
      interaction,
      "Invalid Role",
      "Choose an available server role that is not @everyone or managed by an integration.",
    );
    return;
  }

  let moderationConfig;
  try {
    moderationConfig = await getModerationRoleConfig(guild.id);
  } catch {
    await replyPrivate(
      interaction,
      "Staff Settings Unavailable",
      "Existing moderation roles could not be verified. No changes were made.",
    );
    return;
  }
  const existingRoleIds = [
    moderationConfig?.adminRoleId,
    moderationConfig?.managerRoleId,
    moderationConfig?.warnRoleId,
    moderationConfig?.timeoutRoleId,
    moderationConfig?.staffRequestRoleId,
  ];
  if (existingRoleIds.includes(role.id)) {
    await replyPrivate(
      interaction,
      "Role Already In Use",
      "Choose a separate role so staff requests do not inherit moderation permissions.",
    );
    return;
  }

  try {
    await setStaffGrantRoleId(guild.id, role.id);
    await replyPrivate(
      interaction,
      "Staff Grant Role Saved",
      `The role <@&${role.id}> will be assigned after an eligible /staff request.`,
      "success",
    );
  } catch {
    await replyPrivate(
      interaction,
      "Staff Settings Not Saved",
      "The Staff Grant Role setting could not be saved.",
    );
  }
}

async function executeManage(
  guild: Guild | null,
  requesterId: string,
  targetId: string,
  reply: StaffReply,
): Promise<void> {
  if (!guild) {
    await reply("Server Only", "This command can only be used in a server.");
    return;
  }

  if (requesterId !== targetId && requesterId !== guild.ownerId) {
    let managerRoleId: string | null;
    try {
      managerRoleId =
        (await getModerationRoleConfig(guild.id))?.managerRoleId ?? null;
    } catch {
      await reply(
        "Role Settings Unavailable",
        "Manager access could not be verified, so this count was not shown.",
      );
      return;
    }
    if (!managerRoleId) {
      await reply(
        "Manager Role Not Configured",
        "Only the actual server owner can view another member's count until a Manager role is configured.",
      );
      return;
    }
    const [requester, managerRole] = await Promise.all([
      guild.members.fetch(requesterId).catch(() => null),
      guild.roles.fetch(managerRoleId).catch(() => null),
    ]);
    if (!requester || !managerRole || !requester.roles.cache.has(managerRole.id)) {
      await reply(
        "Manager Access Required",
        "Only a member with the configured Manager role or the actual server owner can view another member's count.",
      );
      return;
    }
  }

  try {
    const cases = await listModerationCases(guild.id, targetId, 2_147_483_647);
    const count = cases.filter((record) => record.action === "staff-grant").length;
    await reply(
      "Staff Grant Count",
      `<@${targetId}> has successfully received the configured Staff Grant Role **${count}** time(s) through /staff.`,
      "info",
    );
  } catch {
    await reply(
      "Staff Grant Count Unavailable",
      "The saved staff-grant records could not be loaded right now.",
    );
  }
}

const staffCommand: Command = {
  data: staffData,
  execute: (interaction) =>
    runStaffGrant(interaction.guild, interaction.user.id, (title, description, tone) =>
      replyPrivate(interaction, title, description, tone),
    ),
  executePrefix: (message: Message, args: string[]) => {
    if (args.length > 0) {
      return replyToMessage(message, "Usage", "Use the prefix followed by `staff`.");
    }
    return runStaffGrant(message.guild, message.author.id, (title, description, tone) =>
      replyToMessage(message, title, description, tone),
    );
  },
};

const manageCommand: Command = {
  data: manageData,
  execute: (interaction) => {
    const targetId =
      interaction.options.getUser("member")?.id ?? interaction.user.id;
    return executeManage(
      interaction.guild,
      interaction.user.id,
      targetId,
      (title, description, tone) =>
        replyPrivate(interaction, title, description, tone),
    );
  },
  executePrefix: (message: Message, args: string[]) => {
    const token = args[0];
    if (args.length > 1) {
      return replyToMessage(
        message,
        "Usage",
        "Use the prefix followed by `manage` and optionally one member mention or ID.",
      );
    }
    const match = token
      ? /^(?:<@!?(\d{16,20})>|(\d{16,20}))$/u.exec(token)
      : null;
    if (token && !match) {
      return replyToMessage(
        message,
        "Usage",
        "Use the prefix followed by `manage` and optionally one member mention or ID.",
      );
    }
    const targetId = match?.[1] ?? match?.[2] ?? message.author.id;
    return executeManage(
      message.guild,
      message.author.id,
      targetId,
      (title, description, tone) =>
        replyToMessage(message, title, description, tone),
    );
  },
};

const staffRoleCommand: Command = {
  data: staffRoleData,
  execute: executeStaffRole,
};

export const staffCommands: Command[] = [
  staffRoleCommand,
  staffCommand,
  manageCommand,
];
