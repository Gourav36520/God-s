import { Events, type MessageReaction, type User } from "discord.js";
import { handleReactionRoleRemove } from "../reactionrole/service.js";

export const name = Events.MessageReactionRemove;
export const once = false;

export async function execute(
  reaction: MessageReaction,
  user?: User,
): Promise<void> {
  if (user) await handleReactionRoleRemove(reaction, user);
}