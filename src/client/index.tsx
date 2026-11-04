/**
 * Browser half of the dsh-web-remote plugin: the remote-access console inside
 * the DSH web GUI.
 *
 * Injected by the client-modules loader (`dsh.client.platform === 'web'`).
 * It contributes two seats and shares one console body between them:
 *
 * - `settings.section` — a full page in Settings (nav label 「手机远程」) where
 *   a pairing QR is minted automatically;
 * - `plugins.detail.section` — a section on this package's own Plugins detail
 *   page, so a freshly installed plugin can be inspected and paired in place
 *   (the code is minted on request there; two page instances must not mint
 *   competing pairings).
 *
 * Both drive the Host half's `/api/web-remote/*` routes. The phone itself keeps
 * using the dedicated mobile shell served by the relay.
 */

import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
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

/** Options a list-slot register call accepts here. */
interface SlotRegisterOptions {
  /** SlotMap key, for example `settings.section`. */
  name: string
  /** Cell key of this contribution. */
  id: string
  /** Position among the entries, ascending. */
  order?: number
  /** Display text where the owner projects one (settings nav). */
  label?: string
}

/**
 * A registered component. The shell supplies the real owner props at render
 * time; this client face declares them per component and only needs the
 * register call to accept it, hence the `never` parameter.
 */
type SlotComponent = (props: never) => ReactNode

/** Structural slice of the client root context this plugin touches. */
interface ConsoleContext {
  slots: {
    inject(key: string, callback: () => () => void): () => void
    register(options: SlotRegisterOptions, component: SlotComponent): () => void
  }
}

/** Props the settings section owner passes down. */
interface SettingsSectionProps {
  /** Close the settings panel (the shell owns the open state). */
  close: () => void
}

/** Structural slice of the plugins detail subject this section inspects. */
interface PluginsSubjectLike {
  kind?: string
  pkg?: { name?: string }
}

/** Props the plugins detail page passes to every section. */
interface PluginDetailSectionProps {
  /** The subject of the open detail page. */
  subject: PluginsSubjectLike
}

/**
 * Register the console seats: one settings page and one section on this
 * package's Plugins detail page.
 * @param ctx - client root context.
 */
export function apply(ctx: ConsoleContext): void {
  ctx.slots.inject('settings.section', () =>
    registerTolerant(ctx, { name: 'settings.section', id: 'web-remote', order: 50, label: '手机远程' }, SettingsPage),
  )
  ctx.slots.inject('plugins.detail.section', () =>
    registerTolerant(ctx, { name: 'plugins.detail.section', id: 'web-remote', order: 50 }, PluginDetailSection),
  )
}

/**
 * Register one seat without letting a collision (double activation, hot
 * reload) break the shell. The entry is re-declared on the next injection
 * epoch if the collision goes away.
 */
function registerTolerant(ctx: ConsoleContext, options: SlotRegisterOptions, component: SlotComponent): () => void {
  try {
    return ctx.slots.register(options, component)
  } catch {
    return () => undefined
  }
}

function SettingsPage(_props: SettingsSectionProps): ReactNode {
  return (
    <div style={pageStyle}>
      <header style={pageHeaderStyle}>
        <h2 style={pageTitleStyle}>手机远程</h2>
        <p style={mutedStyle}>
          手机与这台电脑连上同一个网络后，用手机打开下面的局域网地址，或扫描二维码配对即可继续会话。
        </p>
      </header>
      <ConsoleBody autoMint />
    </div>
  )
}

function PluginDetailSection(props: PluginDetailSectionProps): ReactNode {
  if (!isOwnSubject(props.subject)) return null
  return (
    <section style={detailSectionStyle} aria-label="手机远程">
      <div style={sectionHeadStyle}>
        <h3 style={detailTitleStyle}>手机远程</h3>
        <span style={mutedStyle}>dsh-phone-remote</span>
      </div>
      <p style={mutedStyle}>
        安装后即可配对手机。设置 → 手机远程 是同一份控制的完整页面；这里也可以直接生成配对码。
      </p>
      <ConsoleBody autoMint={false} />
    </section>
  )
}

/** Whether a Plugins detail page is showing this package. */
function isOwnSubject(subject: PluginsSubjectLike | undefined): boolean {
  return subject?.pkg?.name === 'dsh-phone-remote'
}

function ConsoleBody(props: { autoMint: boolean }): ReactNode {
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

  return (
    <div style={bodyStyle}>
      {loadError !== undefined ? <p style={errorStyle}>{loadError}</p> : null}
      {status === undefined && loadError === undefined ? <p style={mutedStyle}>读取中…</p> : null}
      {status !== undefined ? (
        <>
          <StatusCard status={status} onRefresh={() => void refreshStatus()} onRestart={() => void restart()} />
          <SetupCard status={status} onConfigured={() => void refreshStatus()} />
          {status.configured ? <PairingCard autoMint={props.autoMint} /> : null}
          {status.configured ? <DevicesCard /> : null}
        </>
      ) : null}
    </div>
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
        <div style={errorStyle}>最近错误：{state.lastError.message ?? state.lastError.code}</div>
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
        <div style={mutedStyle}>当前使用内置局域网中继，无需填写。要改用外部中继时在下方填写地址。</div>
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
        <button
          type="button"
          style={primaryButtonStyle}
          disabled={busy || relayUrl.trim() === ''}
          onClick={() => void submit()}
        >
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

function PairingCard(props: { autoMint: boolean }): ReactNode {
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
    if (props.autoMint) void mint()
  }, [mint, props.autoMint])

  const showMintButton = pairing !== undefined || error !== undefined || !props.autoMint
  return (
    <section style={cardStyle}>
      <div style={cardTitleStyle}>
        <strong>配对手机</strong>
        {showMintButton ? (
          <button type="button" style={ghostButtonStyle} disabled={busy} onClick={() => void mint()}>
            {pairing === undefined ? '生成配对码' : '重新生成'}
          </button>
        ) : null}
      </div>
      {error !== undefined ? <div style={errorStyle}>{error}</div> : null}
      {pairing === undefined && error === undefined && props.autoMint ? <div style={mutedStyle}>生成中…</div> : null}
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

// Styles use the shell's design aliases so both light and dark themes work;
// the fallbacks keep the console readable in a bare React harness.
const pageStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  maxWidth: '560px',
  color: 'var(--dsw-alias-label-primary, #111)',
} as const

const pageHeaderStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
} as const

const pageTitleStyle = {
  margin: 0,
  fontSize: '17px',
  fontWeight: 600,
  lineHeight: 1.4,
} as const

const bodyStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
} as const

const detailSectionStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  color: 'var(--dsw-alias-label-primary, #111)',
} as const

const sectionHeadStyle = {
  display: 'flex',
  alignItems: 'baseline',
  gap: '10px',
} as const

const detailTitleStyle = {
  margin: 0,
  fontSize: '15px',
  fontWeight: 600,
  lineHeight: 1.4,
} as const

const cardStyle = {
  border: '1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12))',
  borderRadius: 'var(--dsw-radius-md, 12px)',
  background: 'var(--dsw-alias-settings-card-fill, rgba(127, 127, 127, 0.04))',
  padding: '12px 14px',
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
  borderRadius: 'var(--dsw-radius-sm, 8px)',
  border: '1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.16))',
  background: 'var(--dsw-alias-bg-layer-1, #fff)',
  color: 'inherit',
  font: 'inherit',
} as const

const primaryButtonStyle = {
  padding: '7px 12px',
  borderRadius: 'var(--dsw-radius-sm, 8px)',
  border: 'none',
  background: 'var(--dsw-alias-button-primary-fill, #2563eb)',
  color: 'var(--dsw-alias-label-primary-foreground, #fff)',
  cursor: 'pointer',
  font: 'inherit',
} as const

const ghostButtonStyle = {
  padding: '4px 9px',
  borderRadius: 'var(--dsw-radius-sm, 8px)',
  border: '1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.14))',
  background: 'transparent',
  color: 'inherit',
  cursor: 'pointer',
  font: 'inherit',
} as const

const dangerButtonStyle = {
  padding: '3px 8px',
  borderRadius: 'var(--dsw-radius-sm, 8px)',
  border: '1px solid rgba(220, 38, 38, 0.35)',
  background: 'transparent',
  color: '#dc2626',
  cursor: 'pointer',
  font: 'inherit',
} as const

const mutedStyle = {
  margin: 0,
  color: 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.55))',
  fontSize: '13px',
  lineHeight: 1.5,
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
  borderRadius: 'var(--dsw-radius-sm, 8px)',
  background: 'var(--dsw-alias-bg-layer-1, rgba(37, 99, 235, 0.08))',
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
  borderRadius: 'var(--dsw-radius-sm, 8px)',
  border: '1px solid var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.08))',
} as const

function stateLabelStyle(online: boolean): React.CSSProperties {
  return {
    fontSize: '12px',
    padding: '2px 8px',
    borderRadius: '999px',
    background: online ? 'rgba(21, 128, 61, 0.12)' : 'rgba(127, 127, 127, 0.16)',
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
    background: online ? 'rgba(21, 128, 61, 0.12)' : 'rgba(127, 127, 127, 0.16)',
    color: online ? '#15803d' : 'var(--dsw-alias-label-secondary, rgba(0, 0, 0, 0.55))',
  }
}
