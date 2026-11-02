import { Events } from "discord.js";
import type { VoiceState } from "discord.js";
import { voiceTracker } from "../trackers/voice-tracker.js";

export const name = Events.VoiceStateUpdate;
export const once = false;

export function execute(oldState: VoiceState, newState: VoiceState): void {
  if (newState.member?.user.bot ?? oldState.member?.user.bot ?? false) return;
  voiceTracker.handleVoiceStateChange(
    newState.guild.id,
    newState.id,
    oldState.channelId,
    newState.channelId,
  );
}
