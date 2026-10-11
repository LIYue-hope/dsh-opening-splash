/* Authenticated account integration and the plugin's Settings tab, registered in
   DSH's lazy client loader. */
window.__ModuleLoader__.load({
  id: 'dsh-opening-splash',
  factory: (require) => {
    /* ------------------------- settings tab (shell) ------------------------- */

    /**
     * Dictionary namespace and Settings navigation id owned by this plugin.
     *
     * `settings.section` is the slot the settings shell projects into its
     * left-hand navigation column, so registering there is what puts a tab in
     * that column. The id doubles as the shell's icon key: an id it does not
     * know draws its default gear, which is what this page wants.
     */
    const SETTINGS_NS = 'openingSplash.settings'
    const SETTINGS_SECTION_ID = 'opening-splash'
    /* Ordered after the built-in sections: account -10, general 0, models 10, plugins 15. */
    const SETTINGS_SECTION_ORDER = 20

    /*
     * React arrives through the loader's own module table, which only the factory
     * can read. Resolving it here, once, is what keeps the page a plain-JS file
     * with no bundle: an element is created by hand instead of through JSX.
     */
    let react = null
    try {
      react = require('react')
    } catch (error) { /* No React in this module table. */ }

    /*
     * The shared `Switch` is what makes these toggles look like every other
     * switch in Settings. It is optional: without it the page falls back to a
     * native checkbox, so a composition that ships no primitives still gets a
     * usable page instead of a blank one.
     */
    let Switch = null
    try {
      Switch = require('@deepseek-ai/dsh-client-ui-primitives').Switch
    } catch (error) { /* No primitives in this module table. */ }

    /** Create one element, or nothing when React is unreachable. */
    function element(type, props, children) {
      if (react === null) return null
      const args = [type, props]
      if (children !== undefined) args.push(children)
      return react.createElement(...args)
    }

    /** Create an element with several children. */
    function elementWith(type, props, children) {
      if (react === null) return null
      return react.createElement(type, props, ...children.filter((child) => child !== null))
    }

    /* ------------------------- the user's own switches ------------------------ */

    /*
     * Where the switches live. This page owns the write and assets/opening.js
     * owns the read -- that half runs at boot, before this one is even
     * materialized, and it has to see a saved switch on the very next load.
     * localStorage is the one store both halves reach synchronously.
     *
     * They are browser-local on purpose: they are presentation preferences for
     * one person's screen, not deployment configuration. The profile's config
     * block stays what a deployment sets, and the two are merged at boot.
     *
     * Key and field names are a contract with assets/opening.js -- keep in step.
     */
    const PREFS_KEY = 'dsh-opening-splash:settings'
    const PREF_DEFAULTS = Object.freeze({
      skipOnDoubleClick: false,
      /* false = show the account name after `ID CONFIRMED :`. */
      defaultName: false,
      /* Not implemented yet: the picker is inert, and this stays false. */
      customSplash: false,
    })

    /** Read the stored switches, with every failure answering "defaults". */
    function readPrefs() {
      const stored = {}
      try {
        const raw = window.localStorage.getItem(PREFS_KEY)
        const parsed = raw ? JSON.parse(raw) : null
        if (parsed && typeof parsed === 'object') {
          for (const key of Object.keys(PREF_DEFAULTS)) {
            if (typeof parsed[key] === 'boolean') stored[key] = parsed[key]
          }
        }
      } catch (error) { /* No storage, or junk in it: the defaults stand. */ }
      return { ...PREF_DEFAULTS, ...stored }
    }

    /**
     * Store one switch and hand the whole set to the running page.
     *
     * Writing first, then pushing, means the page gets exactly what a reload
     * would read -- and the push is what makes a switch land now instead of on
     * the next page load.
     */
    function writePref(prefs, key, value) {
      const next = { ...prefs, [key]: value }
      try {
        window.localStorage.setItem(PREFS_KEY, JSON.stringify(next))
      } catch (error) { /* Storage blocked: the choice holds for this page only. */ }
      try {
        if (window.DSHOpening && typeof window.DSHOpening.setPrefs === 'function') {
          window.DSHOpening.setPrefs(next)
        }
      } catch (error) { /* The loader is not up yet: the next load reads the store. */ }
      return next
    }

    /** One labelled row with a switch on its right. */
    function prefRow(t, key, checked, onChange) {
      const label = t(key + '.label')
      const control = Switch
        ? element(Switch, { checked, onChange, label })
        /* Without the shared switch, a native one keeps the row operable. Its
           event carries the state the click asked for, which is what the caller
           wants -- the same boolean the shared control hands over. */
        : element('input', {
          type: 'checkbox',
          checked,
          'aria-label': label,
          onChange: (event) => onChange(Boolean(event && event.target && event.target.checked)),
        })
      return elementWith('div', { key }, [
        elementWith('div', { style: { minWidth: '0' } }, [
          element('div', { style: { fontSize: '14px', lineHeight: '22px' } }, label),
          element('div', {
            style: { marginTop: '4px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
          }, t(key + '.hint')),
        ]),
        control,
      ])
    }

    /**
     * The picker for a self-supplied opening animation.
     *
     * Deliberately inert: the option is here so the shape of the feature is
     * visible, but nothing is stored, uploaded or played yet. It renders as a
     * disabled control rather than a live one that quietly does nothing.
     */
    function customSplashRow(t) {
      const input = element('input', {
        type: 'file',
        accept: 'video/*,.html,.gif',
        disabled: true,
        'aria-label': t('customSplash.aria'),
        style: { maxWidth: '240px', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      })
      return elementWith('div', { key: 'customSplash', style: { opacity: '.72' } }, [
        elementWith('div', { style: { minWidth: '0' } }, [
          elementWith('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, [
            element('div', { style: { fontSize: '14px', lineHeight: '22px' } }, t('customSplash.label')),
            element('span', {
              style: {
                padding: '1px 6px',
                border: '1px solid var(--dsw-alias-border-l2)',
                borderRadius: '4px',
                fontSize: '11px',
                lineHeight: '16px',
                color: 'var(--dsw-alias-label-secondary)',
              },
            }, t('customSplash.badge')),
          ]),
          element('div', {
            style: { marginTop: '4px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
          }, t('customSplash.hint')),
        ]),
        input,
      ])
    }

    /**
     * Render the tab's body: the switches this plugin actually honours, plus the
     * placeholder for the one it does not implement yet.
     *
     * @param props - composed slot props: the locale `t` seat, plus `close` from the shell.
     * @returns the section element tree, or `null` when React is unreachable.
     */
    function OpeningSplashSection(props) {
      const t = props && typeof props.t === 'function' ? props.t : null
      if (react === null || t === null) return null
      const [prefs, setPrefs] = react.useState(readPrefs)
      const set = (key) => (value) => setPrefs(writePref(prefs, key, value))
      return elementWith('div', {
        style: { display: 'flex', flexDirection: 'column' },
      }, [
        prefRow(t, 'skipOnDoubleClick', prefs.skipOnDoubleClick, set('skipOnDoubleClick')),
        prefRow(t, 'defaultName', prefs.defaultName, set('defaultName')),
        customSplashRow(t),
      ])
    }

    return {
      inject: ['remote', 'remote.account', 'locale', 'slots'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('openingSplash', {
          en: { signedIn: 'Signed in' },
          zh: { signedIn: '\u5df2\u767b\u5f55' },
        }))
        ctx.effect(() => ctx.locale.register(SETTINGS_NS, {
          en: {
            nav: 'Opening splash',
            skipOnDoubleClick: {
              label: 'Double click to skip',
              hint: 'A double click anywhere ends the opening with a ripple reveal instead of the plain fade.',
            },
            defaultName: {
              label: 'Restore the default name',
              hint: 'Show DEEPSEEK after ID CONFIRMED, instead of the signed-in account name.',
            },
            customSplash: {
              label: 'Use my own opening animation',
              hint: 'Pick a video, an HTML file or a GIF to play instead of the built-in opening.',
              badge: 'Not yet available',
              aria: 'Choose an opening animation file',
            },
          },
          zh: {
            nav: '\u5f00\u573a\u52a8\u753b',
            skipOnDoubleClick: {
              label: '\u53cc\u51fb\u8df3\u8fc7',
              hint: '\u5728\u4efb\u610f\u4f4d\u7f6e\u53cc\u51fb\u53ef\u7ed3\u675f\u5f00\u573a\uff0c\u5e76\u4ee5\u6c34\u6ce2\u6d9f\u6f2a\u8fc7\u6e21\u5230\u754c\u9762\uff0c\u800c\u4e0d\u662f\u76f4\u63a5\u6de1\u51fa\u3002',
            },
            defaultName: {
              label: '\u6062\u590d\u9ed8\u8ba4\u540d\u5b57',
              hint: 'ID CONFIRMED \u540e\u663e\u793a DEEPSEEK\uff0c\u800c\u4e0d\u662f\u5f53\u524d\u767b\u5f55\u8d26\u53f7\u540d\u3002',
            },
            customSplash: {
              label: '\u4f7f\u7528\u81ea\u5b9a\u4e49\u5f00\u5c4f\u52a8\u753b',
              hint: '\u9009\u62e9\u4e00\u4e2a\u89c6\u9891\u3001HTML \u6216 GIF \u4ee3\u66ff\u5185\u7f6e\u5f00\u573a\u52a8\u753b\u3002',
              badge: '\u5c1a\u672a\u5f00\u653e',
              aria: '\u9009\u62e9\u5f00\u5c4f\u52a8\u753b\u6587\u4ef6',
            },
          },
        }))
        const t = ctx.locale.bind('openingSplash')
        let revision = 0
        let disposed = false
        /*
         * One name, one place. When the loader is up it owns the label -- it is
         * the half that knows whether the "restore the default name" switch is
         * on -- and publishing through it is what keeps a late profile result
         * from re-appearing after the switch withdrew it. The direct write only
         * covers the window before the loader exists.
         */
        function publish(label) {
          if (window.DSHOpening && typeof window.DSHOpening.setIdentity === 'function') {
            window.DSHOpening.setIdentity(label)
            return
          }
          window.__DSH_OPENING_IDENTITY__ = label
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
        /*
         * The tab is registered last, and its failure is contained, because
         * neither may keep the account integration above from running: the splash
         * and the name inside it are this plugin's job, the tab is an extra.
         * `inject: ['slots']` already withholds the whole plugin from a host
         * without the slot service, and `slots.inject` is declaration-aware, so
         * it waits for a settings shell that declares `settings.section` later,
         * however load order falls.
         */
        try {
          ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: SETTINGS_SECTION_ID,
            order: SETTINGS_SECTION_ORDER,
            /* A thunk, so the nav label follows a language change. */
            label: () => ctx.locale.bind(SETTINGS_NS)('nav'),
            locale: SETTINGS_NS,
          }, OpeningSplashSection)))
        } catch (error) { /* No settings shell in this composition. */ }
      },
    }
  },
})
