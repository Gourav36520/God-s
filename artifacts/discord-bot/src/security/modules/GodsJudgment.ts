import {
  ChannelType,
  EmbedBuilder,
  Guild,
  GuildMember,
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

  async setup(guild: Guild): Promise<SetupResult> {
    logger.info(`GodsJudgment.setup: starting for guild ${guild.id} (${guild.name})`);

    const botMember = guild.members.me;
    if (!botMember) {
      const reason = "Bot member not found in guild cache. Try again in a moment.";
      logger.error(`GodsJudgment.setup: ${reason}`);
      return { success: false, reason, roleCreated: false, channelCreated: false };
    }
    logger.info(`GodsJudgment.setup: bot member resolved (${botMember.user.tag})`);

    if (!botMember.permissions.has(PermissionFlagsBits.ManageRoles)) {
      const reason = "Bot is missing the **Manage Roles** permission. Grant it in Server Settings → Roles.";
      logger.error(`GodsJudgment.setup: ${reason}`);
      return { success: false, reason, roleCreated: false, channelCreated: false };
    }

    if (!botMember.permissions.has(PermissionFlagsBits.ManageChannels)) {
      const reason = "Bot is missing the **Manage Channels** permission. Grant it in Server Settings → Roles.";
      logger.error(`GodsJudgment.setup: ${reason}`);
      return { success: false, reason, roleCreated: false, channelCreated: false };
    }

    const botHighest = botMember.roles.highest;
    logger.info(`GodsJudgment.setup: bot's highest role is "${botHighest.name}" (position ${botHighest.position})`);

    if (botHighest.position < 1) {
      const reason = "Bot's highest role is at position 0. Move the bot's role above other roles so it can manage them.";
      logger.error(`GodsJudgment.setup: ${reason}`);
      return { success: false, reason, roleCreated: false, channelCreated: false };
    }

    const config = this.manager.getConfig(guild.id);
    const gjConfig = config.godsJudgment;

    let roleCreated = false;
    let channelCreated = false;

    let judgmentRole = gjConfig.judgmentRoleId
      ? (guild.roles.cache.get(gjConfig.judgmentRoleId) ??
         await guild.roles.fetch(gjConfig.judgmentRoleId).catch(() => null))
      : null;

    if (judgmentRole) {
      logger.info(`GodsJudgment.setup: found existing judgment role "${judgmentRole.name}" (${judgmentRole.id})`);
    } else {
      logger.info("GodsJudgment.setup: no existing judgment role — creating...");
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
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`GodsJudgment.setup: role creation failed — ${msg}`);
        return { success: false, reason: `Failed to create the judgment role: ${msg}`, roleCreated: false, channelCreated: false };
      }
    }

    let judgmentChannel: TextChannel | null = gjConfig.judgmentChannelId
      ? ((guild.channels.cache.get(gjConfig.judgmentChannelId) ??
          await guild.channels.fetch(gjConfig.judgmentChannelId).catch(() => null)) as TextChannel | null)
      : null;

    if (judgmentChannel) {
      logger.info(`GodsJudgment.setup: found existing judgment channel #${judgmentChannel.name} (${judgmentChannel.id})`);
    } else {
      logger.info("GodsJudgment.setup: no existing judgment channel — creating...");
      try {
        judgmentChannel = (await guild.channels.create({
          name: "gods-judgment",
          type: ChannelType.GuildText,
          topic: "Users placed under God's Judgment are confined here.",
          permissionOverwrites: [
            {
              id: guild.roles.everyone.id,
              type: OverwriteType.Role,
              deny: [PermissionFlagsBits.ViewChannel],
            },
            {
              id: judgmentRole.id,
              type: OverwriteType.Role,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
              ],
              deny: [
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.AddReactions,
              ],
            },
          ],
          reason: "God's Judgment system setup",
        })) as TextChannel;
        channelCreated = true;
        logger.info(`GodsJudgment.setup: ✓ channel created — id=${judgmentChannel.id}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`GodsJudgment.setup: channel creation failed — ${msg}`);
        return { success: false, reason: `Failed to create the judgment channel: ${msg}`, roleCreated, channelCreated: false };
      }
    }

    try {
      await this.manager.updateModuleConfig(guild.id, "godsJudgment", {
        judgmentRoleId: judgmentRole.id,
        judgmentChannelId: judgmentChannel.id,
        enabled: true,
      });
      logger.info("GodsJudgment.setup: ✓ config saved successfully");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`GodsJudgment.setup: config save failed — ${msg}`);
      return {
        success: false,
        reason: `Role and channel created, but config save failed: ${msg}`,
        roleId: judgmentRole.id,
        channelId: judgmentChannel.id,
        roleCreated,
        channelCreated,
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
    };
  }

  async placeInJudgment(
    member: GuildMember,
    reason: string,
    judgedBy: string
  ): Promise<JudgmentResult> {
    logger.info(`GodsJudgment.placeInJudgment: user=${member.user.tag} (${member.id}) guild=${member.guild.id}`);

    const config = this.manager.getConfig(member.guild.id);
    const gjConfig = config.godsJudgment;

    if (!gjConfig.judgmentRoleId) {
      return { success: false, reason: "God's Judgment role is not set up. Run `/judgment setup` first." };
    }

    if (gjConfig.activeJudgments[member.id]) {
      return { success: false, reason: `${member.user.tag} is already under God's Judgment.` };
    }

    const judgmentRole = member.guild.roles.cache.get(gjConfig.judgmentRoleId);
    if (!judgmentRole) {
      return { success: false, reason: "God's Judgment role not found. Run `/judgment setup` to recreate it." };
    }

    const savedRoles = member.roles.cache
      .filter((r) => r.id !== member.guild.roles.everyone.id)
      .map((r) => r.id);

    try {
      await member.roles.set([judgmentRole], `God's Judgment: ${reason}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`GodsJudgment.placeInJudgment: failed to set roles for ${member.id} — ${msg}`);
      return { success: false, reason: `Failed to modify roles: ${msg}` };
    }

    const record: JudgmentRecord = {
      userId: member.id,
      savedRoles,
      judgedAt: new Date().toISOString(),
      reason,
      judgedBy,
    };

    await this.manager.updateModuleConfig(member.guild.id, "godsJudgment", {
      activeJudgments: { ...gjConfig.activeJudgments, [member.id]: record },
    });

    if (gjConfig.dmOnAction) {
      await member
        .send(`⚖️ You have been placed under **God's Judgment** in **${member.guild.name}**.\n> **Reason:** ${reason}`)
        .catch(() => logger.warn(`GodsJudgment: could not DM ${member.id}`));
    }

    await loggingService.logJudgment({
      guildId: member.guild.id,
      target: member,
      moderatorId: judgedBy,
      reason,
      savedRoles,
    });

    if (gjConfig.judgmentChannelId) {
      const channel = member.guild.channels.cache.get(gjConfig.judgmentChannelId) as TextChannel | undefined;
      if (channel) {
        await channel
          .send(`⚖️ <@${member.id}>, you have been placed under **God's Judgment**.\n> **Reason:** ${reason}`)
          .catch(() => null);
      }
    }

    logger.info(`GodsJudgment.placeInJudgment: ✓ complete for ${member.user.tag}`);
    return { success: true, reason: "User placed under God's Judgment.", record };
  }

  async release(
    member: GuildMember,
    reason: string,
    releasedBy: string
  ): Promise<JudgmentResult> {
    logger.info(`GodsJudgment.release: user=${member.user.tag} (${member.id}) guild=${member.guild.id}`);

    const config = this.manager.getConfig(member.guild.id);
    const gjConfig = config.godsJudgment;
    const record = gjConfig.activeJudgments[member.id];

    if (!record) {
      return { success: false, reason: `${member.user.tag} is not currently under God's Judgment.` };
    }

    const rolesToRestore = record.savedRoles.filter((id) => member.guild.roles.cache.has(id));
    const skippedRoles = record.savedRoles.length - rolesToRestore.length;

    try {
      await member.roles.set(rolesToRestore, `Released from God's Judgment: ${reason}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`GodsJudgment.release: failed to restore roles for ${member.id} — ${msg}`);
      return { success: false, reason: `Failed to restore roles: ${msg}` };
    }

    const updatedJudgments = { ...gjConfig.activeJudgments };
    delete updatedJudgments[member.id];

    await this.manager.updateModuleConfig(member.guild.id, "godsJudgment", {
      activeJudgments: updatedJudgments,
    });

    if (gjConfig.dmOnAction) {
      await member
        .send(
          `✅ You have been **released** from God's Judgment in **${member.guild.name}**.\n> **Reason:** ${reason}\n> Your original roles have been restored.`
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

  getActiveJudgments(guildId: string): JudgmentRecord[] {
    const config = this.manager.getConfig(guildId);
    return Object.values(config.godsJudgment.activeJudgments);
  }

  isUnderJudgment(guildId: string, userId: string): boolean {
    const config = this.manager.getConfig(guildId);
    return !!config.godsJudgment.activeJudgments[userId];
  }

  buildStatusEmbed(guildId: string, guildName: string): EmbedBuilder {
    const config = this.manager.getConfig(guildId);
    const gjConfig = config.godsJudgment;
    const active = Object.values(gjConfig.activeJudgments);

    return new EmbedBuilder()
      .setTitle("⚖️ God's Judgment — Status")
      .setColor(0xfee75c)
      .addFields(
        { name: "Status", value: gjConfig.enabled ? "🟢 Enabled" : "🔴 Disabled", inline: true },
        { name: "Judgment Role", value: gjConfig.judgmentRoleId ? `<@&${gjConfig.judgmentRoleId}>` : "Not set — run `/judgment setup`", inline: true },
        { name: "Judgment Channel", value: gjConfig.judgmentChannelId ? `<#${gjConfig.judgmentChannelId}>` : "Not set — run `/judgment setup`", inline: true },
        { name: "DM on Action", value: gjConfig.dmOnAction ? "Yes" : "No", inline: true },
        {
          name: `Currently Under Judgment (${active.length})`,
          value:
            active.length > 0
              ? active
                  .map(
                    (r) =>
                      `• <@${r.userId}> — ${r.reason} *(by <@${r.judgedBy}>, <t:${Math.floor(new Date(r.judgedAt).getTime() / 1000)}:R>)*`
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
