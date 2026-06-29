import { Client, Events, Message } from "discord.js";
import { BaseSecurityModule } from "../BaseSecurityModule.js";
import type { SecurityManager } from "../SecurityManager.js";
import { loggingService } from "../../lib/registry.js";
import { logger } from "../../lib/logger.js";

const LINK_REGEX =
  /(?:https?:\/\/|www\.)[^\s<>"'`]+|(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+(?:gg|com|net|org|io|co|me|tv|app|dev|xyz|info|biz|edu|gov|cc|us|uk|ca|de|fr|jp|ru|au|br|es|it|nl|pl|se|no|fi|dk|be|at|ch|cz|ro|hu|pt|gr|tr|ar|mx|in|id|ph|vn|th|tw|kr|sg|nz|za|hk|my|link|site|online|store|shop|club)(?:\/[^\s<>"'`]*)?/gi;

export class AntiLink extends BaseSecurityModule {
  constructor(manager: SecurityManager) {
    super("antiLink", manager);
  }

  get name() {
    return "Anti-Link";
  }

  get description() {
    return "Detects and acts on links posted by non-whitelisted users.";
  }

  register(client: Client): void {
    client.on(Events.MessageCreate, (msg: Message) => {
      void this.onMessage(msg, client);
    });
    logger.info("AntiLink: registered messageCreate handler");
  }

  private async onMessage(message: Message, client: Client): Promise<void> {
    if (!message.inGuild() || message.author.bot) return;

    const { guildId } = message;

    logger.info(
      `AntiLink: received message — author=${message.author.tag} (${message.author.id})` +
      ` guild=${guildId} channel=${message.channelId}` +
      ` content=${JSON.stringify(message.content)}`
    );

    const cfg = this.manager.getConfig(guildId).antiLink;
    if (!cfg.enabled) {
      logger.info("AntiLink: skipped — module disabled in this guild");
      return;
    }

    if (!message.content) {
      logger.warn(
        "AntiLink: message.content is empty — MessageContent intent may not be enabled " +
        "or this message type carries no text content. Skipping."
      );
      return;
    }

    const member = message.member;
    if (!member) {
      logger.info("AntiLink: skipped — could not resolve member");
      return;
    }

    if (member.id === message.guild.ownerId) {
      logger.info(`AntiLink: skipped — ${member.user.tag} is server owner`);
      return;
    }
    if (member.permissions.has("Administrator")) {
      logger.info(`AntiLink: skipped — ${member.user.tag} is Administrator`);
      return;
    }
    if (cfg.bypassRoles.some((rid) => member.roles.cache.has(rid))) {
      logger.info(`AntiLink: skipped — ${member.user.tag} has a whitelisted role`);
      return;
    }
    if (this.isExemptChannel(message.channelId, guildId)) {
      logger.info(`AntiLink: skipped — channel ${message.channelId} is exempt`);
      return;
    }

    LINK_REGEX.lastIndex = 0;
    const matches = message.content.match(LINK_REGEX);

    if (!matches || matches.length === 0) {
      logger.info(`AntiLink: no URL matched in message — regex found nothing`);
      return;
    }

    logger.info(`AntiLink: URL regex matched ${matches.length} candidate(s): ${matches.join(", ")}`);

    const blocked = matches.filter((url) => {
      const domain = extractDomain(url);
      const isAllowed = cfg.allowedDomains.some(
        (d) => domain === d || domain.endsWith(`.${d}`)
      );
      logger.info(`AntiLink: URL="${url}" domain="${domain}" allowed=${isAllowed}`);
      return !isAllowed;
    });

    if (blocked.length === 0) {
      logger.info("AntiLink: all matched URLs are in allowedDomains — no action");
      return;
    }

    logger.info(
      `AntiLink: LINK DETECTED — ${member.user.tag} (${member.id}) ` +
      `blocked URLs: ${blocked.join(", ")} — action=${cfg.action}`
    );

    await this.deleteMessage(message);
    logger.info(`AntiLink: MESSAGE DELETED from ${member.user.tag} in channel ${message.channelId}`);

    if (cfg.action !== "delete") {
      const reason = `Posted blocked link(s): ${blocked.slice(0, 3).join(", ")}`;
      const result = await this.applyAction(member, cfg.action, reason);
      if (!result.success) {
        logger.error(`AntiLink: action "${cfg.action}" failed for ${member.user.tag} — ${result.reason}`);
      } else {
        logger.info(`AntiLink: ACTION APPLIED — "${cfg.action}" on ${member.user.tag}`);
      }
    }

    await loggingService
      .logSecurityTrigger({
        guildId,
        module: "Anti-Link",
        member,
        action: cfg.action,
        reason: "Posted blocked link(s)",
        extra: [
          { name: "Blocked URLs", value: blocked.slice(0, 5).join("\n") || "—", inline: false },
          { name: "Channel", value: `<#${message.channelId}>`, inline: true },
        ],
      })
      .catch((err) =>
        logger.warn(`AntiLink: failed to send security log — ${err instanceof Error ? err.message : err}`)
      );

    void (client.user?.id);
  }
}

function extractDomain(url: string): string {
  try {
    const withScheme = /^https?:\/\//i.test(url) ? url : `http://${url}`;
    return new URL(withScheme).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return url.split("/")[0].replace(/^www\./i, "").toLowerCase();
  }
}
