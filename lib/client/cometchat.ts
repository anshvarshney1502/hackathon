"use client";

/**
 * Browser-only CometChat SDK access, following the MCP-verified order:
 * init() → getLoggedinUser() → login(authToken). The SDK touches `window`,
 * so it is loaded with a dynamic import and never during SSR.
 */
import type { CometChat as CometChatClass } from "@cometchat/chat-sdk-javascript";
import { publicEnv } from "./env";

export type CC = typeof CometChatClass;

let sdkPromise: Promise<CC> | null = null;

export function getCometChat(): Promise<CC> {
  if (!sdkPromise) {
    sdkPromise = (async () => {
      const env = publicEnv();
      if (!env.ok) throw new Error(`Missing ${env.missing.join(", ")}`);
      const { CometChat } = await import("@cometchat/chat-sdk-javascript");
      const settings = new CometChat.AppSettingsBuilder()
        .subscribePresenceForAllUsers()
        .setRegion(env.region)
        .autoEstablishSocketConnection(true)
        .build();
      await CometChat.init(env.appId, settings);
      return CometChat;
    })().catch((e) => {
      sdkPromise = null;
      throw e;
    });
  }
  return sdkPromise;
}

/** Log in with a server-minted Auth Token, reusing an existing SDK session when it matches. */
export async function loginWithToken(uid: string, authToken: string): Promise<CC> {
  const CometChat = await getCometChat();
  const current = await CometChat.getLoggedinUser();
  if (current && current.getUid() === uid) return CometChat;
  if (current) await CometChat.logout();
  await CometChat.login(authToken);
  return CometChat;
}
