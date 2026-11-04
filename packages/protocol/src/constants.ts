/**
 * Transport invariants shared by relay, Host, and browser.
 *
 * The numbers mirror ZCode's relay transport where that transport has a
 * proven behavior, adjusted only where the DSH RPC surface needs more room.
 */

/** Wire protocol revision carried by hello and pairing messages. */
export const PROTOCOL_VERSION = 1

/** Maximum JSON bytes for one WebSocket message or one fragment envelope. */
export const MAX_PHYSICAL_FRAME_BYTES = 1024 * 1024

/** Maximum logical message bytes before fragmentation. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024

/** Maximum fragments per logical message. */
export const MAX_FRAGMENTS = 64

/** Raw fragment payload size; 16 MiB / 64 fragments, base64 stays under 1 MiB. */
export const FRAGMENT_BYTES = Math.ceil(MAX_MESSAGE_BYTES / MAX_FRAGMENTS)

/** Assembly must complete within this window or it is discarded. */
export const ASSEMBLY_TIMEOUT_MS = 30_000

/** Maximum concurrently assembling messages per connection. */
export const MAX_ASSEMBLIES = 64

/** Maximum bytes buffered across all assembling messages per connection. */
export const MAX_ASSEMBLY_BYTES = 64 * 1024 * 1024

/** Outbound replay buffer bounds. */
export const REPLAY_BUFFER_BYTES = 8 * 1024 * 1024
/** Outbound replay buffer lifetime. */
export const REPLAY_TTL_MS = 45_000

/** Flow control watermarks for unacknowledged outbound bytes. */
export const FLOW_HIGH_WATER_BYTES = 1024 * 1024
/** Flow control resumes below this mark. */
export const FLOW_LOW_WATER_BYTES = 256 * 1024

/** Heartbeat interval (base value; callers may add jitter). */
export const HEARTBEAT_INTERVAL_MS = 5_000
/** Close the connection when no ACK or traffic arrives within this window. */
export const ACK_WATCHDOG_MS = 15_000

/** Grace period before a disconnected Host is reported as offline. */
export const HOST_OFFLINE_GRACE_MS = 15_000
/** Window in which a second takeover escalates to session-conflict. */
export const KICK_CONFLICT_WINDOW_MS = 60_000
