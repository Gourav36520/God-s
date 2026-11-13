import { Events } from "discord.js";
import type { Client, PartialUser, User } from "discord.js";
import { logger } from "../lib/logger.js";
import { memberCardService } from "../member-cards/service.js";
import { memberCardStore } from "../member-cards/store.js";
import type { NewMemberProfileChange } from "../member-cards/types.js";

function avatarUrl(user: User | PartialUser): string {
  return user.displayAvatarURL({ extension: "png", size: 256 });
}

export function registerMemberCardEvents(client: Client): void {
  client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
    const guildId = newMember.guild.id;
    const userId = newMember.id;
    if (!(await memberCardService.isTracked(guildId, userId))) return;

    const changes: NewMemberProfileChange[] = [];
    if (oldMember.nickname !== newMember.nickname) {
      changes.push({
        kind: "name",
        field: "nickname",
        previousValue: oldMember.displayName,
        newValue: newMember.displayName,
      });
    }
    if (oldMember.avatar !== newMember.avatar) {
      changes.push({
        kind: "avatar",
        previousValue: oldMember.displayAvatarURL({
          extension: "png",
          size: 256,
        }),
        newValue: newMember.displayAvatarURL({
          extension: "png",
          size: 256,
        }),
      });
    }
    for (const change of changes) {
      await memberCardStore.addChange(guildId, userId, change).catch((error) => {
        logger.warn(
          `Could not save member-card name history for ${userId}:`,
          error instanceof Error ? error.message : "unknown error",
        );
      });
    }

    const oldRoles = new Set(
      oldMember.roles.cache
        .filter((role) => role.id !== guildId)
        .map((role) => role.id),
    );
    const rolesChanged =
      oldRoles.size !==
        newMember.roles.cache.filter((role) => role.id !== guildId).size ||
      newMember.roles.cache.some(
        (role) => role.id !== guildId && !oldRoles.has(role.id),
      );
    const profileChanged =
      oldMember.nickname !== newMember.nickname ||
      oldMember.avatar !== newMember.avatar ||
      oldMember.premiumSinceTimestamp !== newMember.premiumSinceTimestamp ||
      oldMember.communicationDisabledUntilTimestamp !==
        newMember.communicationDisabledUntilTimestamp;
    const kinds = new Set<"member" | "history" | "roles">();
    if (profileChanged || rolesChanged) kinds.add("member");
    if (changes.length > 0) kinds.add("history");
    if (rolesChanged) kinds.add("roles");
    if (kinds.size === 0) return;

    await memberCardService
      .refreshMember(newMember, [...kinds])
      .catch((error) =>
        logger.warn(
          `Member-card update failed for ${userId} in guild ${guildId}:`,
          error instanceof Error ? error.message : "unknown error",
        ),
      );
  });

  client.on(Events.UserUpdate, async (oldUser, newUser) => {
    const nameChanged =
      oldUser.username !== newUser.username ||
      oldUser.globalName !== newUser.globalName;
    const avatarChanged = oldUser.avatar !== newUser.avatar;
    if (!nameChanged && !avatarChanged) return;

    for (const guild of client.guilds.cache.values()) {
      if (!(await memberCardService.isTracked(guild.id, newUser.id))) continue;
      const member =
        guild.members.cache.get(newUser.id) ??
        (await guild.members.fetch(newUser.id).catch(() => null));
      if (!member) continue;

      const timestamp = new Date().toISOString();
      const nameChanges: NewMemberProfileChange[] = [];
      if (oldUser.username !== newUser.username) {
        nameChanges.push({
          kind: "name",
          field: "username",
          previousValue: `@${oldUser.username}`,
          newValue: `@${newUser.username}`,
          occurredAt: timestamp,
        });
      }
      if (oldUser.globalName !== newUser.globalName) {
        const oldDisplayName =
          oldUser.globalName ?? oldUser.username ?? "Unavailable";
        const newDisplayName =
          newUser.globalName ?? newUser.username ?? "Unavailable";
        nameChanges.push({
          kind: "name",
          field: "displayName",
          previousValue: oldDisplayName,
          newValue: newDisplayName,
          occurredAt: timestamp,
        });
      }
      for (const change of nameChanges) {
        await memberCardStore
          .addChange(guild.id, newUser.id, change)
          .catch((error) =>
            logger.warn(
              `Could not save member-card profile history for ${newUser.id}:`,
              error instanceof Error ? error.message : "unknown error",
            ),
          );
      }
      if (avatarChanged) {
        await memberCardStore
          .addChange(guild.id, newUser.id, {
            kind: "avatar",
            previousValue: avatarUrl(oldUser),
            newValue: avatarUrl(newUser),
            occurredAt: timestamp,
          })
          .catch((error) =>
            logger.warn(
              `Could not save member-card avatar history for ${newUser.id}:`,
              error instanceof Error ? error.message : "unknown error",
            ),
          );
      }
      await memberCardService
        .refreshMember(member, ["member", "history"])
        .catch((error) =>
          logger.warn(
            `Member profile cards could not be refreshed for ${newUser.id} in guild ${guild.id}:`,
            error instanceof Error ? error.message : "unknown error",
          ),
        );
    }
  });
}
