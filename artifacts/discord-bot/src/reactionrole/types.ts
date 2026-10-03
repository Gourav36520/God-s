export interface ReactionRoleMapping {
  emoji: string;
  emojiKey: string;
  roleId: string;
}

export interface ReactionRolePanel {
  channelId: string;
  messageId: string;
  title: string;
  description: string;
  createdByBot: boolean;
  mappings: ReactionRoleMapping[];
}

export interface ReactionRoleAssignment {
  channelId: string;
  messageId: string;
  emojiKey: string;
  roleId: string;
  roleGrantedBySystem: boolean;
}