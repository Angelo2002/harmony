import type { User } from './types.ts';

/** Gateway opcodes, mirroring Discord's layout so tooling stays familiar. */
export const GatewayOp = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  Hello: 10,
  HeartbeatAck: 11,
} as const;
export type GatewayOpCode = (typeof GatewayOp)[keyof typeof GatewayOp];

/** Named dispatch events pushed from server to client. */
export const GatewayEvent = {
  Ready: 'READY',
  MessageCreate: 'MESSAGE_CREATE',
  MessageUpdate: 'MESSAGE_UPDATE',
  MessageDelete: 'MESSAGE_DELETE',
  TypingStart: 'TYPING_START',
  ChannelCreate: 'CHANNEL_CREATE',
  ChannelUpdate: 'CHANNEL_UPDATE',
  ChannelDelete: 'CHANNEL_DELETE',
  CategoryCreate: 'CATEGORY_CREATE',
  CategoryUpdate: 'CATEGORY_UPDATE',
  CategoryDelete: 'CATEGORY_DELETE',
} as const;
export type GatewayEventName = (typeof GatewayEvent)[keyof typeof GatewayEvent];

/** WebSocket close codes used by the gateway (mirrors Discord's range). */
export const GatewayCloseCode = {
  AuthenticationFailed: 4004,
} as const;

/** Server -> client payload sent immediately on connect. */
export interface GatewayHello {
  heartbeat_interval: number;
  gateway_version: number;
}

/** Client -> server payload that authenticates the connection. */
export interface GatewayIdentify {
  token: string;
}

/** First dispatch after a successful identify. */
export interface GatewayReady {
  user: User;
  gateway_version: number;
}

export interface MessageDeletePayload {
  id: string;
  channelId: string;
}

export interface TypingStartPayload {
  channelId: string;
  user: User;
}

/** Envelope for every gateway frame. */
export interface GatewayFrame<T = unknown> {
  op: GatewayOpCode;
  t?: GatewayEventName;
  d?: T;
}
