/* Authenticated account integration, registered in DSH's lazy client loader. */
window.__ModuleLoader__.load({
  id: 'dsh-opening-splash',
  factory: () => ({
    inject: ['remote', 'remote.account', 'locale'],
    apply(ctx) {
      ctx.effect(() => ctx.locale.register('openingSplash', {
        en: { signedIn: 'Signed in' },
        zh: { signedIn: '\u5df2\u767b\u5f55' },
      }))
      const t = ctx.locale.bind('openingSplash')
      let revision = 0
      let disposed = false
      function publish(label) {
        window.__DSH_OPENING_IDENTITY__ = label
        if (window.DSHOpening) window.DSHOpening.setIdentity(label)
      }
      function unwrap(result) {
        if (result && typeof result.ok === 'boolean') {
          if (!result.ok) throw new Error('account profile unavailable')
          return result.value
        }
        return result
      }
      async function refresh(generation) {
        let label = t('signedIn')
        try {
          const result = unwrap(await ctx.remote.account.getProfile({
            version: '0.2.0-rc.2',
            locale: ctx.locale.getSnapshot().active,
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          }))
          if (result === null) label = null
          else if (result && result.status === 'ready') {
            label = result.value.name ?? result.value.contact ?? t('signedIn')
          }
        } catch (error) { /* Signed-in fallback; never delay the splash. */ }
        if (!disposed && generation === revision) publish(label)
      }
      const stream = ctx.remote.$stream({
        name: 'account',
        open: (signal) => ctx.remote.account.watch(signal),
        ended: () => new Error('account stream ended'),
      })
      publish(null)
      ctx.effect(() => {
        const clear = () => { revision++; publish(null) }
        const off = [
          ctx.remote.$on('deepseek-account/signed-out', clear),
          ctx.remote.$on('deepseek-account/session-expired', clear),
        ]
        return () => { for (const dispose of off) dispose() }
      })
      ctx.effect(() => () => {
        disposed = true
        revision++
        publish(null)
        return stream.dispose()
      })
      ;(async () => {
        for await (const frame of stream) {
          const generation = ++revision
          publish(null)
          const signedIn = frame.value.status === 'credential-stored'
          frame.accept()
          if (signedIn) void refresh(generation)
        }
      })().catch(() => {
        if (!disposed) { revision++; publish(null) }
      })
    },
  }),
})
