import type { GuildMember } from "discord.js";

export const MEMBER_AVATAR_VARIABLE = "(user{avatar})";

export const VARIABLE_GUIDE = [
  "`(user)` member mention",
  "`(name)` member name",
  "`(user{avatar})` member avatar URL",
  "`(server)` server name",
  "`(membercount)` current member count",
].join(" · ");

export function renderMessageText(
  value: string,
  member?: GuildMember,
): string {
  const replacements: Record<string, string> = {
    "(user)": member ? `<@${member.id}>` : "@member",
    "(name)": member?.displayName || member?.user.username || "Member",
    [MEMBER_AVATAR_VARIABLE]: member
      ? member.displayAvatarURL({ extension: "png", size: 512 })
      : "https://example.com/member-avatar.png",
    "(server)": member?.guild.name ?? "Server",
    "(membercount)": String(member?.guild.memberCount ?? 0),
  };

  return value.replace(
    /\(user\)|\(name\)|\(user\{avatar\}\)|\(server\)|\(membercount\)/g,
    (variable) => replacements[variable] ?? variable,
  );
}

export function renderImageUrl(
  value: string,
  member?: GuildMember,
): string {
  if (value === MEMBER_AVATAR_VARIABLE) {
    return member
      ? member.displayAvatarURL({ extension: "png", size: 512 })
      : "https://example.com/member-avatar.png";
  }
  return value;
}