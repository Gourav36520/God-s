import { Events } from "discord.js";
import type { VoiceState } from "discord.js";
import { logger } from "../lib/logger.js";
import { loggingService } from "../lib/registry.js";
import { voiceTracker } from "../trackers/voice-tracker.js";

export const name = Events.VoiceStateUpdate;
export const once = false;

export async function execute(
  oldState: VoiceState,
  newState: VoiceState,
): Promise<void> {
  if (newState.member?.user.bot ?? oldState.member?.user.bot ?? false) return;
  voiceTracker.handleVoiceStateChange(
    newState.guild.id,
    newState.id,
    oldState.channelId,
    newState.channelId,
  );
  try {
    await loggingService.logVoiceStateUpdate(oldState, newState);
  } catch (error) {
    logger.warn("Voice state logging failed:", error);
  }
}
