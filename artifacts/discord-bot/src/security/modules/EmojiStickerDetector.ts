import { Client, Events, Message } from "discord.js";
import { loggingService } from "../../lib/registry.js";
import { logger } from "../../lib/logger.js";
import type { SecurityManager } from "../SecurityManager.js";

const EMOJI_STICKER_THRESHOLD = 5;
const CUSTOM_EMOJI_REGEX = /<a?:[\w~]+:\d+>/gu;
const UNICODE_EMOJI_REGEX =
  /\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\p{Emoji_Modifier})?)*/gu;

export class EmojiStickerDetector {
  constructor(private readonly manager: SecurityManager) {}

  register(client: Client): void {
    client.on(Events.MessageCreate, (message: Message) => {
      void this.onMessage(message);
    });
    logger.info("EmojiStickerDetector: registered messageCreate handler");
  }

  private async onMessage(message: Message): Promise<void> {
    if (!message.inGuild() || message.author.bot) return;

    const member = message.member;
    if (!member) return;
    if (this.manager.isExempt(member)) return;
    if (this.manager.isExemptChannel(message.channelId, message.guildId)) return;

    const customEmojiCount = message.content.match(CUSTOM_EMOJI_REGEX)?.length ?? 0;
    const unicodeContent = message.content.replace(CUSTOM_EMOJI_REGEX, "");
    const unicodeEmojiCount =
      unicodeContent.match(UNICODE_EMOJI_REGEX)?.length ?? 0;
    const stickerCount = message.stickers.size;
    const totalCount = customEmojiCount + unicodeEmojiCount + stickerCount;

    if (totalCount < EMOJI_STICKER_THRESHOLD) return;

    const reason = `Emoji/sticker spam detected: ${totalCount} usages in one message`;
    const result = await this.manager
      .getHeatEngine()
      .addViolation(member, "emoji", reason);

    await loggingService
      .logSecurityTrigger({
        guildId: message.guildId,
        module: "Emoji/Sticker",
        member,
        action: result.punishment.punishment,
        reason,
        extra: [
          { name: "Usages", value: `${totalCount}`, inline: true },
          { name: "Heat Added", value: "+8", inline: true },
          { name: "Severity", value: result.severity, inline: true },
        ],
      })
      .catch((error) =>
        logger.warn(
          `EmojiStickerDetector: failed to send security log — ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      );
  }
}