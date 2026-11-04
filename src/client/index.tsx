/**
 * Browser half of the dsh-web-remote plugin: a console inside the DSH web GUI.
 *
 * Injected by the client-modules loader (`dsh.client.platform === 'web'`).
 * It adds one entry beside the sidebar settings trigger and renders a floating
 * panel that drives the Host half's `/api/web-remote/*` routes: relay setup,
 * the pairing QR, and paired-device management. The phone itself keeps using
 * the dedicated mobile shell hosted by the relay.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { QRCodeSVG } from 'qrcode.react'
import {
  createConsolePairing,
  describeApiError,
  fetchConsoleDevices,
  fetchConsoleStatus,
  restartConnection,
  revokeConsoleDevice,
  setupRelay,
  startLocalRelay,
} from './api.ts'
import type { ConsoleDevice, ConsolePairing, ConsoleStatus } from './api.ts'

/** Cordis services this client face needs. */
export const inject = ['slots']

/** Structural slice of the client root context this plugin touches. */
interface ConsoleContext {
  slots: {
    inject(key: string, callback: () => () => void): () => void
    register(
      options: { name: string; id: string; order?: number },
      component: (props: ConsoleEntryProps) => ReactNode,
    ): () => void
  }
}

/** Props the sidebar footer seat passes to its actions. */
interface ConsoleEntryProps {
  /** Whether the sidebar renders wide content (false = narrow rail). */
  wide?: boolean
}

/**
 * Register the console entry beside the sidebar settings trigger.
 * @param ctx - client root context.
 */
export function apply(ctx: ConsoleContext): void {
  ctx.slots.inject('sidebar.footer.action', () => {
    try {
      return ctx.slots.register(
        { name: 'sidebar.footer.action', id: 'web-remote-console', order: 100 },
        ConsoleEntry,
      )
    } catch {
      // A colliding registration must not break the shell; the entry is
      // re-declared on the next injection epoch if the collision goes away.
      return () => undefined
    }
  })
}

function ConsoleEntry(_props: ConsoleEntryProps): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        title="手机远程"
        aria-label="手机远程"
        onClick={() => setOpen(true)}
        style={entryButtonStyle}
      >
        📱
      </button>
      {open ? <ConsolePanel onClose={() => setOpen(false)} /> : null}
    </>
  )
}

const STATE_LABELS: Record<string, string> = {
  unconfigured: '未配置',
  idle: '空闲',
  connecting: '连接中',
  online: '在线',
  offline: '离线',
  stopped: '已停止',
}

function ConsolePanel(props: { onClose: () => void }): ReactNode {
  const [status, setStatus] = useState<ConsoleStatus | undefined>(undefined)
  const [loadError, setLoadError] = useState<string | undefined>(undefined)

  const refreshStatus = useCallback(async (): Promise<void> => {
    try {
      setStatus(await fetchConsoleStatus())
      setLoadError(undefined)
    } catch (error) {
      setLoadError(describeApiError(error))
    }
  }, [])

  const restart = useCallback(async (): Promise<void> => {
    try {
      await restartConnection()
    } catch (error) {
      setLoadError(describeApiError(error))
    }
    await refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  return createPortal(
    <div style={backdropStyle} onClick={props.onClose}>
      <div style={panelStyle} onClick={(event) => event.stopPropagation()}>
        <div style={headerStyle}>
          <strong>手机远程</strong>
          <button type="button" style={ghostButtonStyle} onClick={props.onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        {loadError !== undefined ? <p style={errorStyle}>{loadError}</p> : null}
        {status === undefined && loadError === undefined ? <p style={mutedStyle}>读取中…</p> : null}
        {status !== undefined ? (
          <>
            <StatusCard status={status} onRefresh={() => void refreshStatus()} onRestart={() => void restart()} />
            <SetupCard status={status} onConfigured={() => void refreshStatus()} />
            {status.configured ? <PairingCard /> : null}
            {status.configured ? <DevicesCard /> : null}
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}

function StatusCard(props: { status: ConsoleStatus; onRefresh: () => void; onRestart: () => void }): ReactNode {
  const state = props.status
  return (
    <section style={cardStyle}>
      <div style={cardTitleStyle}>
        <strong>连接状态</strong>
        <span style={stateLabelStyle(state.configured && state.state === 'online')}>
          {STATE_LABELS[state.state] ?? state.state}
        </span>
      </div>
      <div style={mutedStyle}>主机：{state.hostName}</div>
      {state.localRelay !== undefined ? (
        <div style={lanUrlBoxStyle}>
          <div style={mutedStyle}>手机连同一 Wi-Fi，打开这个地址即可使用：</div>
          <code style={lanUrlStyle}>{state.localRelay.lanUrl}</code>
        </div>
      ) : null}
      {state.localRelay === undefined && state.relayHttpUrl !== undefined ? (
        <div style={mutedStyle}>中继：{state.relayHttpUrl}</div>
      ) : null}
      {state.lastError !== undefined ? (
        <div style={errorStyle}>
          最近错误：{state.lastError.message ?? state.lastError.code}
        </div>
      ) : null}
      <div style={rowStyle}>
        <button type="button" style={ghostButtonStyle} onClick={props.onRefresh}>
          刷新状态
        </button>
        {state.configured && state.state !== 'online' ? (
          <button type="button" style={primaryButtonStyle} onClick={() => void props.onRestart()}>
            重新连接
          </button>
        ) : null}
      </div>
    </section>
  )
}

function SetupCard(props: { status: ConsoleStatus; onConfigured: () => void }): ReactNode {
  const [relayUrl, setRelayUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const submit = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    try {
      await setupRelay({
        relayHttpUrl: relayUrl,
        ...(token === '' ? {} : { registrationToken: token }),
      })
      setMessage('已连接，配置已保存')
      setToken('')
      props.onConfigured()
    } catch (caught) {
      setError(describeApiError(caught))
    } finally {
      setBusy(false)
    }
  }

  const useLocal = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    setMessage(undefined)
    try {
      const info = await startLocalRelay()
      setMessage(`已切换到局域网模式：${info.lanUrl}`)
      props.onConfigured()
    } catch (caught) {
      setError(describeApiError(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={cardStyle}>
      <strong>中继服务器</strong>
      {props.status.localRelay !== undefined ? (
        <div style={mutedStyle}>
          当前使用内置局域网中继，无需填写。要改用外部中继时在下方填写地址。
        </div>
      ) : null}
      <label style={labelStyle}>
        中继地址
        <input
          style={inputStyle}
          value={relayUrl}
          placeholder="https://relay.example.com"
          onChange={(event) => setRelayUrl(event.target.value)}
        />
      </label>
      <label style={labelStyle}>
        注册令牌{props.status.registrationTokenSet ? '（已设置）' : '（公网中继必填）'}
        <input
          style={inputStyle}
          type="password"
          value={token}
          placeholder="RELAY_REGISTRATION_TOKEN"
          onChange={(event) => setToken(event.target.value)}
        />
      </label>
      <div style={rowStyle}>
        <button type="button" style={primaryButtonStyle} disabled={busy || relayUrl.trim() === ''} onClick={() => void submit()}>
          {busy ? '连接中…' : '保存并连接'}
        </button>
        {props.status.localRelay === undefined ? (
          <button type="button" style={ghostButtonStyle} disabled={busy} onClick={() => void useLocal()}>
            使用局域网模式
          </button>
        ) : null}
      </div>
      {message !== undefined ? <div style={okStyle}>{message}</div> : null}
      {error !== undefined ? <div style={errorStyle}>{error}</div> : null}
    </section>
  )
}

function PairingCard(): ReactNode {
  const [pairing, setPairing] = useState<ConsolePairing | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const mint = useCallback(async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      setPairing(await createConsolePairing())
    } catch (caught) {
      setError(describeApiError(caught))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void mint()
  }, [mint])

  return (
    <section style={cardStyle}>
      <div style={cardTitleStyle}>
        <strong>配对手机</strong>
        {pairing !== undefined ? (
          <button type="button" style={ghostButtonStyle} disabled={busy} onClick={() => void mint()}>
            重新生成
          </button>
        ) : null}
      </div>
      {error !== undefined ? <div style={errorStyle}>{error}</div> : null}
      {pairing === undefined && error === undefined ? <div style={mutedStyle}>生成中…</div> : null}
      {pairing !== undefined ? (
        <>
          {pairing.url !== undefined ? (
            <div style={qrWrapStyle}>
              <QRCodeSVG value={pairing.url} size={168} includeMargin={false} />
            </div>
          ) : null}
          <div style={mutedStyle}>
            {pairing.url === undefined
              ? '未配置配对页地址：请在手机浏览器打开手机页并输入配对码。'
              : '用手机相机扫码，或把上面的局域网地址发给手机打开。'}
          </div>
          <div style={codeStyle}>
            配对码 <code>{pairingCodeGrouped(pairing.pairingCode)}</code>
          </div>
          <div style={mutedStyle}>有效期至 {new Date(pairing.expiresAt).toLocaleTimeString()}</div>
        </>
      ) : null}
    </section>
  )
}

function DevicesCard(): ReactNode {
  const [devices, setDevices] = useState<ConsoleDevice[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      setDevices(await fetchConsoleDevices())
      setError(undefined)
    } catch (caught) {
      setError(describeApiError(caught))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const revoke = async (deviceId: string): Promise<void> => {
    if (!window.confirm('撤销这台设备的访问？')) return
    try {
      await revokeConsoleDevice(deviceId)
      await refresh()
    } catch (caught) {
      setError(describeApiError(caught))
    }
  }

  return (
    <section style={cardStyle}>
      <div style={cardTitleStyle}>
        <strong>已配对设备</strong>
        <button type="button" style={ghostButtonStyle} onClick={() => void refresh()}>
          刷新
        </button>
      </div>
      {error !== undefined ? <div style={errorStyle}>{error}</div> : null}
      {devices !== undefined && devices.length === 0 ? <div style={mutedStyle}>还没有设备配对。</div> : null}
      {devices?.map((device) => (
        <div key={device.deviceId} style={deviceRowStyle}>
          <span style={deviceBadgeStyle(device.online)}>{device.online ? '在线' : '离线'}</span>
          <span style={deviceNameStyle}>
            {device.name ?? device.deviceId.slice(0, 12)}
            {device.platform !== undefined ? <span style={mutedStyle}> · {device.platform}</span> : null}
          </span>
          <button type="button" style={dangerButtonStyle} onClick={() => void revoke(device.deviceId)}>
            撤销
          </button>
        </div>
      ))}
    </section>
  )
}

/** Group the 8-digit display code as 4+4 for humans. */
function pairingCodeGrouped(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code
}

const entryButtonStyle = {
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  fontSize: '18px',
  lineHeight: 1,
  padding: '6px',
} as const

const backdropStyle = {
  position: 'fixed',
  inset: 0,
  zIndex: 10_000,
  background: 'rgba(0, 0, 0, 0.25)',
} as const

const panelStyle = {
  position: 'fixed',
  top: '16px',
  left: '72px',
  width: '348px',
  maxHeight: 'calc(100vh - 32px)',
  overflowY: 'auto',
  background: 'var(--dsh-surface, #fff)',
  color: 'var(--dsh-text, #111)',
  border: '1px solid rgba(0, 0, 0, 0.12)',
  borderRadius: '12px',
  boxShadow: '0 12px 32px rgba(0, 0, 0, 0.18)',
  padding: '14px',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  boxSizing: 'border-box',
} as const

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
} as const

const cardStyle = {
  border: '1px solid rgba(0, 0, 0, 0.08)',
  borderRadius: '10px',
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
} as const

const cardTitleStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
} as const

const labelStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  fontSize: '13px',
} as const

const inputStyle = {
  padding: '7px 9px',
  borderRadius: '8px',
  border: '1px solid rgba(0, 0, 0, 0.16)',
  font: 'inherit',
} as const

const primaryButtonStyle = {
  padding: '7px 12px',
  borderRadius: '8px',
  border: 'none',
  background: '#2563eb',
  color: '#fff',
  cursor: 'pointer',
  font: 'inherit',
} as const

const ghostButtonStyle = {
  padding: '4px 9px',
  borderRadius: '8px',
  border: '1px solid rgba(0, 0, 0, 0.14)',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
} as const

const dangerButtonStyle = {
  padding: '3px 8px',
  borderRadius: '8px',
  border: '1px solid rgba(220, 38, 38, 0.35)',
  background: 'transparent',
  color: '#dc2626',
  cursor: 'pointer',
  font: 'inherit',
} as const

const mutedStyle = {
  color: 'rgba(0, 0, 0, 0.55)',
  fontSize: '13px',
} as const

const errorStyle = {
  color: '#dc2626',
  fontSize: '13px',
} as const

const okStyle = {
  color: '#15803d',
  fontSize: '13px',
} as const

const codeStyle = {
  fontSize: '15px',
  letterSpacing: '1px',
} as const

const lanUrlBoxStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
  padding: '8px 10px',
  borderRadius: '8px',
  background: 'rgba(37, 99, 235, 0.08)',
} as const

const lanUrlStyle = {
  fontSize: '15px',
  wordBreak: 'break-all',
} as const

const rowStyle = {
  display: 'flex',
  gap: '8px',
  alignItems: 'center',
  flexWrap: 'wrap',
} as const

const qrWrapStyle = {
  display: 'flex',
  justifyContent: 'center',
  padding: '6px',
  background: '#fff',
  borderRadius: '8px',
  border: '1px solid rgba(0, 0, 0, 0.08)',
} as const

function stateLabelStyle(online: boolean): React.CSSProperties {
  return {
    fontSize: '12px',
    padding: '2px 8px',
    borderRadius: '999px',
    background: online ? 'rgba(21, 128, 61, 0.12)' : 'rgba(0, 0, 0, 0.08)',
    color: online ? '#15803d' : 'inherit',
  }
}

const deviceRowStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  fontSize: '13px',
} as const

const deviceNameStyle = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
} as const

function deviceBadgeStyle(online: boolean): React.CSSProperties {
  return {
    fontSize: '12px',
    padding: '1px 8px',
    borderRadius: '999px',
    flexShrink: 0,
    background: online ? 'rgba(21, 128, 61, 0.12)' : 'rgba(0, 0, 0, 0.08)',
    color: online ? '#15803d' : 'rgba(0, 0, 0, 0.55)',
  }
}
