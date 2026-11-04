import { PROTOCOL_VERSION } from './constants.ts'
import { ProtocolError, requireInteger, requireRecord, requireString } from './errors.ts'
import { parseRelayFrame } from './frames.ts'
import type { RelayFrame } from './frames.ts'

/** Error value returned by the Host for a failed unary RPC. */
export interface RpcErrorValue {
  code: string
  message: string
  data?: unknown
}

/** Application messages carried inside relay `data` payloads. */
export type AppPayload =
  | { type: 'hello'; protocolVersion: number; deviceName?: string; platform?: string }
  | {
      type: 'hello-ack'
      protocolVersion: number
      hostName: string
      hostVersion?: string
      capabilities: string[]
    }
  | { type: 'rpc-call'; rpcId: string; endpoint: string; payload: unknown }
  | { type: 'rpc-result'; rpcId: string; ok: true; value: unknown }
  | { type: 'rpc-result'; rpcId: string; ok: false; error: RpcErrorValue }
  | { type: 'rpc-frame'; rpcId: string; frame: RelayFrame }
  | {
      type: 'rpc-open'
      streamId: string
      endpoint: string
      payload: unknown
      recoveryId?: string
    }
  | { type: 'stream-frame'; frame: RelayFrame }
  | { type: 'stream-frame-ack'; streamId: string; messageSeq: number }
  | { type: 'stream-uplink'; streamId: string; value: unknown }
  | { type: 'stream-close'; streamId: string; reason?: string }
  | { type: 'error'; code: string; message?: string }

/** Validate one decoded application payload from the wire. */
export function parseAppPayload(value: unknown): AppPayload {
  const record = requireRecord(value, 'payload')
  const type = requireString(record.type, 'type')
  switch (type) {
    case 'hello': {
      const protocolVersion = requireInteger(record.protocolVersion, 'protocolVersion', 1)
      const deviceName = optionalString(record.deviceName, 'deviceName')
      const platform = optionalString(record.platform, 'platform')
      return {
        type,
        protocolVersion,
        ...(deviceName === undefined ? {} : { deviceName }),
        ...(platform === undefined ? {} : { platform }),
      }
    }
    case 'hello-ack': {
      const protocolVersion = requireInteger(record.protocolVersion, 'protocolVersion', 1)
      const hostName = requireString(record.hostName, 'hostName')
      const hostVersion = optionalString(record.hostVersion, 'hostVersion')
      const capabilities = record.capabilities
      if (!Array.isArray(capabilities) || !capabilities.every((item) => typeof item === 'string')) {
        throw new ProtocolError('invalid-message', 'capabilities must be a string array')
      }
      return {
        type,
        protocolVersion,
        hostName,
        ...(hostVersion === undefined ? {} : { hostVersion }),
        capabilities: [...capabilities],
      }
    }
    case 'rpc-call': {
      const rpcId = requireString(record.rpcId, 'rpcId')
      const endpoint = requireString(record.endpoint, 'endpoint')
      return { type, rpcId, endpoint, payload: record.payload }
    }
    case 'rpc-result': {
      const rpcId = requireString(record.rpcId, 'rpcId')
      if (record.ok === true) return { type, rpcId, ok: true, value: record.value }
      if (record.ok !== false) {
        throw new ProtocolError('invalid-message', 'rpc-result.ok must be a boolean')
      }
      const errorRecord = requireRecord(record.error, 'error')
      const code = requireString(errorRecord.code, 'error.code')
      const message = requireString(errorRecord.message, 'error.message', true)
      return {
        type,
        rpcId,
        ok: false,
        error: {
          code,
          message,
          ...(errorRecord.data === undefined ? {} : { data: errorRecord.data }),
        },
      }
    }
    case 'rpc-frame': {
      const rpcId = requireString(record.rpcId, 'rpcId')
      return { type, rpcId, frame: parseRelayFrame(record.frame) }
    }
    case 'rpc-open': {
      const streamId = requireString(record.streamId, 'streamId')
      const endpoint = requireString(record.endpoint, 'endpoint')
      const recoveryId = optionalString(record.recoveryId, 'recoveryId')
      return {
        type,
        streamId,
        endpoint,
        payload: record.payload,
        ...(recoveryId === undefined ? {} : { recoveryId }),
      }
    }
    case 'stream-frame':
      return { type, frame: parseRelayFrame(record.frame) }
    case 'stream-frame-ack': {
      const streamId = requireString(record.streamId, 'streamId')
      const messageSeq = requireInteger(record.messageSeq, 'messageSeq', 1)
      return { type, streamId, messageSeq }
    }
    case 'stream-uplink': {
      const streamId = requireString(record.streamId, 'streamId')
      return { type, streamId, value: record.value }
    }
    case 'stream-close': {
      const streamId = requireString(record.streamId, 'streamId')
      const reason = optionalString(record.reason, 'reason')
      return { type, streamId, ...(reason === undefined ? {} : { reason }) }
    }
    case 'error': {
      const code = requireString(record.code, 'code')
      const message = optionalString(record.message, 'message')
      return { type, code, ...(message === undefined ? {} : { message }) }
    }
    default:
      throw new ProtocolError('unknown-message', `unknown app payload type ${type}`)
  }
}

/** Whether a peer speaks the protocol revision this build implements. */
export { PROTOCOL_VERSION }

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, name, true)
}
