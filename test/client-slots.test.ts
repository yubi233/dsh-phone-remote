import { describe, expect, it } from 'vitest'
import { apply } from '../src/client/index.tsx'

interface SlotRegistration {
  options: { name: string; id: string; order?: number; label?: string }
  component: unknown
}

type ConsoleContextLike = Parameters<typeof apply>[0]

/** Fake client root that records slot injections and registrations. */
function harness(): { ctx: ConsoleContextLike; injected: string[]; registered: SlotRegistration[] } {
  const injected: string[] = []
  const registered: SlotRegistration[] = []
  const ctx: ConsoleContextLike = {
    slots: {
      inject(key, callback) {
        injected.push(key)
        callback()
        return () => undefined
      },
      register(options, component) {
        registered.push({ options, component })
        return () => undefined
      },
    },
  }
  return { ctx, injected, registered }
}

describe('client console seats', () => {
  it('registers a settings page and a plugin detail section', () => {
    const { ctx, injected, registered } = harness()
    apply(ctx)

    expect(injected).toEqual(['settings.section', 'plugins.detail.section'])
    expect(registered).toHaveLength(2)

    const settings = registered.find((entry) => entry.options.name === 'settings.section')
    expect(settings?.options).toMatchObject({ id: 'web-remote', label: '手机远程' })
    expect(typeof settings?.component).toBe('function')

    const detail = registered.find((entry) => entry.options.name === 'plugins.detail.section')
    expect(detail?.options).toMatchObject({ id: 'web-remote' })
    expect(typeof detail?.component).toBe('function')
  })

  it('survives a duplicate registration without breaking the shell', () => {
    const { ctx } = harness()
    // The second activation of the same package collides; apply must not throw.
    ctx.slots.register = () => {
      throw new Error('duplicate slot registration')
    }
    expect(() => apply(ctx)).not.toThrow()
  })
})
