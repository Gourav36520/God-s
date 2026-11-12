import {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  Guild,
  GuildBasedChannel,
  GuildMember,
  NonThreadGuildBasedChannel,
  OverwriteType,
  PermissionFlagsBits,
  Role,
  TextChannel,
} from "discord.js";
import { BaseSecurityModule } from "../BaseSecurityModule.js";
import type { SecurityManager } from "../SecurityManager.js";
import type { JudgmentRecord, JudgmentResult } from "../types.js";
import { loggingService } from "../../lib/registry.js";
import { logger } from "../../lib/logger.js";

const judgmentsInProgress = new Set<string>();

export interface SetupResult {
  success: boolean;
  reason: string;
  roleId?: string;
  channelId?: string;
  roleCreated: boolean;
  channelCreated: boolean;
  channelsPatched?: number;
}

export interface RepairStats {
  checked: number;
  repaired: number;
  skipped: number;
  errors: number;
}

type OverwriteOutcome = "applied" | "skipped" | "error";
type ViewOverwriteState = "allow" | "deny" | "unset";
type MemberOverwriteOutcome =
  | { status: "applied" }
  | { status: "skipped" }
  | { status: "error"; reason: string };

const MAX_CHANNEL_PERMISSION_OVERWRITES = 100;

function isIsolationDangerousRole(role: Role): boolean {
  return (
    role.permissions.has(PermissionFlagsBits.Administrator) ||
    role.permissions.has(PermissionFlagsBits.ManageChannels) ||
    role.permissions.has(PermissionFlagsBits.ManageRoles)
  );
}

function dangerousRoleManagementFailure(
  member: GuildMember,
  botMember: GuildMember,
  judgmentRoleId: string,
): string | null {
  if (isIsolationDangerousRole(member.guild.roles.everyone)) {
    return (
      "The @everyone role grants permissions that can bypass or alter channel isolation and " +
      "cannot be removed from an individual member. Remove those permissions before trying again."
    );
  }

  const dangerousRoles = member.roles.cache.filter(
    (role) =>
      role.id !== member.guild.roles.everyone.id &&
      role.id !== judgmentRoleId &&
      isIsolationDangerousRole(role),
  );
  const hasUnmappedDangerousPermission = [
    PermissionFlagsBits.Administrator,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles,
  ].some((permission) => member.permissions.has(permission));
  if (dangerousRoles.size === 0 && hasUnmappedDangerousPermission) {
    return (
      "The member has effective Administrator or channel/role management permissions that " +
      "could not be traced to a safely removable role. Refresh the member's roles and retry."
    );
  }
  if (dangerousRoles.size === 0) return null;

  const unmanageableRoles = dangerousRoles.filter((role) => !role.editable);
  const memberAtOrAboveBot =
    member.roles.highest.comparePositionTo(botMember.roles.highest) >= 0;
  if (unmanageableRoles.size === 0 && !memberAtOrAboveBot) return null;

  return (
    `This member has ${dangerousRoles.size} role(s) that can administer the server, channels, ` +
    `or roles, but the bot cannot safely remove them because of role hierarchy or integration ` +
    `management. Move the bot above the member's highest role and dangerous roles, or remove ` +
    `those roles before trying again.`
  );
}

function channelKind(
  channel: NonThreadGuildBasedChannel,
  judgmentChannelId: string
): "judgment" | "voice" | "text" {
  if (channel.id === judgmentChannelId) return "judgment";
  if (
    channel.type === ChannelType.GuildVoice ||
    channel.type === ChannelType.GuildStageVoice
  )
    return "voice";
  if (
    channel.type === ChannelType.GuildText ||
    channel.type === ChannelType.GuildAnnouncement ||
    channel.type === ChannelType.GuildForum ||
    channel.type === ChannelType.GuildMedia ||
    channel.type === ChannelType.GuildCategory
  )
    return "text";
  // Unknown non-thread guild channels are locked as text-like channels rather
  // than silently excluded from the isolation policy.
  return "text";
}

function viewOverwriteState(
  channel: NonThreadGuildBasedChannel,
  targetId: string,
): ViewOverwriteState {
  const overwrite = channel.permissionOverwrites.cache.get(targetId);
  if (overwrite?.allow.has(PermissionFlagsBits.ViewChannel)) return "allow";
  if (overwrite?.deny.has(PermissionFlagsBits.ViewChannel)) return "deny";
  return "unset";
}

function hasCorrectViewOverwrite(
  channel: NonThreadGuildBasedChannel,
  targetId: string,
  shouldAllow: boolean,
): boolean {
  return viewOverwriteState(channel, targetId) === (shouldAllow ? "allow" : "deny");
}

export class GodsJudgment extends BaseSecurityModule {
  constructor(manager: SecurityManager) {
    super("godsJudgment", manager);
  }

  get name() {
    return "God's Judgment";
  }

  get description() {
    return "Strips manageable roles from a user and denies all server channel access until release.";
  }

  // ─── Channel-level overwrite helpers ─────────────────────────────────────

  /**
   * Apply the correct judgment-role permission overwrite to a single channel.
   *
   * Judgment channel  → DENY  ViewChannel, ReadMessageHistory, SendMessages
   * Voice channel      → DENY  ViewChannel, Connect, Speak
   * Text/category/etc. → DENY  ViewChannel, SendMessages, AddReactions, threads
   * Threads inherit the denied parent-channel visibility.
   */
  private async applyOverwritesToChannel(
    channel: NonThreadGuildBasedChannel,
    judgmentRoleId: string,
    judgmentChannelId: string
  ): Promise<OverwriteOutcome> {
    const kind = channelKind(channel, judgmentChannelId);
    if (this.isOverwriteCorrect(channel, judgmentRoleId, judgmentChannelId)) {
      return "skipped";
    }

    try {
      if (kind === "voice") {
        await channel.permissionOverwrites.edit(
          judgmentRoleId,
          {
            ViewChannel: false,
            Connect: false,
            Speak: false,
          },
          { reason: "God's Judgment: voice lockout" }
        );
        return "applied";
      }

      // text / category / announcement / forum / media
      await channel.permissionOverwrites.edit(
        judgmentRoleId,
        {
          ViewChannel: false,
          SendMessages: false,
          AddReactions: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          SendMessagesInThreads: false,
        },
        { reason: "God's Judgment: text lockout" }
      );
      return "applied";
    } catch (err) {
      logger.warn(
        `GodsJudgment: overwrite failed on #${channel.name ?? channel.id} ` +
          `(${ChannelType[channel.type] ?? channel.type}) — ` +
          (err instanceof Error ? err.message : String(err))
      );
      return "error";
    }
  }

  /**
   * Returns true when the channel already has a correct overwrite for the
   * judgment role. Used by validateAndRepair to skip unchanged channels.
   */
  private isOverwriteCorrect(
    channel: NonThreadGuildBasedChannel,
    judgmentRoleId: string,
    judgmentChannelId: string
  ): boolean {
    const ow = channel.permissionOverwrites.cache.get(judgmentRoleId);

    if (!ow) return false;

    const kind = channelKind(channel, judgmentChannelId);

    if (kind === "voice") {
      return (
        ow.deny.has(PermissionFlagsBits.ViewChannel) &&
        !ow.allow.has(PermissionFlagsBits.ViewChannel) &&
        ow.deny.has(PermissionFlagsBits.Connect)
      );
    }

    return (
      ow.deny.has(PermissionFlagsBits.ViewChannel) &&
      !ow.allow.has(PermissionFlagsBits.ViewChannel)
    );
  }

  private async ensureJudgmentRoleHasNoPermissions(role: Role): Promise<string | null> {
    if (role.permissions.bitfield === 0n) return null;
    if (!role.editable) {
      return "The Judgment role has server permissions but is above the bot or managed; move it below the bot so its permissions can be cleared.";
    }
    try {
      await role.setPermissions(0n, "God's Judgment role must not have server permissions");
      return null;
    } catch (error) {
      return `Could not clear permissions from the Judgment role: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  }

  private async captureMemberViewPermissions(
    guild: Guild,
    memberId: string,
  ): Promise<
    | { snapshot: Record<string, ViewOverwriteState> }
    | { error: string }
  > {
    try {
      await guild.channels.fetch();
    } catch (error) {
      return {
        error:
          `Could not fetch every server channel before applying Judgment: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const snapshot: Record<string, ViewOverwriteState> = {};
    for (const channel of guild.channels.cache.values()) {
      if (channel.isThread()) continue;
      if (!("permissionOverwrites" in channel)) {
        return {
          error: "A server channel does not expose permission overwrites, so isolation cannot be verified.",
        };
      }
      if (
        !channel.permissionOverwrites.cache.has(memberId) &&
        channel.permissionOverwrites.cache.size >= MAX_CHANNEL_PERMISSION_OVERWRITES
      ) {
        return {
          error:
            `Channel #${channel.name ?? channel.id} already has ` +
            `${MAX_CHANNEL_PERMISSION_OVERWRITES} permission overwrites. Discord's per-channel ` +
            `overwrite limit prevents adding the member-specific isolation rule.`,
        };
      }
      snapshot[channel.id] = viewOverwriteState(
        channel as NonThreadGuildBasedChannel,
        memberId,
      );
    }
    return { snapshot };
  }

  private async applyMemberOverwriteToChannel(
    channel: NonThreadGuildBasedChannel,
    member: GuildMember,
    judgmentChannelId: string,
  ): Promise<MemberOverwriteOutcome> {
    const shouldAllow = false;
    if (hasCorrectViewOverwrite(channel, member.id, shouldAllow)) {
      return { status: "skipped" };
    }
    try {
      await channel.permissionOverwrites.edit(
        member,
        { ViewChannel: shouldAllow },
        {
          reason:
            channel.id === judgmentChannelId
              ? "God's Judgment: members cannot view any server channel"
              : "God's Judgment: isolate this member from server channels",
        },
      );
      return { status: "applied" };
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : String(error);
      logger.warn(
        `GodsJudgment: member overwrite failed for member=${member.id} ` +
          `channel=${channel.id} — ${reason}`,
      );
      return { status: "error", reason };
    }
  }

  private async persistJudgmentRecord(
    guildId: string,
    record: JudgmentRecord,
  ): Promise<void> {
    const activeJudgments =
      this.manager.getConfig(guildId).godsJudgment.activeJudgments;
    await this.manager.updateModuleConfig(guildId, "godsJudgment", {
      activeJudgments: {
        ...activeJudgments,
        [record.userId]: record,
      },
    });
  }

  private async applyMemberIsolationBeforeRoleRemoval(
    member: GuildMember,
  ): Promise<string[]> {
    try {
      await member.guild.channels.fetch();
    } catch (error) {
      return [
        `Could not refresh server channels before isolating the member: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ];
    }

    const cfg = this.manager.getConfig(member.guild.id).godsJudgment;
    const failures: string[] = [];
    for (const channel of member.guild.channels.cache.values()) {
      if (channel.isThread()) continue;
      const result = await this.applyMemberOverwriteToChannel(
        channel as NonThreadGuildBasedChannel,
        member,
        cfg.judgmentChannelId ?? "",
      );
      if (result.status === "error") {
        failures.push(
          `Could not deny ${member.user.tag} access to #${channel.name ?? channel.id}: ${result.reason}`,
        );
      }
    }
    return failures;
  }

  private async applyActiveMemberOverwritesToChannel(
    channel: NonThreadGuildBasedChannel,
    activeJudgments: Record<string, JudgmentRecord>,
    judgmentChannelId: string,
    respectInProgressLocks = false,
  ): Promise<{
    applied: number;
    skipped: number;
    errors: number;
    activeJudgments: Record<string, JudgmentRecord>;
  }> {
    const members = new Map<string, GuildMember>();
    const limitationDetails = new Map<string, string[]>();
    let updatedJudgments = activeJudgments;
    const judgmentRoleId =
      this.manager.getConfig(channel.guildId).godsJudgment.judgmentRoleId;

    for (const [memberId, record] of Object.entries(activeJudgments)) {
      if (
        respectInProgressLocks &&
        judgmentsInProgress.has(`${channel.guildId}:${memberId}`)
      ) {
        continue;
      }
      if (memberId === channel.guild.ownerId) {
        logger.error(
          `GodsJudgment: ignored an invalid active record for server owner ${memberId}.`,
        );
        continue;
      }
      const member =
        channel.guild.members.cache.get(memberId) ??
        (await channel.guild.members.fetch(memberId).catch(() => null));
      if (!member) continue;
      members.set(memberId, member);

      const limitations: string[] = [];
      if (member.permissions.has(PermissionFlagsBits.Administrator)) {
        limitations.push(
          "The member retains Administrator, which bypasses all channel overwrites.",
        );
      }
      if (
        member.roles.cache.some(
          (role) =>
            role.id !== channel.guild.roles.everyone.id &&
            role.id !== judgmentRoleId &&
            (
              role.permissions.has(PermissionFlagsBits.ManageChannels) ||
              role.permissions.has(PermissionFlagsBits.ManageRoles)
            ),
        )
      ) {
        limitations.push(
          "The member retains a role that can change channel permissions or roles.",
        );
      }
      if (limitations.length > 0) {
        limitationDetails.set(memberId, limitations);
      }

      if (record.savedChannelViewPermissions?.[channel.id] !== undefined) continue;
      updatedJudgments = {
        ...updatedJudgments,
        [memberId]: {
          ...record,
          savedChannelViewPermissions: {
            ...record.savedChannelViewPermissions,
            [channel.id]: viewOverwriteState(channel, memberId),
          },
        },
      };
    }

    if (updatedJudgments !== activeJudgments) {
      try {
        const currentJudgments =
          this.manager.getConfig(channel.guildId).godsJudgment.activeJudgments;
        const mergedJudgments = { ...currentJudgments };
        for (const [memberId, updatedRecord] of Object.entries(updatedJudgments)) {
          const currentRecord = currentJudgments[memberId];
          const savedState =
            updatedRecord.savedChannelViewPermissions?.[channel.id];
          if (
            !currentRecord ||
            currentRecord.savedChannelViewPermissions?.[channel.id] !== undefined ||
            savedState === undefined
          ) {
            continue;
          }
          mergedJudgments[memberId] = {
            ...currentRecord,
            savedChannelViewPermissions: {
              ...currentRecord.savedChannelViewPermissions,
              [channel.id]: savedState,
            },
          };
        }
        const saved = await this.manager.updateModuleConfig(
          channel.guildId,
          "godsJudgment",
          { activeJudgments: mergedJudgments },
        );
        updatedJudgments = saved.godsJudgment.activeJudgments;
      } catch (error) {
        logger.error(
          `GodsJudgment: could not save original member channel permissions ` +
            `for channel=${channel.id} — ${
              error instanceof Error ? error.message : String(error)
            }`,
        );
        return {
          applied: 0,
          skipped: 0,
          errors: Math.max(1, members.size),
          activeJudgments,
        };
      }
    }

    let applied = 0;
    let skipped = Object.keys(activeJudgments).length - members.size;
    let errors = limitationDetails.size;
    const failureDetailsByMember = new Map<string, string[]>(limitationDetails);
    for (const member of members.values()) {
      const result = await this.applyMemberOverwriteToChannel(
        channel,
        member,
        judgmentChannelId,
      );
      if (result.status === "applied") applied++;
      else if (result.status === "skipped") skipped++;
      else {
        errors++;
        failureDetailsByMember.set(member.id, [
          ...(failureDetailsByMember.get(member.id) ?? []),
          `Could not enforce member-specific ViewChannel isolation in channel ` +
            `${channel.name ?? channel.id}: ${result.reason}`,
        ]);
      }
    }

    if (failureDetailsByMember.size > 0) {
      const failedJudgments = {
        ...this.manager.getConfig(channel.guildId).godsJudgment.activeJudgments,
      };
      for (const [memberId, failures] of failureDetailsByMember) {
        const record = failedJudgments[memberId];
        if (!record) continue;
        failedJudgments[memberId] = {
          ...record,
          partial: true,
          failureDetails: [
            ...new Set([...(record.failureDetails ?? []), ...failures]),
          ],
        };
      }
      try {
        const saved = await this.manager.updateModuleConfig(
          channel.guildId,
          "godsJudgment",
          { activeJudgments: failedJudgments },
        );
        updatedJudgments = saved.godsJudgment.activeJudgments;
      } catch (error) {
        logger.error(
          `GodsJudgment: failed to record incomplete channel isolation ` +
            `for channel=${channel.id} — ${
              error instanceof Error ? error.message : String(error)
            }`,
        );
      }
    }

    return { applied, skipped, errors, activeJudgments: updatedJudgments };
  }

  // ─── Guild-wide overwrite application ────────────────────────────────────

  /**
   * Applies judgment overwrites to every channel in the guild.
   * Called after setup() and placeInJudgment() to ensure coverage.
   */
  async applyOverwritesToAllChannels(
    guild: Guild,
    judgmentRoleId: string,
    judgmentChannelId: string
  ): Promise<{ applied: number; skipped: number; errors: number }> {
    try {
      await guild.channels.fetch();
    } catch (error) {
      logger.error(
        `GodsJudgment.applyOverwritesToAllChannels: could not fetch guild channels ` +
          `guild=${guild.id} — ${error instanceof Error ? error.message : String(error)}`,
      );
      return { applied: 0, skipped: 0, errors: 1 };
    }

    let applied = 0;
    let skipped = 0;
    let errors = 0;
    let activeJudgments =
      this.manager.getConfig(guild.id).godsJudgment.activeJudgments;

    for (const [, ch] of guild.channels.cache) {
      if (ch.isThread()) {
        skipped++;
        continue;
      }
      if (!("permissionOverwrites" in ch)) {
        skipped++;
        continue;
      }
      const result = await this.applyOverwritesToChannel(
        ch as NonThreadGuildBasedChannel,
        judgmentRoleId,
        judgmentChannelId
      );
      const memberResult = await this.applyActiveMemberOverwritesToChannel(
        ch as NonThreadGuildBasedChannel,
        activeJudgments,
        judgmentChannelId,
      );
      activeJudgments = memberResult.activeJudgments;
      if (result === "applied" || memberResult.applied > 0) applied++;
      else if (result === "skipped" && memberResult.errors === 0) skipped++;
      if (result === "error") errors++;
      errors += memberResult.errors;
      skipped += memberResult.skipped;
    }

    logger.info(
      `GodsJudgment.applyOverwritesToAllChannels: guild=${guild.name} ` +
        `applied=${applied} skipped=${skipped} errors=${errors}`
    );

    return { applied, skipped, errors };
  }

  // ─── Startup validation & repair ─────────────────────────────────────────

  /**
   * Checks every channel in the guild and repairs any missing or incorrect
   * judgment-role overwrites. Called on bot startup for every guild that
   * has God's Judgment configured.
   */
  async validateAndRepair(guild: Guild): Promise<RepairStats> {
    const cfg = this.manager.getConfig(guild.id).godsJudgment;
    const hasActiveJudgments = Object.keys(cfg.activeJudgments).length > 0;

    if (
      hasActiveJudgments &&
      (!cfg.judgmentRoleId || !cfg.judgmentChannelId)
    ) {
      logger.error(
        `GodsJudgment.validateAndRepair: active judgments exist but the role or ` +
          `confinement channel is not configured in guild=${guild.id}.`,
      );
      return { checked: 0, repaired: 0, skipped: 0, errors: 1 };
    }

    if (
      (!cfg.enabled && !hasActiveJudgments) ||
      !cfg.judgmentRoleId ||
      !cfg.judgmentChannelId
    ) {
      logger.info(
        `GodsJudgment.validateAndRepair: guild "${guild.name}" — ` +
          `not fully configured (enabled=${cfg.enabled} role=${cfg.judgmentRoleId ?? "null"} ` +
          `channel=${cfg.judgmentChannelId ?? "null"}), skipping.`
      );
      return { checked: 0, repaired: 0, skipped: 0, errors: 0 };
    }

    const { judgmentRoleId, judgmentChannelId } = cfg;

    let checked = 0;
    let repaired = 0;
    let skipped = 0;
    let errors = 0;
    let activeJudgments = cfg.activeJudgments;

    try {
      await guild.channels.fetch();
    } catch (error) {
      logger.error(
        `GodsJudgment.validateAndRepair: could not fetch guild channels guild=${guild.id} — ` +
          (error instanceof Error ? error.message : String(error)),
      );
      return { checked: 0, repaired: 0, skipped: 0, errors: 1 };
    }

    const judgmentRole =
      guild.roles.cache.get(judgmentRoleId) ??
      (await guild.roles.fetch(judgmentRoleId).catch(() => null));
    if (!judgmentRole) {
      logger.error(
        `GodsJudgment.validateAndRepair: configured role ${judgmentRoleId} is missing in guild=${guild.id}`,
      );
      return { checked: 0, repaired: 0, skipped: 0, errors: 1 };
    }
    const roleSafetyError = await this.ensureJudgmentRoleHasNoPermissions(judgmentRole);
    if (roleSafetyError) {
      logger.error(`GodsJudgment.validateAndRepair: ${roleSafetyError}`);
      errors++;
    }

    for (const [, ch] of guild.channels.cache) {
      if (ch.isThread()) {
        skipped++;
        continue;
      }
      if (!("permissionOverwrites" in ch)) {
        errors++;
        continue;
      }

      checked++;
      const channel = ch as NonThreadGuildBasedChannel;

      let roleResult: OverwriteOutcome = "skipped";
      if (!this.isOverwriteCorrect(channel, judgmentRoleId, judgmentChannelId)) {
        logger.info(
          `GodsJudgment.validateAndRepair: repairing #${channel.name ?? channel.id} ` +
            `(${ChannelType[channel.type] ?? channel.type})`
        );
        roleResult = await this.applyOverwritesToChannel(
          channel,
          judgmentRoleId,
          judgmentChannelId
        );
      }

      const memberResult = await this.applyActiveMemberOverwritesToChannel(
        channel,
        activeJudgments,
        judgmentChannelId,
      );
      activeJudgments = memberResult.activeJudgments;

      if (roleResult === "applied" || memberResult.applied > 0) repaired++;
      if (roleResult === "error") errors++;
      errors += memberResult.errors;
      skipped += memberResult.skipped;
    }

    logger.info(
      `GodsJudgment.validateAndRepair [${guild.name}]: ` +
        `checked=${checked} repaired=${repaired} skipped=${skipped} errors=${errors}`
    );

    if (errors > 0) {
      logger.error(
        `GodsJudgment.validateAndRepair: could not verify complete isolation in ` +
          `"${guild.name}" (${errors} permission or role limitation(s)).`,
      );
    } else if (repaired > 0) {
      logger.warn(
        `GodsJudgment.validateAndRepair: ⚠️  Repaired ${repaired} channel(s) in "${guild.name}". ` +
          `If this keeps happening, check that the bot's role is above "God's Judgment".`
      );
    } else {
      logger.info(
        `GodsJudgment.validateAndRepair: ✓ All ${checked} channel(s) in "${guild.name}" are correctly configured.`
      );
    }

    return { checked, repaired, skipped, errors };
  }

  private async reconcileChannel(
    channel: NonThreadGuildBasedChannel,
    eventName: string,
  ): Promise<void> {
    const cfg = this.manager.getConfig(channel.guildId).godsJudgment;
    if (
      !cfg.judgmentRoleId ||
      !cfg.judgmentChannelId ||
      (!cfg.enabled && Object.keys(cfg.activeJudgments).length === 0)
    ) {
      return;
    }

    const role =
      channel.guild.roles.cache.get(cfg.judgmentRoleId) ??
      (await channel.guild.roles.fetch(cfg.judgmentRoleId).catch(() => null));
    if (!role) {
      logger.error(
        `GodsJudgment.${eventName}: configured Judgment role ${cfg.judgmentRoleId} is missing.`,
      );
      return;
    }
    const roleSafetyError = await this.ensureJudgmentRoleHasNoPermissions(role);
    if (roleSafetyError) {
      logger.error(`GodsJudgment.${eventName}: ${roleSafetyError}`);
    }

    const roleResult = await this.applyOverwritesToChannel(
      channel,
      cfg.judgmentRoleId,
      cfg.judgmentChannelId,
    );
    const memberResult = await this.applyActiveMemberOverwritesToChannel(
      channel,
      cfg.activeJudgments,
      cfg.judgmentChannelId,
      true,
    );
    if (roleResult === "error" || memberResult.errors > 0) {
      logger.error(
        `GodsJudgment.${eventName}: isolation update incomplete for channel=${channel.id}; ` +
          `member overwrite errors=${memberResult.errors}.`,
      );
    }
  }

  private async reconcileActiveMember(
    member: GuildMember,
    record: JudgmentRecord,
    source: string,
  ): Promise<void> {
    if (member.id === member.guild.ownerId) {
      logger.error(
        `GodsJudgment.${source}: refused to modify server owner roles or permissions.`,
      );
      return;
    }

    const operationKey = `${member.guild.id}:${member.id}`;
    if (judgmentsInProgress.has(operationKey)) return;

    const cfg = this.manager.getConfig(member.guild.id).godsJudgment;
    if (!cfg.judgmentRoleId) {
      logger.error(
        `GodsJudgment.${source}: active member ${member.id} has no configured Judgment role.`,
      );
      return;
    }
    const hasRole = member.roles.cache.has(cfg.judgmentRoleId);
    const hasOtherRoles = member.roles.cache.some(
      (role) =>
        role.id !== member.guild.roles.everyone.id &&
        role.id !== cfg.judgmentRoleId,
    );
    if (hasRole && !hasOtherRoles) {
      if (member.permissions.has(PermissionFlagsBits.Administrator)) {
        const failure =
          "Member still has Administrator, which bypasses all channel overwrites.";
        record.partial = true;
        record.failureDetails = [...new Set([...(record.failureDetails ?? []), failure])];
        await this.manager.updateModuleConfig(member.guild.id, "godsJudgment", {
          activeJudgments: {
            ...this.manager.getConfig(member.guild.id).godsJudgment.activeJudgments,
            [member.id]: record,
          },
        }).catch((error: unknown) => {
          logger.error(
            `GodsJudgment.${source}: could not persist Administrator limitation for ` +
              `member=${member.id} — ${
                error instanceof Error ? error.message : String(error)
              }`,
          );
        });
        logger.error(
          `GodsJudgment.${source}: cannot isolate member=${member.id}; ` +
            `Discord Administrator permission bypasses channel overwrites.`,
        );
      }
      return;
    }

    judgmentsInProgress.add(operationKey);
    try {
      const result = await this.repairHalfJudgedState(
        member,
        record,
        source,
      );
      if (!result.success || result.partial) {
        logger.error(
          `GodsJudgment.${source}: could not fully restore isolation for member=${member.id}: ` +
            result.reason,
        );
      }
    } catch (error) {
      logger.error(
        `GodsJudgment.${source}: member isolation repair failed for member=${member.id} — ` +
          (error instanceof Error ? error.message : String(error)),
      );
    } finally {
      judgmentsInProgress.delete(operationKey);
    }
  }

  // ─── Runtime event registration ──────────────────────────────────────────

  /**
   * Registers the handlers required to keep Judgment isolation in force:
   *
   * - channelCreate/channelUpdate keep channel and member overwrites correct.
   * - guildMemberUpdate restores the Judgment role if it is removed or other
   *   roles are added while the member is still active.
   * - guildRoleUpdate clears permissions from the Judgment role and repairs
   *   active members affected by newly privileged roles.
   * - messageCreate remains a final leak detector.
   */
  register(client: Client): void {
    client.on(Events.ChannelCreate, async (channel: GuildBasedChannel) => {
      if (!("guildId" in channel) || !channel.guildId) return;
      if (channel.isThread()) return;
      if (!("permissionOverwrites" in channel)) return;
      await this.reconcileChannel(
        channel as NonThreadGuildBasedChannel,
        "channelCreate",
      );
    });

    client.on(
      Events.ChannelUpdate,
      async (_oldChannel, updatedChannel) => {
        if (!("guildId" in updatedChannel) || !updatedChannel.guildId) return;
        if (updatedChannel.isThread()) return;
        if (!("permissionOverwrites" in updatedChannel)) return;
        await this.reconcileChannel(
          updatedChannel as NonThreadGuildBasedChannel,
          "channelUpdate",
        );
      },
    );

    client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
      const cfg = this.manager.getConfig(newMember.guild.id).godsJudgment;
      const record = cfg.activeJudgments[newMember.id];
      if (!record || !cfg.judgmentRoleId) return;
      const previousRoles = oldMember.roles.cache.map((role) => role.id).sort();
      const currentRoles = newMember.roles.cache.map((role) => role.id).sort();
      if (
        previousRoles.length === currentRoles.length &&
        previousRoles.every((roleId, index) => roleId === currentRoles[index])
      ) {
        return;
      }
      await this.reconcileActiveMember(newMember, record, "guildMemberUpdate");
    });

    client.on(Events.GuildRoleUpdate, async (_oldRole, updatedRole) => {
      const cfg = this.manager.getConfig(updatedRole.guild.id).godsJudgment;
      if (updatedRole.id === cfg.judgmentRoleId) {
        const roleSafetyError =
          await this.ensureJudgmentRoleHasNoPermissions(updatedRole);
        if (roleSafetyError) {
          logger.error(`GodsJudgment.guildRoleUpdate: ${roleSafetyError}`);
        }
      }

      const canAlterIsolation =
        updatedRole.permissions.has(PermissionFlagsBits.Administrator) ||
        updatedRole.permissions.has(PermissionFlagsBits.ManageChannels) ||
        updatedRole.permissions.has(PermissionFlagsBits.ManageRoles);
      if (!canAlterIsolation) return;

      for (const [memberId, record] of Object.entries(cfg.activeJudgments)) {
        const member =
          updatedRole.guild.members.cache.get(memberId) ??
          (await updatedRole.guild.members.fetch(memberId).catch(() => null));
        if (member?.roles.cache.has(updatedRole.id)) {
          await this.reconcileActiveMember(
            member,
            record,
            "guildRoleUpdate",
          );
        }
      }
    });

    // ── Real-time leak repair ───────────────────────────────────────────────
    client.on(Events.MessageCreate, async (message) => {
      if (!message.inGuild() || message.author.bot) return;

      const cfg = this.manager.getConfig(message.guildId).godsJudgment;
      if (
        (!cfg.enabled && Object.keys(cfg.activeJudgments).length === 0) ||
        !cfg.judgmentRoleId
      ) return;

      const record = cfg.activeJudgments[message.author.id];
      if (!record || !message.member?.roles.cache.has(cfg.judgmentRoleId)) return;

      // A judged member must not be able to send messages in any server channel.
      logger.error(
        `GodsJudgment: ‼ PERMISSION LEAK — ${message.author.tag} (${message.author.id}) ` +
          `sent a message in channel ${message.channelId} ` +
          `while under Judgment. Deleting + repairing now.`
      );

      // 1. Delete the message
      if (message.deletable) {
        await message
          .delete()
          .catch((e) =>
            logger.warn(
              `GodsJudgment: could not delete leaked message — ${e instanceof Error ? e.message : String(e)}`
            )
          );
      }

      // 2. Immediately repair this specific channel
      if ("permissionOverwrites" in message.channel && cfg.judgmentChannelId) {
        const repairResult = await this.applyOverwritesToChannel(
          message.channel as unknown as NonThreadGuildBasedChannel,
          cfg.judgmentRoleId,
          cfg.judgmentChannelId,
        );
        logger.warn(
          `GodsJudgment: immediate channel repair for ${message.channelId}: ${repairResult}`
        );
      }

      // 3. Full guild validation to catch any other broken channels
      if (message.guild) {
        const stats = await this.validateAndRepair(message.guild);
        logger.warn(
          `GodsJudgment: full repair triggered — ` +
            `repaired=${stats.repaired}/${stats.checked} channel(s)`
        );
      }
    });

    logger.info(
      "GodsJudgment: registered channel, member, role, and message isolation handlers",
    );
  }

  // ─── Setup ───────────────────────────────────────────────────────────────

  async setup(guild: Guild): Promise<SetupResult> {
    logger.info(`GodsJudgment.setup: starting for guild ${guild.id} (${guild.name})`);

    const botMember = guild.members.me;
    if (!botMember) {
      return fail("Bot member not found in guild cache. Try again in a moment.");
    }
    logger.info(`GodsJudgment.setup: bot member resolved (${botMember.user.tag})`);

    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      return fail("Bot is missing the **Manage Roles** permission. Grant it in Server Settings → Roles.");
    }
    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
      return fail("Bot is missing the **Manage Channels** permission. Grant it in Server Settings → Roles.");
    }

    const botHighest = botMember.roles.highest;
    logger.info(
      `GodsJudgment.setup: bot's highest role "${botHighest.name}" (position ${botHighest.position})`
    );
    if (botHighest.position < 1) {
      return fail(
        "Bot's highest role is at position 0. Move the bot role above other roles so it can manage them."
      );
    }

    const gjConfig = this.manager.getConfig(guild.id).godsJudgment;
    let roleCreated = false;
    let channelCreated = false;

    // ── Ensure judgment role ────────────────────────────────────────────────
    let judgmentRole =
      gjConfig.judgmentRoleId
        ? (guild.roles.cache.get(gjConfig.judgmentRoleId) ??
            (await guild.roles.fetch(gjConfig.judgmentRoleId).catch(() => null)))
        : null;

    if (judgmentRole) {
      logger.info(
        `GodsJudgment.setup: found existing judgment role "${judgmentRole.name}" (${judgmentRole.id})`
      );
    } else {
      logger.info("GodsJudgment.setup: creating judgment role...");
      try {
        judgmentRole = await guild.roles.create({
          name: "God's Judgment",
          color: 0x2b2d31,
          permissions: 0n,
          reason: "God's Judgment system setup",
        });
        roleCreated = true;
        logger.info(`GodsJudgment.setup: ✓ role created — id=${judgmentRole.id}`);
      } catch (err) {
        return fail(
          `Failed to create the judgment role: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (!judgmentRole.editable) {
      return fail(
        "The Judgment role must be below the bot's highest role so its permissions and channel overwrites can be secured.",
      );
    }
    const roleSafetyError = await this.ensureJudgmentRoleHasNoPermissions(judgmentRole);
    if (roleSafetyError) return fail(roleSafetyError);

    // ── Ensure judgment channel ─────────────────────────────────────────────
    let judgmentChannel: TextChannel | null =
      gjConfig.judgmentChannelId
        ? ((guild.channels.cache.get(gjConfig.judgmentChannelId) ??
            (await guild.channels.fetch(gjConfig.judgmentChannelId).catch(() => null))) as TextChannel | null)
        : null;

    if (judgmentChannel) {
      logger.info(
        `GodsJudgment.setup: found existing judgment channel #${judgmentChannel.name} (${judgmentChannel.id})`
      );
      // The configured Judgment channel is also hidden from judged members.
      await judgmentChannel.permissionOverwrites.edit(
        judgmentRole.id,
        {
          ViewChannel: false,
          ReadMessageHistory: false,
          SendMessages: false,
          AddReactions: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          SendMessagesInThreads: false,
        },
        { reason: "God's Judgment setup — deny all judged-member channel access" }
      ).catch((e) => logger.warn(`GodsJudgment.setup: could not update judgment channel overwrite — ${e instanceof Error ? e.message : String(e)}`));
    } else {
      logger.info("GodsJudgment.setup: creating judgment channel...");
      try {
        judgmentChannel = (await guild.channels.create({
          name: "gods-judgment",
          type: ChannelType.GuildText,
          topic: "Staff management channel. Members under God's Judgment cannot view server channels.",
          permissionOverwrites: [
            // @everyone cannot see the channel at all
            {
              id: guild.roles.everyone.id,
              type: OverwriteType.Role,
              deny: [PermissionFlagsBits.ViewChannel],
            },
            // The Judgment role cannot view any server channel.
            {
              id: judgmentRole.id,
              type: OverwriteType.Role,
              deny: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.AddReactions,
                PermissionFlagsBits.CreatePublicThreads,
                PermissionFlagsBits.CreatePrivateThreads,
                PermissionFlagsBits.SendMessagesInThreads,
              ],
            },
          ],
          reason: "God's Judgment system setup",
        })) as TextChannel;
        channelCreated = true;
        logger.info(`GodsJudgment.setup: ✓ channel created — id=${judgmentChannel.id}`);
      } catch (err) {
        return {
          success: false,
          reason: `Failed to create the judgment channel: ${err instanceof Error ? err.message : String(err)}`,
          roleId: judgmentRole.id,
          roleCreated,
          channelCreated: false,
        };
      }
    }

    // ── Save config ─────────────────────────────────────────────────────────
    try {
      await this.manager.updateModuleConfig(guild.id, "godsJudgment", {
        judgmentRoleId: judgmentRole.id,
        judgmentChannelId: judgmentChannel.id,
        enabled: true,
      });
      logger.info("GodsJudgment.setup: ✓ config saved");
    } catch (err) {
      return {
        success: false,
        reason: `Role and channel created, but config save failed: ${err instanceof Error ? err.message : String(err)}`,
        roleId: judgmentRole.id,
        channelId: judgmentChannel.id,
        roleCreated,
        channelCreated,
      };
    }

    // ── Apply overwrites to every existing channel ─────────────────────────
    logger.info("GodsJudgment.setup: applying overwrites to all existing channels...");
    const patchStats = await this.applyOverwritesToAllChannels(
      guild,
      judgmentRole.id,
      judgmentChannel.id
    );
    logger.info(
      `GodsJudgment.setup: ✓ channel overwrites applied — ` +
        `applied=${patchStats.applied} skipped=${patchStats.skipped} errors=${patchStats.errors}`
    );

    if (patchStats.errors > 0) {
      return {
        success: false,
        reason:
          `Judgment role and channel were saved, but channel isolation is incomplete: ` +
          `${patchStats.errors} permission or role limitation(s) were found. Check for ` +
          `Administrator or other privileged roles, bot Manage Channels access, role hierarchy, ` +
          `and Discord's per-channel overwrite limit, then run setup again.`,
        roleId: judgmentRole.id,
        channelId: judgmentChannel.id,
        roleCreated,
        channelCreated,
        channelsPatched: patchStats.applied,
      };
    }

    logger.info(`GodsJudgment.setup: ✓ complete for guild ${guild.id}`);
    return {
      success: true,
      reason: "Setup complete",
      roleId: judgmentRole.id,
      channelId: judgmentChannel.id,
      roleCreated,
      channelCreated,
      channelsPatched: patchStats.applied,
    };
  }

  // ─── Punishment & release ─────────────────────────────────────────────────

  async placeInJudgment(
    member: GuildMember,
    reason: string,
    judgedBy: string
  ): Promise<JudgmentResult> {
    logger.info(
      `GodsJudgment.placeInJudgment: user=${member.user.tag} (${member.id}) guild=${member.guild.id}`
    );

    if (member.id === member.guild.ownerId) {
      return { success: false, reason: "The server owner cannot be placed under God's Judgment." };
    }

    const cfg = this.manager.getConfig(member.guild.id).godsJudgment;

    if (!cfg.judgmentRoleId) {
      return { success: false, reason: "God's Judgment role is not set up. Run `/judgment setup` first." };
    }

    const judgmentRole = member.guild.roles.cache.get(cfg.judgmentRoleId);
    if (!judgmentRole) {
      return {
        success: false,
        reason: "God's Judgment role not found. Run `/judgment setup` to recreate it.",
      };
    }
    const botMember = member.guild.members.me;
    if (
      !botMember?.permissions.has(PermissionFlagsBits.ManageRoles) ||
      !botMember.permissions.has(PermissionFlagsBits.ManageChannels) ||
      !judgmentRole.editable
    ) {
      return {
        success: false,
        reason:
          "God's Judgment isolation was not completed. The bot needs Manage Roles and Manage Channels, with its highest role above the configured Judgment role.",
      };
    }
    const roleSafetyError = await this.ensureJudgmentRoleHasNoPermissions(judgmentRole);
    if (roleSafetyError) return { success: false, reason: roleSafetyError };

    if (!cfg.judgmentChannelId) {
      return {
        success: false,
        reason: "God's Judgment channel is not set up. Run `/judgment setup` first.",
      };
    }

    const dangerousRoleError = dangerousRoleManagementFailure(
      member,
      botMember,
      judgmentRole.id,
    );
    if (dangerousRoleError) {
      return {
        success: false,
        reason: `God's Judgment isolation was not completed. ${dangerousRoleError}`,
      };
    }

    // ── Self-healing state detection ───────────────────────────────────────
    const existingRecord = cfg.activeJudgments[member.id];
    const hasJudgmentRole = member.roles.cache.has(cfg.judgmentRoleId);

    if (existingRecord) {
      const hasUnexpectedRoles = member.roles.cache.some(
        (role) =>
          role.id !== member.guild.roles.everyone.id &&
          role.id !== judgmentRole.id,
      );
      if (hasJudgmentRole && !hasUnexpectedRoles) {
        return { success: false, reason: `${member.user.tag} is already under God's Judgment.` };
      }

      // Preserve the original snapshot while repairing a missing Judgment
      // role or removing roles added after the original punishment.
      logger.warn(
        `GodsJudgment.placeInJudgment: incomplete state detected for ${member.user.tag} ` +
          `(${member.id}) — preserving the original role snapshot and repairing isolation.`
      );
      const operationKey = `${member.guild.id}:${member.id}`;
      if (judgmentsInProgress.has(operationKey)) {
        return {
          success: false,
          reason: "A God's Judgment action is already running for this member.",
        };
      }
      judgmentsInProgress.add(operationKey);
      try {
        return await this.repairHalfJudgedState(member, existingRecord, judgedBy);
      } finally {
        judgmentsInProgress.delete(operationKey);
      }
    }

    if (!existingRecord && hasJudgmentRole) {
      // Orphan role: member has the judgment role but no DB record.
      // Treat as unjudged and proceed with a fresh judgment.
      logger.warn(
        `GodsJudgment.placeInJudgment: ORPHAN ROLE state for ${member.user.tag} ` +
          `(${member.id}) — has judgment role but no record. Treating as unjudged.`
      );
    }

    const capturedPermissions = await this.captureMemberViewPermissions(
      member.guild,
      member.id,
    );
    if ("error" in capturedPermissions) {
      return { success: false, reason: capturedPermissions.error };
    }

    const operationKey = `${member.guild.id}:${member.id}`;
    if (judgmentsInProgress.has(operationKey)) {
      return { success: false, reason: "A God's Judgment action is already running for this member." };
    }
    judgmentsInProgress.add(operationKey);

    // Save each original role exactly once, including any role with
    // Administrator permission, before changing channel or role permissions.
    const savedRoles = [
      ...new Set(
        member.roles.cache
          .filter(
            (role) =>
              role.id !== member.guild.roles.everyone.id &&
              role.id !== judgmentRole.id,
          )
          .map((role) => role.id),
      ),
    ];

    const record: JudgmentRecord = {
      userId: member.id,
      savedRoles,
      savedChannelViewPermissions: capturedPermissions.snapshot,
      judgedAt: new Date().toISOString(),
      reason,
      judgedBy,
    };
    const failures: string[] = [];
    const blockedRoles = member.roles.cache.filter(
      (role) =>
        role.id !== member.guild.roles.everyone.id &&
        role.id !== judgmentRole.id &&
        !role.editable,
    );
    let roleAssigned = false;
    let memberAfterRoleRemoval = member;
    const persistPartialState = async () => {
      record.partial = true;
      record.failureDetails = [...new Set(failures)];
      try {
        await this.persistJudgmentRecord(member.guild.id, record);
      } catch (error) {
        failures.push(
          `Could not persist the isolation failure details: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        record.failureDetails = [...new Set(failures)];
      }
    };

    try {
      // Persist the snapshot before any role or channel permission mutation.
      try {
        await this.persistJudgmentRecord(member.guild.id, record);
      } catch (error) {
        return {
          success: false,
          reason:
            `God's Judgment isolation was not completed because the original role snapshot ` +
            `could not be saved. No roles or channel permissions were changed. ${
              error instanceof Error ? error.message : String(error)
            }`,
        };
      }

      // Add explicit member denies while Administrator is still assigned. They
      // take effect as soon as the bypassing role is removed.
      const channelFailures =
        await this.applyMemberIsolationBeforeRoleRemoval(member);
      if (channelFailures.length > 0) {
        failures.push(...channelFailures);
        await persistPartialState();
        return {
          success: false,
          partial: true,
          roleAssigned: false,
          reason:
            `God's Judgment isolation was not completed because channel access could not be ` +
            `denied safely. The original role snapshot is saved for owner-only release. ` +
            failures.join(" "),
          record,
        };
      }

      const removableRoles = member.roles.cache.filter(
        (role) =>
          role.id !== member.guild.roles.everyone.id &&
          role.id !== judgmentRole.id &&
          role.editable,
      );
      if (removableRoles.size > 0) {
        try {
          await member.roles.remove(
            [...removableRoles.keys()],
            `God's Judgment: ${reason}`,
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failures.push(`Could not remove all manageable roles: ${msg}`);
          logger.warn(`GodsJudgment.placeInJudgment: partial role removal — ${msg}`);
        }
      }

      try {
        memberAfterRoleRemoval = await member.guild.members.fetch(member.id);
      } catch (error) {
        failures.push(
          `Could not verify role removal from Discord: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        await persistPartialState();
        return {
          success: false,
          partial: true,
          roleAssigned: false,
          reason:
            `God's Judgment isolation was not completed because role removal could not be ` +
            `verified. The original role snapshot is saved for owner-only release. ` +
            failures.join(" "),
          record,
        };
      }
      member = memberAfterRoleRemoval;

      const remainingDangerousRoles = memberAfterRoleRemoval.roles.cache.filter(
        (role) =>
          role.id !== member.guild.roles.everyone.id &&
          role.id !== judgmentRole.id &&
          isIsolationDangerousRole(role),
      );
      if (
        memberAfterRoleRemoval.permissions.has(PermissionFlagsBits.Administrator) ||
        remainingDangerousRoles.size > 0
      ) {
        failures.push(
          "A role that can bypass or alter channel isolation remains on the member.",
        );
        await persistPartialState();
        return {
          success: false,
          partial: true,
          roleAssigned: false,
          reason:
            `God's Judgment isolation was not completed because the bot could not remove every ` +
            `dangerous role. The Judgment role was not assigned; the original role snapshot is ` +
            `saved for owner-only release. ${failures.join(" ")}`,
          record,
        };
      }

      if (blockedRoles.size > 0) {
        failures.push(
          `Could not remove ${blockedRoles.size} role(s) above the bot or managed by an integration.`,
        );
      }
      try {
        await memberAfterRoleRemoval.roles.add(
          judgmentRole,
          `God's Judgment: ${reason}`,
        );
        roleAssigned = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`Could not assign the quarantine role: ${msg}`);
        logger.error(`GodsJudgment.placeInJudgment: failed to assign role — ${msg}`);
      }

      record.partial = failures.length > 0;
      if (record.partial) record.failureDetails = failures;
      else delete record.failureDetails;
      await this.persistJudgmentRecord(member.guild.id, record)
        .catch((error: unknown) => {
          failures.push(
            `Could not persist the final judgment state: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          record.partial = true;
          record.failureDetails = failures;
        });
    } finally {
      judgmentsInProgress.delete(operationKey);
    }

    if (!roleAssigned) {
      return {
        success: false,
        partial: true,
        roleAssigned: false,
        reason:
          `God's Judgment isolation was not completed because the quarantine role could not be ` +
          `assigned. The original role snapshot is saved for owner-only release. ${failures.join(" ")}`,
        record,
      };
    }

    // 4. Ensure all channel overwrites are present (full validation + repair)
    if (cfg.judgmentChannelId) {
      logger.info("GodsJudgment.placeInJudgment: verifying channel overwrites...");
      const stats = await this.validateAndRepair(member.guild).catch((error: unknown) => {
        failures.push(
          `Could not verify quarantine channel overwrites: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      });
      if (!stats || stats.errors > 0) {
        if (stats?.errors && failures.length === 0) {
          failures.push("Some quarantine channel overwrites could not be verified.");
        }
        record.partial = true;
        record.failureDetails = failures.length
          ? failures
          : ["Some quarantine channel overwrites could not be verified."];
        await this.manager
          .updateModuleConfig(member.guild.id, "godsJudgment", {
            activeJudgments: {
              ...this.manager.getConfig(member.guild.id).godsJudgment.activeJudgments,
              [member.id]: record,
            },
          })
          .catch((error: unknown) => {
            failures.push(
              `Could not persist the final judgment state: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
            record.partial = true;
            record.failureDetails = failures;
          });
      }
      if (stats && stats.repaired > 0) {
        logger.warn(
          `GodsJudgment.placeInJudgment: repaired ${stats.repaired} channel overwrite(s) before judgment`
        );
      } else if (stats) {
        logger.info(
          `GodsJudgment.placeInJudgment: all ${stats.checked} channel overwrites verified ✓`
        );
      }
    }

    // 5. DM the user
    if (cfg.dmOnAction) {
      await member
        .send(
          record.partial
            ? `⚖️ God's Judgment role assigned in **${member.guild.name}**, but some protection steps were incomplete.\n> **Review:** ${failures.join(" ").slice(0, 500)}\n> **Reason:** ${reason}`
            : `⚖️ You have been placed under **God's Judgment** in **${member.guild.name}**.\n> **Reason:** ${reason}`
        )
        .catch(() => logger.warn(`GodsJudgment: could not DM ${member.id}`));
    }

    // 6. Log + announce
    await loggingService.logJudgment({
      guildId: member.guild.id,
      target: member,
      moderatorId: judgedBy,
      reason: record.partial
        ? `${reason} (partial: ${failures.join(" ")})`
        : reason,
      savedRoles,
    });

    if (cfg.judgmentChannelId) {
      const ch = member.guild.channels.cache.get(cfg.judgmentChannelId) as TextChannel | undefined;
      if (ch) {
        await ch
          .send(
            record.partial
              ? `⚠️ God's Judgment was partially applied to <@${member.id}>. Staff review is required.\n> **Details:** ${failures.join(" ").slice(0, 500)}\n> **Reason:** ${reason}`
              : `⚖️ <@${member.id}>, you have been placed under **God's Judgment**.\n> **Reason:** ${reason}`,
          )
          .catch(() => null);
      }
    }

    logger.info(
      `GodsJudgment.placeInJudgment: ${record.partial ? "PARTIAL" : "complete"} for ${member.user.tag}`,
    );
    return {
      success: true,
      partial: record.partial,
      roleAssigned: true,
      reason: record.partial
        ? `Quarantine role assigned, but some roles could not be removed: ${failures.join(" ")}`
        : "User placed under God's Judgment.",
      record,
    };
  }

  /**
   * Self-heals a half-judged state: the DB record exists but the judgment role
   * was removed externally (e.g. an admin stripped it manually).
   *
   * Behaviour:
   * - Re-applies the judgment role (stripping any roles the member gained since)
   * - Keeps the ORIGINAL savedRoles from the record so release restores correctly
   * - Re-validates all channel overwrites so the member is fully locked down
   * - DMs the member to let them know their judgment was restored
   */
  private async repairHalfJudgedState(
    member: GuildMember,
    existingRecord: JudgmentRecord,
    repairedBy: string
  ): Promise<JudgmentResult> {
    if (member.id === member.guild.ownerId) {
      return {
        success: false,
        reason: "The server owner's roles and permissions cannot be changed by God's Judgment.",
      };
    }

    const cfg = this.manager.getConfig(member.guild.id).godsJudgment;

    const judgmentRole = member.guild.roles.cache.get(cfg.judgmentRoleId!);
    if (!judgmentRole) {
      return {
        success: false,
        reason: "Judgment role not found. Run `/judgment setup` to recreate it.",
      };
    }
    const roleSafetyError = await this.ensureJudgmentRoleHasNoPermissions(judgmentRole);
    if (roleSafetyError) return { success: false, reason: roleSafetyError };

    const botMember = member.guild.members.me;
    if (
      !botMember?.permissions.has(PermissionFlagsBits.ManageRoles) ||
      !botMember.permissions.has(PermissionFlagsBits.ManageChannels) ||
      !judgmentRole.editable
    ) {
      return {
        success: false,
        reason:
          "God's Judgment isolation was not completed. The bot needs Manage Roles and Manage Channels, with its highest role above the configured Judgment role.",
      };
    }

    const dangerousRoleError = dangerousRoleManagementFailure(
      member,
      botMember,
      judgmentRole.id,
    );
    if (dangerousRoleError) {
      existingRecord.partial = true;
      existingRecord.failureDetails = [
        `God's Judgment isolation was not completed. ${dangerousRoleError}`,
      ];
      await this.persistJudgmentRecord(member.guild.id, existingRecord).catch(
        (error: unknown) => {
          logger.error(
            `GodsJudgment.repairHalfJudgedState: could not persist role hierarchy limitation ` +
              `for member=${member.id} — ${
                error instanceof Error ? error.message : String(error)
              }`,
          );
        },
      );
      return {
        success: false,
        partial: true,
        roleAssigned: member.roles.cache.has(judgmentRole.id),
        reason: existingRecord.failureDetails[0],
        record: existingRecord,
      };
    }

    const capturedPermissions = await this.captureMemberViewPermissions(
      member.guild,
      member.id,
    );
    if ("error" in capturedPermissions) {
      return { success: false, reason: capturedPermissions.error };
    }
    existingRecord.savedChannelViewPermissions = {
      ...capturedPermissions.snapshot,
      ...existingRecord.savedChannelViewPermissions,
    };
    try {
      await this.manager.updateModuleConfig(member.guild.id, "godsJudgment", {
        activeJudgments: {
          ...this.manager.getConfig(member.guild.id).godsJudgment.activeJudgments,
          [member.id]: existingRecord,
        },
      });
    } catch (error) {
      return {
        success: false,
        reason:
          `Could not save the member's original channel permissions: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const failures: string[] = [];
    const blockedRoles = member.roles.cache.filter(
      (role) =>
        role.id !== member.guild.roles.everyone.id &&
        role.id !== judgmentRole.id &&
        !role.editable,
    );
    let memberAfterRoleRemoval = member;
    const persistRecoveryFailure = async () => {
      existingRecord.partial = true;
      existingRecord.failureDetails = [...new Set(failures)];
      await this.persistJudgmentRecord(member.guild.id, existingRecord).catch(
        (error: unknown) => {
          failures.push(
            `Could not persist the recovery limitation: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          existingRecord.failureDetails = [...new Set(failures)];
        },
      );
    };

    const channelFailures =
      await this.applyMemberIsolationBeforeRoleRemoval(member);
    if (channelFailures.length > 0) {
      failures.push(...channelFailures);
      await persistRecoveryFailure();
      return {
        success: false,
        partial: true,
        roleAssigned: member.roles.cache.has(judgmentRole.id),
        reason:
          `God's Judgment isolation was not completed because channel access could not be ` +
          `denied safely. ${failures.join(" ")}`,
        record: existingRecord,
      };
    }

    const removableRoles = member.roles.cache.filter(
      (role) =>
        role.id !== member.guild.roles.everyone.id &&
        role.id !== judgmentRole.id &&
        role.editable,
    );
    if (removableRoles.size > 0) {
      try {
        await member.roles.remove(
          [...removableRoles.keys()],
          `God's Judgment self-heal by ${repairedBy}`,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`Could not remove all manageable roles: ${msg}`);
      }
    }
    if (blockedRoles.size > 0) {
      failures.push(
        `Could not remove ${blockedRoles.size} role(s) above the bot or managed by an integration.`,
      );
    }

    try {
      memberAfterRoleRemoval = await member.guild.members.fetch(member.id);
    } catch (error) {
      failures.push(
        `Could not verify role removal from Discord: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await persistRecoveryFailure();
      return {
        success: false,
        partial: true,
        roleAssigned: member.roles.cache.has(judgmentRole.id),
        reason:
          `God's Judgment isolation was not completed because role removal could not be ` +
          `verified. ${failures.join(" ")}`,
        record: existingRecord,
      };
    }
    member = memberAfterRoleRemoval;

    const remainingDangerousRoles = member.roles.cache.filter(
      (role) =>
        role.id !== member.guild.roles.everyone.id &&
        role.id !== judgmentRole.id &&
        isIsolationDangerousRole(role),
    );
    if (
      member.permissions.has(PermissionFlagsBits.Administrator) ||
      remainingDangerousRoles.size > 0
    ) {
      failures.push(
        "A role that can bypass or alter channel isolation remains on the member.",
      );
      await persistRecoveryFailure();
      return {
        success: false,
        partial: true,
        roleAssigned: member.roles.cache.has(judgmentRole.id),
        reason:
          `God's Judgment isolation was not completed because the bot could not remove every ` +
          `dangerous role. ${failures.join(" ")}`,
        record: existingRecord,
      };
    }

    let roleAssigned = member.roles.cache.has(judgmentRole.id);
    if (!roleAssigned) {
      try {
        await member.roles.add(
          judgmentRole,
          `God's Judgment self-heal (triggered by <@${repairedBy}>): original reason — ${existingRecord.reason}`,
        );
        roleAssigned = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        failures.push(`Could not assign the quarantine role: ${msg}`);
        logger.error(`GodsJudgment.repairHalfJudgedState: failed to re-apply role — ${msg}`);
      }
    }

    existingRecord.partial = failures.length > 0;
    if (existingRecord.partial) existingRecord.failureDetails = failures;
    else delete existingRecord.failureDetails;
    await this.persistJudgmentRecord(member.guild.id, existingRecord).catch(
      (error: unknown) => {
        failures.push(
          `Could not persist the recovery result: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        existingRecord.partial = true;
        existingRecord.failureDetails = failures;
      },
    );
    if (!roleAssigned) {
      return {
        success: false,
        partial: true,
        roleAssigned: false,
        reason:
          `God's Judgment isolation was not completed because the quarantine role could not be ` +
          `assigned. The original role snapshot remains saved for owner-only release. ` +
          failures.join(" "),
        record: existingRecord,
      };
    }

    // Re-validate all channel overwrites so the lockdown is complete
    if (cfg.judgmentChannelId) {
      const stats = await this.validateAndRepair(member.guild).catch((error: unknown) => {
        failures.push(
          `Could not verify all quarantine channel overwrites: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return null;
      });
      if (!stats || stats.errors > 0) {
        if (stats?.errors && failures.length === 0) {
          failures.push("Some quarantine channel overwrites could not be verified.");
        }
        existingRecord.partial = true;
        existingRecord.failureDetails = failures.length
          ? failures
          : ["Some quarantine channel overwrites could not be verified."];
        await this.manager.updateModuleConfig(member.guild.id, "godsJudgment", {
          activeJudgments: {
            ...this.manager.getConfig(member.guild.id).godsJudgment.activeJudgments,
            [member.id]: existingRecord,
          },
        });
      }
      if (stats && stats.repaired > 0) {
        logger.warn(
          `GodsJudgment.repairHalfJudgedState: repaired ${stats.repaired} channel overwrite(s) during self-heal`
        );
      } else if (stats) {
        logger.info(
          `GodsJudgment.repairHalfJudgedState: all ${stats.checked} channel overwrites verified ✓`
        );
      }
    }

    // DM the member
    if (cfg.dmOnAction) {
      await member
        .send(
          `⚠️ God's Judgment recovery was attempted in **${member.guild.name}**.\n` +
            `> The quarantine role ${roleAssigned ? "was re-applied" : "could not be re-applied"}.\n` +
            (failures.length ? `> **Partial failures:** ${failures.join(" ").slice(0, 500)}\n` : "") +
            `> **Original Reason:** ${existingRecord.reason}`
        )
        .catch(() => null);
    }

    logger.info(
      `GodsJudgment.repairHalfJudgedState: ${existingRecord.partial ? "PARTIAL" : "complete"} for ${member.user.tag} (${member.id})`
    );

    return {
      success: roleAssigned,
      partial: existingRecord.partial,
      roleAssigned,
      wasRepaired: true,
      reason: existingRecord.partial
        ? `Quarantine role ${roleAssigned ? "re-applied" : "not assigned"} with partial failures: ${failures.join(" ")}`
        : `Self-healed: ${member.user.tag}'s judgment role was re-applied after being manually removed. Original reason: ${existingRecord.reason}`,
      record: existingRecord,
    };
  }

  async release(
    member: GuildMember,
    reason: string,
    releasedBy: string
  ): Promise<JudgmentResult> {
    if (releasedBy !== member.guild.ownerId) {
      logger.warn(
        `GodsJudgment.release: rejected non-owner release guild=${member.guild.id} ` +
          `actor=${releasedBy} target=${member.id}`,
      );
      return {
        success: false,
        reason: "Only this server's actual owner can release a member from God's Judgment.",
      };
    }
    if (member.id === member.guild.ownerId) {
      return {
        success: false,
        reason: "The server owner's roles and permissions cannot be changed by God's Judgment.",
      };
    }

    logger.info(
      `GodsJudgment.release: user=${member.user.tag} (${member.id}) guild=${member.guild.id}`
    );

    const operationKey = `${member.guild.id}:${member.id}`;
    if (judgmentsInProgress.has(operationKey)) {
      return {
        success: false,
        reason: "A God's Judgment action is already running for this member.",
      };
    }
    judgmentsInProgress.add(operationKey);

    try {
      let cfg = this.manager.getConfig(member.guild.id).godsJudgment;
      let record = cfg.activeJudgments[member.id];
      if (!record) {
        return {
          success: false,
          reason: `${member.user.tag} is not currently under God's Judgment.`,
        };
      }
      if (
        record.userId !== member.id ||
        !Array.isArray(record.savedRoles) ||
        record.savedRoles.some((id) => typeof id !== "string")
      ) {
        return {
          success: false,
          reason:
            "The saved role snapshot is invalid for this member. No roles were changed; review the stored Judgment record before retrying.",
        };
      }

      const hasJudgmentRole =
        !!cfg.judgmentRoleId && member.roles.cache.has(cfg.judgmentRoleId);
      if (hasJudgmentRole) {
        const hasDangerousRoles =
          member.permissions.has(PermissionFlagsBits.Administrator) ||
          member.roles.cache.some(
            (role) =>
              role.id !== member.guild.roles.everyone.id &&
              role.id !== cfg.judgmentRoleId &&
              isIsolationDangerousRole(role),
          );
        if (hasDangerousRoles) {
          const isolationFailures =
            await this.applyMemberIsolationBeforeRoleRemoval(member);
          if (isolationFailures.length > 0) {
            return {
              success: false,
              partial: true,
              reason:
                `Release stopped because channel isolation could not be re-applied before ` +
                `restoring the saved roles. ${isolationFailures.join(" ")}`,
              record,
            };
          }
          logger.warn(
            `GodsJudgment.release: dangerous role detected for ${member.id}; ` +
              `owner-authorized snapshot restore will remove roles not in the original snapshot.`,
          );
        } else {
          const stats = await this.validateAndRepair(member.guild);
          if (stats.errors > 0) {
            const latestRecord =
              this.manager.getConfig(member.guild.id).godsJudgment.activeJudgments[
                member.id
              ] ?? record;
            const limitations = latestRecord.failureDetails?.join(" ") ?? "";
            return {
              success: false,
              partial: true,
              reason:
                `Release stopped because isolation could not be verified ` +
                `(${stats.errors} issue(s)). Fix the reported permission or role limitation and retry; ` +
                `the member remains under God's Judgment. ${limitations}`,
              record: latestRecord,
            };
          }
          cfg = this.manager.getConfig(member.guild.id).godsJudgment;
          record = cfg.activeJudgments[member.id] ?? record;
        }
      } else {
        // A snapshot can remain after a safe application failure or manual
        // removal of the Judgment role. Owner release in this state restores
        // that saved snapshot instead of refusing cleanup for missing isolation.
        logger.warn(
          `GodsJudgment.release: restoring saved snapshot for member=${member.id} ` +
            `without a Judgment role; actor is the server owner.`,
        );
      }

      // Restore saved roles while member-specific channel denies are still in
      // force. This prevents role allows from opening channels mid-release.
      const uniqueSavedRoles = [...new Set(record.savedRoles)].filter(
        (id) =>
          id !== member.guild.roles.everyone.id &&
          id !== cfg.judgmentRoleId,
      );
      const rolesToRestore = uniqueSavedRoles.filter((id) =>
        member.guild.roles.cache.has(id),
      );
      const skippedRoles = uniqueSavedRoles.length - rolesToRestore.length;
      const currentRoleIds = [
        ...new Set(
          member.roles.cache
            .filter(
              (role) =>
                role.id !== member.guild.roles.everyone.id &&
                role.id !== cfg.judgmentRoleId,
            )
            .map((role) => role.id),
        ),
      ];
      const rolesAlreadyMatchSnapshot =
        currentRoleIds.length === rolesToRestore.length &&
        currentRoleIds.every((id) => rolesToRestore.includes(id));
      if (!rolesAlreadyMatchSnapshot) {
        try {
          await member.roles.set(
            rolesToRestore,
            `Released from God's Judgment: ${reason}`,
          );
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`GodsJudgment.release: failed to restore roles — ${message}`);
          return { success: false, reason: `Failed to restore roles: ${message}` };
        }
      }

      const restoreErrors: string[] = [];
      try {
        await member.guild.channels.fetch();
      } catch (error) {
        restoreErrors.push(
          `Could not fetch channels to restore original visibility: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (restoreErrors.length === 0) {
        for (const [channelId, state] of Object.entries(
          record.savedChannelViewPermissions ?? {},
        )) {
          const channel = member.guild.channels.cache.get(channelId);
          if (!channel || channel.isThread()) continue;
          if (!("permissionOverwrites" in channel)) {
            restoreErrors.push(
              `Channel ${channelId} no longer supports permission overwrites.`,
            );
            continue;
          }
          const currentState = viewOverwriteState(
            channel as NonThreadGuildBasedChannel,
            member.id,
          );
          if (currentState === state) continue;
          try {
            await channel.permissionOverwrites.edit(
              member,
              {
                ViewChannel:
                  state === "allow" ? true : state === "deny" ? false : null,
              },
              { reason: "God's Judgment release: restore original channel access" },
            );
          } catch (error) {
            restoreErrors.push(
              `Could not restore access to #${channel.name ?? channel.id}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }

      if (restoreErrors.length > 0) {
        const rollbackResult = await this.repairHalfJudgedState(
          member,
          record,
          releasedBy,
        ).catch((error: unknown) => ({
          success: false,
          reason: error instanceof Error ? error.message : String(error),
        }));
        const failureDetails = [
          ...restoreErrors,
          ...(rollbackResult.success
            ? []
            : [`Could not fully reapply Judgment isolation: ${rollbackResult.reason}`]),
        ];
        record.partial = true;
        record.failureDetails = failureDetails;
        await this.manager.updateModuleConfig(member.guild.id, "godsJudgment", {
          activeJudgments: {
            ...this.manager.getConfig(member.guild.id).godsJudgment.activeJudgments,
            [member.id]: record,
          },
        }).catch((error: unknown) => {
          failureDetails.push(
            `Could not save the failed release state: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
        return {
          success: false,
          partial: true,
          reason:
            `Release did not complete. The bot attempted to restore the Judgment role and ` +
            `channel isolation. ${failureDetails.join(" ")}`,
          record,
        };
      }

      const updatedJudgments = { ...cfg.activeJudgments };
      delete updatedJudgments[member.id];
      try {
        await this.manager.updateModuleConfig(member.guild.id, "godsJudgment", {
          activeJudgments: updatedJudgments,
        });
      } catch (error) {
        const rollbackResult = await this.repairHalfJudgedState(
          member,
          record,
          releasedBy,
        ).catch((rollbackError: unknown) => ({
          success: false,
          reason: rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError),
        }));
        return {
          success: false,
          partial: true,
          reason:
            `Roles and channel access were restored, but the release record could not be cleared: ` +
            `${error instanceof Error ? error.message : String(error)}. ` +
            `Judgment isolation rollback ${rollbackResult.success ? "completed" : "was incomplete"}: ` +
            rollbackResult.reason,
          record,
        };
      }

      if (cfg.dmOnAction) {
        await member
          .send(
            `✅ You have been **released** from God's Judgment in **${member.guild.name}**.\n` +
              `> **Reason:** ${reason}\n> Your original roles and channel access have been restored.`,
          )
          .catch(() => logger.warn(`GodsJudgment: could not DM ${member.id}`));
      }

      await loggingService.logRelease({
        guildId: member.guild.id,
        target: member,
        moderatorId: releasedBy,
        reason,
        restoredRoles: rolesToRestore,
        skippedRoles,
      });

      logger.info(`GodsJudgment.release: ✓ complete for ${member.user.tag}`);
      return { success: true, reason: "User released from God's Judgment.", record };
    } finally {
      judgmentsInProgress.delete(operationKey);
    }
  }

  // ─── Query helpers ────────────────────────────────────────────────────────

  getActiveJudgments(guildId: string): JudgmentRecord[] {
    return Object.values(this.manager.getConfig(guildId).godsJudgment.activeJudgments);
  }

  isUnderJudgment(guildId: string, userId: string): boolean {
    return !!this.manager.getConfig(guildId).godsJudgment.activeJudgments[userId];
  }

  buildStatusEmbed(guildId: string, guildName: string): EmbedBuilder {
    const gjConfig = this.manager.getConfig(guildId).godsJudgment;
    const active = Object.values(gjConfig.activeJudgments);

    return new EmbedBuilder()
      .setTitle("⚖️ God's Judgment — Status")
      .setColor(0xfee75c)
      .addFields(
        {
          name: "Status",
          value: gjConfig.enabled ? "🟢 Enabled" : "🔴 Disabled",
          inline: true,
        },
        {
          name: "Judgment Role",
          value: gjConfig.judgmentRoleId
            ? `<@&${gjConfig.judgmentRoleId}>`
            : "Not set — run `/judgment setup`",
          inline: true,
        },
        {
          name: "Judgment Channel",
          value: gjConfig.judgmentChannelId
            ? `<#${gjConfig.judgmentChannelId}>`
            : "Not set — run `/judgment setup`",
          inline: true,
        },
        { name: "DM on Action", value: gjConfig.dmOnAction ? "Yes" : "No", inline: true },
        {
          name: `Currently Under Judgment (${active.length})`,
          value:
            active.length > 0
              ? active
                  .map(
                    (r) =>
                      `• <@${r.userId}> — ${r.reason} *(by <@${r.judgedBy}>, ` +
                      `<t:${Math.floor(new Date(r.judgedAt).getTime() / 1_000)}:R>)*`
                  )
                  .join("\n")
              : "No users currently under judgment.",
          inline: false,
        }
      )
      .setFooter({ text: guildName })
      .setTimestamp();
  }
}

function fail(reason: string): SetupResult {
  logger.error(`GodsJudgment.setup: ${reason}`);
  return { success: false, reason, roleCreated: false, channelCreated: false };
}
