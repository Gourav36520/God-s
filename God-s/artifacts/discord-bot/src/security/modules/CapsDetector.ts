import { Client, Events, GuildMember, Message } from "discord.js";
import { loggingService } from "../../lib/registry.js";
import { logger } from "../../lib/logger.js";
import type { SecurityManager } from "../SecurityManager.js";

const MINIMUM_LETTERS = 5;
const UPPERCASE_RATIO = 0.7;

export class CapsDetector {
  constructor(private readonly manager: SecurityManager) {}

  register(client: Client): void {
    client.on(Events.MessageCreate, (message: Message) => {
      void this.onMessage(message);
    });
    logger.info("CapsDetector: registered messageCreate handler");
  }

  private async onMessage(message: Message): Promise<void> {
    if (!message.inGuild() || message.author.bot) return;

    const member = message.member;
    if (!member) return;
    if (this.manager.isExempt(member)) return;
    if (this.manager.isExemptChannel(message.channelId, message.guildId)) return;

    const letters = message.content.match(/[a-z]/gi) ?? [];
    if (letters.length < MINIMUM_LETTERS) return;

    const uppercaseLetters = letters.filter((letter) => /[A-Z]/.test(letter));
    if (uppercaseLetters.length / letters.length < UPPERCASE_RATIO) return;

    const reason = `Excessive capitalization detected: ${Math.round(
      (uppercaseLetters.length / letters.length) * 100
    )}% uppercase letters`;
    const result = await this.manager
      .getHeatEngine()
      .addViolation(member, "caps", reason);

    await loggingService
      .logSecurityTrigger({
        guildId: message.guildId,
        module: "Caps",
        member,
        action: result.punishment.punishment,
        reason,
        extra: [
          { name: "Heat Added", value: "+5", inline: true },
          { name: "Severity", value: result.severity, inline: true },
        ],
      })
      .catch((error) =>
        logger.warn(
          `CapsDetector: failed to send security log — ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
  }
}