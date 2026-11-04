/**
 * Opaque identifiers that cross the relay, Host, and browser boundaries.
 *
 * They are branded so a device id cannot be passed where a host id is expected.
 * Constructors exist for the two places that legitimately mint ids: persistence
 * and validated wire parsing. Everything else passes the branded value through.
 */
declare const brand: unique symbol

/** Intersection carrying a compile-time-only brand tag. */
export type Brand<T, B extends string> = T & { readonly [brand]: B }

/** Host identity minted by a DSH Host on first start. */
export type HostId = Brand<string, 'HostId'>
/** Device identity minted by the relay when a phone claims a pairing token. */
export type DeviceId = Brand<string, 'DeviceId'>
/** One-time pairing token carried in the QR code. */
export type PairToken = Brand<string, 'PairToken'>
/** Long-lived device credential stored in the phone browser. */
export type DeviceToken = Brand<string, 'DeviceToken'>
/** Relay-issued credential for a Host WebSocket connection. */
export type HostToken = Brand<string, 'HostToken'>
/** Server-side connection identity for one WebSocket leg. */
export type ConnectionId = Brand<string, 'ConnectionId'>
/** Client-minted unary RPC identity. */
export type RpcId = Brand<string, 'RpcId'>
/** Client-minted logical stream identity. */
export type StreamId = Brand<string, 'StreamId'>

/** Brand a string as a {@link HostId} after validation. */
export const asHostId = (value: string): HostId => value as HostId
/** Brand a string as a {@link DeviceId} after validation. */
export const asDeviceId = (value: string): DeviceId => value as DeviceId
/** Brand a string as a {@link PairToken} after validation. */
export const asPairToken = (value: string): PairToken => value as PairToken
/** Brand a string as a {@link DeviceToken} after validation. */
export const asDeviceToken = (value: string): DeviceToken => value as DeviceToken
/** Brand a string as a {@link HostToken} after validation. */
export const asHostToken = (value: string): HostToken => value as HostToken
/** Brand a string as a {@link ConnectionId} after validation. */
export const asConnectionId = (value: string): ConnectionId => value as ConnectionId
/** Brand a string as a {@link RpcId} after validation. */
export const asRpcId = (value: string): RpcId => value as RpcId
/** Brand a string as a {@link StreamId} after validation. */
export const asStreamId = (value: string): StreamId => value as StreamId
