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
  TextChannel,
} from "discord.js";
import { BaseSecurityModule } from "../BaseSecurityModule.js";
import type { SecurityManager } from "../SecurityManager.js";
import type { JudgmentRecord, JudgmentResult } from "../types.js";
import { loggingService } from "../../lib/registry.js";
import { logger } from "../../lib/logger.js";

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

function channelKind(
  channel: NonThreadGuildBasedChannel,
  judgmentChannelId: string
): "judgment" | "voice" | "text" | "skip" {
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
  return "skip";
}

export class GodsJudgment extends BaseSecurityModule {
  constructor(manager: SecurityManager) {
    super("godsJudgment", manager);
  }

  get name() {
    return "God's Judgment";
  }

  get description() {
    return "Strips all roles from a user and confines them to a judgment channel.";
  }

  // ─── Channel-level overwrite helpers ─────────────────────────────────────

  /**
   * Apply the correct judgment-role permission overwrite to a single channel.
   *
   * Judgment channel  → ALLOW ViewChannel, ReadMessageHistory, SendMessages
   *                      DENY  AddReactions, threads
   * Voice channel      → DENY  ViewChannel, Connect, Speak
   * Text/category/etc. → DENY  ViewChannel, SendMessages, AddReactions, threads
   * Thread / unknown   → skipped (inherits from parent / not manageable)
   */
  private async applyOverwritesToChannel(
    channel: NonThreadGuildBasedChannel,
    judgmentRoleId: string,
    judgmentChannelId: string
  ): Promise<OverwriteOutcome> {
    const kind = channelKind(channel, judgmentChannelId);
    if (kind === "skip") return "skipped";

    try {
      if (kind === "judgment") {
        await channel.permissionOverwrites.edit(
          judgmentRoleId,
          {
            ViewChannel: true,
            ReadMessageHistory: true,
            SendMessages: true,
            AddReactions: false,
            CreatePublicThreads: false,
            CreatePrivateThreads: false,
            SendMessagesInThreads: false,
          },
          { reason: "God's Judgment: confined channel access" }
        );
        return "applied";
      }

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

    if (channel.id === judgmentChannelId) {
      // Must explicitly ALLOW SendMessages
      return ow?.allow.has(PermissionFlagsBits.SendMessages) === true;
    }

    if (!ow) return false;

    const kind = channelKind(channel, judgmentChannelId);

    if (kind === "voice") {
      return ow.deny.has(PermissionFlagsBits.Connect);
    }

    // text / category: ViewChannel or SendMessages must be denied
    return (
      ow.deny.has(PermissionFlagsBits.ViewChannel) ||
      ow.deny.has(PermissionFlagsBits.SendMessages)
    );
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
    await guild.channels.fetch().catch(() => null);

    let applied = 0;
    let skipped = 0;
    let errors = 0;

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
      if (result === "applied") applied++;
      else if (result === "skipped") skipped++;
      else errors++;
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

    if (!cfg.enabled || !cfg.judgmentRoleId || !cfg.judgmentChannelId) {
      logger.info(
        `GodsJudgment.validateAndRepair: guild "${guild.name}" — ` +
          `not fully configured (enabled=${cfg.enabled} role=${cfg.judgmentRoleId ?? "null"} ` +
          `channel=${cfg.judgmentChannelId ?? "null"}), skipping.`
      );
      return { checked: 0, repaired: 0, skipped: 0, errors: 0 };
    }

    const { judgmentRoleId, judgmentChannelId } = cfg;

    await guild.channels.fetch().catch(() => null);

    let checked = 0;
    let repaired = 0;
    let skipped = 0;
    let errors = 0;

    for (const [, ch] of guild.channels.cache) {
      if (ch.isThread()) {
        skipped++;
        continue;
      }
      if (!("permissionOverwrites" in ch)) {
        skipped++;
        continue;
      }

      checked++;
      const channel = ch as NonThreadGuildBasedChannel;

      if (!this.isOverwriteCorrect(channel, judgmentRoleId, judgmentChannelId)) {
        logger.info(
          `GodsJudgment.validateAndRepair: repairing #${channel.name ?? channel.id} ` +
            `(${ChannelType[channel.type] ?? channel.type})`
        );
        const result = await this.applyOverwritesToChannel(
          channel,
          judgmentRoleId,
          judgmentChannelId
        );
        if (result === "applied") repaired++;
        else errors++;
      }
    }

    logger.info(
      `GodsJudgment.validateAndRepair [${guild.name}]: ` +
        `checked=${checked} repaired=${repaired} skipped=${skipped} errors=${errors}`
    );

    if (repaired > 0) {
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

  // ─── Runtime event registration ──────────────────────────────────────────

  /**
   * Registers two event handlers:
   *
   * 1. channelCreate — auto-applies judgment overwrites to every new channel
   *    so it is locked down immediately.
   *
   * 2. messageCreate — real-time leak detection. If a judged member manages to
   *    send a message anywhere outside the judgment channel (e.g. because an
   *    overwrite was manually removed), the message is deleted and the entire
   *    guild's overwrites are repaired immediately.
   */
  register(client: Client): void {
    // ── Auto-patch new channels ─────────────────────────────────────────────
    client.on(Events.ChannelCreate, async (channel: GuildBasedChannel) => {
      if (!("guildId" in channel) || !channel.guildId) return;
      if (channel.isThread()) return;
      if (!("permissionOverwrites" in channel)) return;

      const cfg = this.manager.getConfig(channel.guildId).godsJudgment;
      if (!cfg.enabled || !cfg.judgmentRoleId || !cfg.judgmentChannelId) return;

      logger.info(
        `GodsJudgment: new channel #${channel.name ?? channel.id} ` +
          `created in ${channel.guildId} — applying judgment overwrites automatically`
      );

      const result = await this.applyOverwritesToChannel(
        channel as NonThreadGuildBasedChannel,
        cfg.judgmentRoleId,
        cfg.judgmentChannelId
      );

      logger.info(
        `GodsJudgment: channelCreate overwrite result for #${channel.name ?? channel.id}: ${result}`
      );
    });

    // ── Real-time leak repair ───────────────────────────────────────────────
    client.on(Events.MessageCreate, async (message) => {
      if (!message.inGuild() || message.author.bot) return;

      const cfg = this.manager.getConfig(message.guildId).godsJudgment;
      if (!cfg.enabled || !cfg.judgmentRoleId) return;

      const record = cfg.activeJudgments[message.author.id];
      if (!record) return;

      // Judged user is sending a message — if it's in the judgment channel, that's fine
      if (message.channelId === cfg.judgmentChannelId) return;

      // !! LEAK — a judged member got through somewhere they shouldn't be !!
      logger.error(
        `GodsJudgment: ‼ PERMISSION LEAK — ${message.author.tag} (${message.author.id}) ` +
          `sent a message in channel ${message.channelId} ` +
          `which is NOT the judgment channel. Deleting + repairing now.`
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
          cfg.judgmentChannelId
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
      "GodsJudgment: registered channelCreate (auto-lockdown) and messageCreate (leak repair) handlers"
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
      // Re-apply the correct allow overwrite in case it was changed
      await judgmentChannel.permissionOverwrites.edit(
        judgmentRole.id,
        {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: true,
          AddReactions: false,
          CreatePublicThreads: false,
          CreatePrivateThreads: false,
          SendMessagesInThreads: false,
        },
        { reason: "God's Judgment setup — ensuring correct overwrites" }
      ).catch((e) => logger.warn(`GodsJudgment.setup: could not update judgment channel overwrite — ${e instanceof Error ? e.message : String(e)}`));
    } else {
      logger.info("GodsJudgment.setup: creating judgment channel...");
      try {
        judgmentChannel = (await guild.channels.create({
          name: "gods-judgment",
          type: ChannelType.GuildText,
          topic: "Users placed under God's Judgment are confined here.",
          permissionOverwrites: [
            // @everyone cannot see the channel at all
            {
              id: guild.roles.everyone.id,
              type: OverwriteType.Role,
              deny: [PermissionFlagsBits.ViewChannel],
            },
            // Judged users can view and SEND messages here only
            {
              id: judgmentRole.id,
              type: OverwriteType.Role,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
                PermissionFlagsBits.SendMessages,
              ],
              deny: [
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

    // ── Self-healing state detection ───────────────────────────────────────
    const existingRecord = cfg.activeJudgments[member.id];
    const hasJudgmentRole = member.roles.cache.has(cfg.judgmentRoleId);

    if (existingRecord && hasJudgmentRole) {
      // Fully judged: DB record present AND role is assigned — nothing to do
      return { success: false, reason: `${member.user.tag} is already under God's Judgment.` };
    }

    if (existingRecord && !hasJudgmentRole) {
      // Half-judged: DB record exists but the judgment role was manually removed.
      // Self-heal by re-applying the role and re-validating channels.
      logger.warn(
        `GodsJudgment.placeInJudgment: HALF-JUDGED state detected for ${member.user.tag} ` +
          `(${member.id}) — record present but role is missing. Self-healing now...`
      );
      return await this.repairHalfJudgedState(member, existingRecord, judgedBy);
    }

    if (!existingRecord && hasJudgmentRole) {
      // Orphan role: member has the judgment role but no DB record.
      // Treat as unjudged and proceed with a fresh judgment.
      logger.warn(
        `GodsJudgment.placeInJudgment: ORPHAN ROLE state for ${member.user.tag} ` +
          `(${member.id}) — has judgment role but no record. Treating as unjudged.`
      );
    }

    // 1. Save the member's current roles (exclude @everyone and the judgment role itself)
    const savedRoles = member.roles.cache
      .filter((r) => r.id !== member.guild.roles.everyone.id && r.id !== judgmentRole.id)
      .map((r) => r.id);

    // 2. Strip all roles, assign judgment role
    try {
      await member.roles.set([judgmentRole], `God's Judgment: ${reason}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`GodsJudgment.placeInJudgment: failed to set roles — ${msg}`);
      return { success: false, reason: `Failed to modify roles: ${msg}` };
    }

    // 3. Persist judgment record
    const record: JudgmentRecord = {
      userId: member.id,
      savedRoles,
      judgedAt: new Date().toISOString(),
      reason,
      judgedBy,
    };
    await this.manager.updateModuleConfig(member.guild.id, "godsJudgment", {
      activeJudgments: { ...cfg.activeJudgments, [member.id]: record },
    });

    // 4. Ensure all channel overwrites are present (full validation + repair)
    if (cfg.judgmentChannelId) {
      logger.info("GodsJudgment.placeInJudgment: verifying channel overwrites...");
      const stats = await this.validateAndRepair(member.guild);
      if (stats.repaired > 0) {
        logger.warn(
          `GodsJudgment.placeInJudgment: repaired ${stats.repaired} channel overwrite(s) before judgment`
        );
      } else {
        logger.info(
          `GodsJudgment.placeInJudgment: all ${stats.checked} channel overwrites verified ✓`
        );
      }
    }

    // 5. DM the user
    if (cfg.dmOnAction) {
      await member
        .send(
          `⚖️ You have been placed under **God's Judgment** in **${member.guild.name}**.\n> **Reason:** ${reason}`
        )
        .catch(() => logger.warn(`GodsJudgment: could not DM ${member.id}`));
    }

    // 6. Log + announce
    await loggingService.logJudgment({
      guildId: member.guild.id,
      target: member,
      moderatorId: judgedBy,
      reason,
      savedRoles,
    });

    if (cfg.judgmentChannelId) {
      const ch = member.guild.channels.cache.get(cfg.judgmentChannelId) as TextChannel | undefined;
      if (ch) {
        await ch
          .send(`⚖️ <@${member.id}>, you have been placed under **God's Judgment**.\n> **Reason:** ${reason}`)
          .catch(() => null);
      }
    }

    logger.info(`GodsJudgment.placeInJudgment: ✓ complete for ${member.user.tag}`);
    return { success: true, reason: "User placed under God's Judgment.", record };
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
    const cfg = this.manager.getConfig(member.guild.id).godsJudgment;

    const judgmentRole = member.guild.roles.cache.get(cfg.judgmentRoleId!);
    if (!judgmentRole) {
      return {
        success: false,
        reason: "Judgment role not found. Run `/judgment setup` to recreate it.",
      };
    }

    // Re-apply the judgment role, stripping any roles the member may have
    // acquired since the judgment was first placed
    try {
      await member.roles.set(
        [judgmentRole],
        `God's Judgment self-heal (triggered by <@${repairedBy}>): original reason — ${existingRecord.reason}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`GodsJudgment.repairHalfJudgedState: failed to re-apply role — ${msg}`);
      return { success: false, reason: `Failed to re-apply judgment role: ${msg}` };
    }

    // Keep the original record intact — savedRoles must reflect what the member
    // had BEFORE the first judgment, not the roles they accumulated since
    await this.manager.updateModuleConfig(member.guild.id, "godsJudgment", {
      activeJudgments: { ...cfg.activeJudgments, [member.id]: existingRecord },
    });

    // Re-validate all channel overwrites so the lockdown is complete
    if (cfg.judgmentChannelId) {
      const stats = await this.validateAndRepair(member.guild);
      if (stats.repaired > 0) {
        logger.warn(
          `GodsJudgment.repairHalfJudgedState: repaired ${stats.repaired} channel overwrite(s) during self-heal`
        );
      } else {
        logger.info(
          `GodsJudgment.repairHalfJudgedState: all ${stats.checked} channel overwrites verified ✓`
        );
      }
    }

    // DM the member
    if (cfg.dmOnAction) {
      await member
        .send(
          `⚠️ Your **God's Judgment** in **${member.guild.name}** was detected as incomplete and has been automatically restored.\n` +
            `> The judgment role was found missing and has been re-applied.\n` +
            `> **Original Reason:** ${existingRecord.reason}`
        )
        .catch(() => null);
    }

    logger.info(
      `GodsJudgment.repairHalfJudgedState: ✓ self-heal complete for ${member.user.tag} (${member.id})`
    );

    return {
      success: true,
      wasRepaired: true,
      reason:
        `Self-healed: ${member.user.tag}'s judgment role was re-applied after being ` +
        `manually removed. Original reason: ${existingRecord.reason}`,
      record: existingRecord,
    };
  }

  async release(
    member: GuildMember,
    reason: string,
    releasedBy: string
  ): Promise<JudgmentResult> {
    logger.info(
      `GodsJudgment.release: user=${member.user.tag} (${member.id}) guild=${member.guild.id}`
    );

    const cfg = this.manager.getConfig(member.guild.id).godsJudgment;
    const record = cfg.activeJudgments[member.id];

    if (!record) {
      return { success: false, reason: `${member.user.tag} is not currently under God's Judgment.` };
    }

    // Restore saved roles, skipping any that were deleted since judgment
    const rolesToRestore = record.savedRoles.filter((id) => member.guild.roles.cache.has(id));
    const skippedRoles = record.savedRoles.length - rolesToRestore.length;

    try {
      await member.roles.set(rolesToRestore, `Released from God's Judgment: ${reason}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`GodsJudgment.release: failed to restore roles — ${msg}`);
      return { success: false, reason: `Failed to restore roles: ${msg}` };
    }

    // Remove from active judgments
    const updatedJudgments = { ...cfg.activeJudgments };
    delete updatedJudgments[member.id];
    await this.manager.updateModuleConfig(member.guild.id, "godsJudgment", {
      activeJudgments: updatedJudgments,
    });

    if (cfg.dmOnAction) {
      await member
        .send(
          `✅ You have been **released** from God's Judgment in **${member.guild.name}**.\n` +
            `> **Reason:** ${reason}\n> Your original roles have been restored.`
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
