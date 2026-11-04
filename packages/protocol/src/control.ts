import { PROTOCOL_VERSION } from './constants.ts'
import { ProtocolError, requireInteger, requireRecord, requireString } from './errors.ts'
import { asHostId } from './ids.ts'
import type { HostId } from './ids.ts'

/** Pairing state the relay reports to either side of a pairing session. */
export type PairStatus = 'waiting' | 'matched' | 'kicked' | 'offline'

/** Relay-level error codes carry no application content. */
export type RelayErrorCode =
  | 'AUTH_FAILED'
  | 'WRONG_PARAM'
  | 'KICKED'
  | 'INTERNAL'
  | 'DEVICE_OFFLINE'

/** Messages exchanged directly with the relay, outside application payloads. */
export type RelayControlMessage =
  | {
      type: 'host_hello'
      protocolVersion: number
      hostId: HostId
      hostName?: string
    }
  | {
      type: 'device_hello'
      protocolVersion: number
      hostId: HostId
      /** Optional echo of the token-bound device id; omitted when the client has not learned it. */
      deviceId?: string
      deviceName?: string
    }
  | {
      type: 'hello_ack'
      protocolVersion: number
      connectionId: string
      hostId: HostId
      pairStatus: PairStatus
    }
  | { type: 'pair_status_query'; clientTs?: number }
  | { type: 'pair_status_ack'; pairStatus: PairStatus; clientTs?: number }
  | { type: 'data'; payload: unknown }
  | { type: 'error'; code: RelayErrorCode; message?: string }
  | { type: 'ping'; ts: number }
  | { type: 'pong'; ts: number }
  | { type: 'kicked'; reason: 'replaced' | 'revoked' }

const PAIR_STATUS: readonly PairStatus[] = ['waiting', 'matched', 'kicked', 'offline']
const RELAY_ERROR_CODES: readonly RelayErrorCode[] = [
  'AUTH_FAILED',
  'WRONG_PARAM',
  'KICKED',
  'INTERNAL',
  'DEVICE_OFFLINE',
]

/** Validate one decoded relay control message from the wire. */
export function parseRelayControlMessage(value: unknown): RelayControlMessage {
  const record = requireRecord(value, 'message')
  const type = requireString(record.type, 'type')
  switch (type) {
    case 'host_hello': {
      const protocolVersion = requireInteger(record.protocolVersion, 'protocolVersion', 1)
      const hostId = asHostId(requireString(record.hostId, 'hostId'))
      const hostName = optionalString(record.hostName, 'hostName')
      return { type, protocolVersion, hostId, ...(hostName === undefined ? {} : { hostName }) }
    }
    case 'device_hello': {
      const protocolVersion = requireInteger(record.protocolVersion, 'protocolVersion', 1)
      const hostId = asHostId(requireString(record.hostId, 'hostId'))
      const deviceId = optionalString(record.deviceId, 'deviceId')
      const deviceName = optionalString(record.deviceName, 'deviceName')
      return {
        type,
        protocolVersion,
        hostId,
        ...(deviceId === undefined ? {} : { deviceId }),
        ...(deviceName === undefined ? {} : { deviceName }),
      }
    }
    case 'hello_ack': {
      const protocolVersion = requireInteger(record.protocolVersion, 'protocolVersion', 1)
      const connectionId = requireString(record.connectionId, 'connectionId')
      const hostId = asHostId(requireString(record.hostId, 'hostId'))
      const pairStatus = requirePairStatus(record.pairStatus)
      return { type, protocolVersion, connectionId, hostId, pairStatus }
    }
    case 'pair_status_query': {
      const clientTs = optionalInteger(record.clientTs, 'clientTs')
      return { type, ...(clientTs === undefined ? {} : { clientTs }) }
    }
    case 'pair_status_ack': {
      const pairStatus = requirePairStatus(record.pairStatus)
      const clientTs = optionalInteger(record.clientTs, 'clientTs')
      return { type, pairStatus, ...(clientTs === undefined ? {} : { clientTs }) }
    }
    case 'data':
      return { type, payload: record.payload }
    case 'error': {
      const code = requireString(record.code, 'code') as RelayErrorCode
      if (!RELAY_ERROR_CODES.includes(code)) {
        throw new ProtocolError('invalid-message', `unknown relay error code ${code}`)
      }
      const message = optionalString(record.message, 'message')
      return { type, code, ...(message === undefined ? {} : { message }) }
    }
    case 'ping':
    case 'pong':
      return { type, ts: requireInteger(record.ts, 'ts') }
    case 'kicked': {
      const reason = requireString(record.reason, 'reason')
      if (reason !== 'replaced' && reason !== 'revoked') {
        throw new ProtocolError('invalid-message', `unknown kicked reason ${reason}`)
      }
      return { type, reason }
    }
    default:
      throw new ProtocolError('unknown-message', `unknown control message type ${type}`)
  }
}

/** Whether a peer speaks the protocol revision this build implements. */
export function isCompatibleProtocol(protocolVersion: number): boolean {
  return protocolVersion === PROTOCOL_VERSION
}

function requirePairStatus(value: unknown): PairStatus {
  const status = requireString(value, 'pairStatus') as PairStatus
  if (!PAIR_STATUS.includes(status)) {
    throw new ProtocolError('invalid-message', `unknown pair status ${status}`)
  }
  return status
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, name, true)
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined
  return requireInteger(value, name)
}
