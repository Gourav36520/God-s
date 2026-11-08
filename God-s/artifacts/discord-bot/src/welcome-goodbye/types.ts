export type GreetingKind = "welcome" | "goodbye";

export interface WelcomeGoodbyeFlowConfig {
  enabled: boolean;
  channelId: string | null;
  embedId: string | null;
  message: string;
}

export interface WelcomeGoodbyeEmbedDefinition {
  content: string;
  title: string;
  titleUrl: string;
  authorName: string;
  authorUrl: string;
  authorIconUrl: string;
  description: string;
  thumbnailUrl: string;
  imageUrl: string;
  footerText: string;
  footerIconUrl: string;
  footerUrl: string;
  color: string;
  timestamp: boolean;
}

export interface SavedWelcomeGoodbyeEmbed {
  id: string;
  name: string;
  definition: WelcomeGoodbyeEmbedDefinition;
  createdAt: string;
}

export interface WelcomeGoodbyeGuildConfig {
  welcome: WelcomeGoodbyeFlowConfig;
  goodbye: WelcomeGoodbyeFlowConfig;
  embeds: SavedWelcomeGoodbyeEmbed[];
}

export function createDefaultFlowConfig(): WelcomeGoodbyeFlowConfig {
  return {
    enabled: false,
    channelId: null,
    embedId: null,
    message: "",
  };
}

export function createDefaultEmbedDefinition(): WelcomeGoodbyeEmbedDefinition {
  return {
    content: "",
    title: "",
    titleUrl: "",
    authorName: "",
    authorUrl: "",
    authorIconUrl: "",
    description: "",
    thumbnailUrl: "",
    imageUrl: "",
    footerText: "",
    footerIconUrl: "",
    footerUrl: "",
    color: "",
    timestamp: false,
  };
}

export function createDefaultGuildConfig(): WelcomeGoodbyeGuildConfig {
  return {
    welcome: createDefaultFlowConfig(),
    goodbye: createDefaultFlowConfig(),
    embeds: [],
  };
}