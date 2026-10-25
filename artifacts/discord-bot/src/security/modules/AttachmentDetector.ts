import { Client, Events, Message } from "discord.js";
import { loggingService } from "../../lib/registry.js";
import { logger } from "../../lib/logger.js";
import type { SecurityManager } from "../SecurityManager.js";

export class AttachmentDetector {
  constructor(private readonly manager: SecurityManager) {}

  register(client: Client): void {
    client.on(Events.MessageCreate, (message: Message) => {
      void this.onMessage(message);
    });
    logger.info("AttachmentDetector: registered messageCreate handler");
  }

  private async onMessage(message: Message): Promise<void> {
    if (!message.inGuild() || message.author.bot) return;

    const member = message.member;
    if (!member) return;
    if (this.manager.isExempt(member)) return;
    if (this.manager.isExemptChannel(message.channelId, message.guildId)) return;
    if (message.attachments.size === 0) return;

    const attachmentCount = message.attachments.size;
    const reason = `Attachment detected: ${attachmentCount} attachment${
      attachmentCount === 1 ? "" : "s"
    }`;
    const result = await this.manager
      .getHeatEngine()
      .addViolation(member, "attachment", reason);

    await loggingService
      .logSecurityTrigger({
        guildId: message.guildId,
        module: "Attachment",
        member,
        action: result.punishment.punishment,
        reason,
        extra: [
          { name: "Attachments", value: `${attachmentCount}`, inline: true },
          { name: "Heat Added", value: "+12", inline: true },
          { name: "Severity", value: result.severity, inline: true },
        ],
      })
      .catch((error) =>
        logger.warn(
          `AttachmentDetector: failed to send security log — ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
  }
}