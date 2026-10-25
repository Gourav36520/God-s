import { Events, type MessageReaction, type User } from "discord.js";
import { handleReactionRoleAdd } from "../reactionrole/service.js";

export const name = Events.MessageReactionAdd;
export const once = false;

export async function execute(
  reaction: MessageReaction,
  user?: User,
): Promise<void> {
  if (user) await handleReactionRoleAdd(reaction, user);
}