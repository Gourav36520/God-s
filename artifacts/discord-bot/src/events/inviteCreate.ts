import { Events } from "discord.js";
import type { Invite } from "discord.js";
import { inviteTracker } from "../trackers/invite-tracker.js";

export const name = Events.InviteCreate;
export const once = false;

export function execute(invite: Invite): void {
  inviteTracker.recordInviteCreate(invite);
}
