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
     * The uploaded animation itself does NOT live here: it is a Blob of tens of
     * megabytes, and localStorage holds strings of a few. It goes to the
     * database below, and only its description is kept here.
     *
     * Keys and field names are a contract with assets/opening.js -- keep in step.
     */
    const PREFS_KEY = 'dsh-opening-splash:settings'
    const PREF_DEFAULTS = Object.freeze({
      skipOnDoubleClick: false,
      /* false = show the account name after `ID CONFIRMED :`. */
      defaultName: false,
      /* true = play the uploaded animation instead of the built-in one. */
      customSplash: false,
    })

    /* The uploaded file's own store, and the shape of its description. */
    const DB_NAME = 'dsh-opening-splash'
    const DB_STORE = 'splash'
    const BLOB_KEY = 'custom'
    const META_KEY = 'dsh-opening-splash:upload'
    /*
     * A ceiling, not a target. The whole file is read into an IndexedDB record,
     * so the browser holds it twice while writing; past a few hundred megabytes
     * that is a tab crash rather than a failed upload.
     */
    const MAX_UPLOAD_BYTES = 200 * 1024 * 1024

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

    /* ------------------------- the uploaded animation ------------------------- */

    /**
     * Open the database that holds the uploaded file.
     *
     * Resolves to `null` when the browser has no IndexedDB, or refuses to open
     * one (private windows do): the page then reports that uploads are
     * unavailable instead of offering a picker that cannot keep anything.
     */
    function openDatabase() {
      return new Promise((resolve) => {
        let request
        try {
          const factory = window.indexedDB
          if (!factory || typeof factory.open !== 'function') { resolve(null); return }
          request = factory.open(DB_NAME, 1)
        } catch (error) { resolve(null); return }
        request.onupgradeneeded = () => {
          try {
            const db = request.result
            if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE)
          } catch (error) { /* the open error below reports it */ }
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
        request.onblocked = () => resolve(null)
      })
    }

    /** One transaction against the animation store, as a promise. */
    function withStore(mode, run) {
      return openDatabase().then((db) => {
        if (!db) throw new Error('storage-unavailable')
        return new Promise((resolve, reject) => {
          let request
          try {
            const tx = db.transaction(DB_STORE, mode)
            request = run(tx.objectStore(DB_STORE))
            tx.oncomplete = () => resolve(request ? request.result : undefined)
            tx.onerror = () => reject(tx.error || new Error('transaction-failed'))
            tx.onabort = () => reject(tx.error || new Error('transaction-aborted'))
          } catch (error) { reject(error) }
        })
      })
    }

    /** Whether this browser can keep an uploaded file at all. */
    function uploadsAvailable() {
      try {
        return Boolean(window.indexedDB && typeof window.indexedDB.open === 'function')
      } catch (error) { return false }
    }

    /** Read the stored upload's description, or `null`. */
    function readUploadMeta() {
      try {
        const raw = window.localStorage.getItem(META_KEY)
        const parsed = raw ? JSON.parse(raw) : null
        if (!parsed || typeof parsed !== 'object') return null
        if (typeof parsed.name !== 'string' || typeof parsed.size !== 'number') return null
        return { name: parsed.name, size: parsed.size, type: typeof parsed.type === 'string' ? parsed.type : '' }
      } catch (error) { return null }
    }

    /** How a file size reads to a person. */
    function formatSize(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return ''
      if (bytes < 1024) return bytes + ' B'
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
      return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
    }

    /**
     * Keep one chosen file and describe it.
     *
     * Returns the new description, or a `{ error }` the page renders. The file
     * is stored whole: the animation plays from a Blob URL, so nothing has to be
     * decoded by this half.
     */
    function saveUpload(file) {
      if (!file) return Promise.resolve({ error: 'customSplash.chooseFirst' })
      if (Number(file.size) > MAX_UPLOAD_BYTES) {
        return Promise.resolve({ error: 'customSplash.tooLarge', params: { max: formatSize(MAX_UPLOAD_BYTES) } })
      }
      if (Number(file.size) === 0) return Promise.resolve({ error: 'customSplash.empty' })
      return withStore('readwrite', (store) => store.put(file, BLOB_KEY)).then(() => {
        const meta = { name: String(file.name || 'animation'), size: Number(file.size) || 0, type: String(file.type || '') }
        try { window.localStorage.setItem(META_KEY, JSON.stringify(meta)) } catch (error) { /* the blob is what plays */ }
        return meta
      }).catch(() => ({ error: 'customSplash.storeFailed' }))
    }

    /** Forget the uploaded animation, both halves of it. */
    function clearUpload() {
      try { window.localStorage.removeItem(META_KEY) } catch (error) { /* ignore */ }
      return withStore('readwrite', (store) => store.delete(BLOB_KEY)).catch(() => undefined)
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

    /** A quiet line of helper copy under a row. */
    function hintLine(text, color) {
      return element('div', {
        style: {
          marginTop: '4px',
          fontSize: '12px',
          lineHeight: '18px',
          color: color || 'var(--dsw-alias-label-secondary)',
          overflowWrap: 'anywhere',
        },
      }, text)
    }

    /** A small bordered button, for the secondary actions in this page. */
    function smallButton(label, onClick, extra) {
      return element('button', {
        type: 'button',
        onClick,
        style: {
          padding: '2px 10px',
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: '4px',
          background: 'transparent',
          color: 'var(--dsw-alias-label-primary)',
          cursor: 'pointer',
          font: 'inherit',
          fontSize: '12px',
          lineHeight: '20px',
        },
        ...extra,
      }, label)
    }

    /**
     * The uploaded-animation row: pick a file, see what was kept, or drop it.
     *
     * The file itself goes to IndexedDB and only its description to
     * localStorage, so what this row renders is the description. Nothing here
     * decides whether the animation plays -- the switch above does, and the
     * loader half reads the same two stores at boot.
     */
    function customSplashRow(t, state) {
      const { meta, note, busy, enabled, available, onPick, onClear, onToggle } = state
      const rows = []

      /* What is currently kept, or what to do about it. */
      if (!available) {
        rows.push(hintLine(t('customSplash.unsupported')))
      } else if (meta) {
        rows.push(hintLine(t('customSplash.current', { name: meta.name, size: formatSize(meta.size) })))
      } else {
        rows.push(hintLine(t('customSplash.hint', { max: formatSize(MAX_UPLOAD_BYTES) })))
      }

      const actions = []
      actions.push(element('input', {
        key: 'picker',
        type: 'file',
        accept: 'video/*',
        disabled: busy || !available,
        'aria-label': t('customSplash.aria'),
        onChange: (event) => {
          const input = event && event.target
          const file = input && input.files && input.files[0]
          /* Clearing the value lets the same file be chosen again after a
             removal; a file input fires no change for the same name twice. */
          if (input) { try { input.value = '' } catch (error) { /* ignore */ } }
          onPick(file)
        },
        style: { maxWidth: '220px', color: 'var(--dsw-alias-label-secondary)', fontSize: '12px' },
      }))
      if (meta) actions.push(smallButton(t('customSplash.remove'), onClear, { key: 'remove' }))

      rows.push(elementWith('div', {
        key: 'actions',
        style: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '8px', flexWrap: 'wrap' },
      }, actions))

      /* The error line replaces the description rather than piling up under it. */
      if (note) {
        rows.push(hintLine(t(note.key, note.params), 'var(--dsw-alias-state-error-primary)'))
      }

      /* Turning it on without a file would silently play the built-in opening,
         so the switch says why it cannot move instead. */
      const toggle = Switch
        ? element(Switch, {
          checked: enabled,
          onChange: onToggle,
          disabled: !available || (!meta && !enabled),
          label: t('customSplash.toggleLabel'),
        })
        : element('input', {
          type: 'checkbox',
          checked: enabled,
          disabled: !available || (!meta && !enabled),
          'aria-label': t('customSplash.toggleLabel'),
          onChange: (event) => onToggle(Boolean(event && event.target && event.target.checked)),
        })

      return elementWith('div', { key: 'customSplash' }, [
        elementWith('div', {
          style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '24px' },
        }, [
          elementWith('div', { style: { minWidth: '0' } }, [
            element('div', { style: { fontSize: '14px', lineHeight: '22px' } }, t('customSplash.label')),
            ...rows,
          ]),
          toggle,
        ]),
      ])
    }

    /**
     * Render the tab's body: the switches this plugin honours, and the picker
     * for an animation the user supplies themselves.
     *
     * @param props - composed slot props: the locale `t` seat, plus `close` from the shell.
     * @returns the section element tree, or `null` when React is unreachable.
     */
    function OpeningSplashSection(props) {
      const t = props && typeof props.t === 'function' ? props.t : null
      if (react === null || t === null) return null
      const [prefs, setPrefs] = react.useState(readPrefs)
      const [upload, setUpload] = react.useState(() => ({
        meta: readUploadMeta(),
        note: null,
        busy: false,
        available: uploadsAvailable(),
      }))
      const set = (key) => (value) => setPrefs(writePref(prefs, key, value))

      const onPick = (file) => {
        setUpload({ ...upload, busy: true, note: null })
        Promise.resolve(saveUpload(file)).then((result) => {
          if (result && result.error) {
            setUpload({ meta: readUploadMeta(), note: { key: result.error, params: result.params }, busy: false, available: true })
            return
          }
          /* A file that saved is a file the user wants to see: turning the
             switch on here saves them a second click that does nothing visible. */
          setPrefs(writePref(prefs, 'customSplash', true))
          setUpload({ meta: result, note: null, busy: false, available: true })
        })
      }
      const onClear = () => {
        setUpload({ ...upload, busy: true })
        Promise.resolve(clearUpload()).then(() => {
          setPrefs(writePref(prefs, 'customSplash', false))
          setUpload({ meta: null, note: null, busy: false, available: true })
        })
      }
      const onToggle = (value) => {
        if (value && !upload.meta) {
          setUpload({ ...upload, note: { key: 'customSplash.chooseFirst' } })
          return
        }
        setPrefs(writePref(prefs, 'customSplash', value))
      }

      return elementWith('div', {
        style: { display: 'flex', flexDirection: 'column' },
      }, [
        prefRow(t, 'skipOnDoubleClick', prefs.skipOnDoubleClick, set('skipOnDoubleClick')),
        prefRow(t, 'defaultName', prefs.defaultName, set('defaultName')),
        customSplashRow(t, { ...upload, enabled: prefs.customSplash, onPick, onClear, onToggle }),
      ])
    }

    return {
      inject: ['remote', 'remote.account', 'locale', 'slots'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('openingSplash', {
          en: { signedIn: 'Signed in' },
          zh: { signedIn: '\u5df2\u767b\u5f55' },
        }))
        /*
         * The dictionaries are FLAT, with dotted keys. That is the locale
         * service's contract -- `lookup` reads `dict[key]` verbatim, so a nested
         * object answers `undefined` for every dotted key and the lookup falls
         * silently through the whole fallback chain to English. It shipped that
         * way once; the checks now register through the real translate path.
         */
        ctx.effect(() => ctx.locale.register(SETTINGS_NS, {
          en: {
            nav: 'Opening splash',
            'skipOnDoubleClick.label': 'Double click to skip',
            'skipOnDoubleClick.hint': 'A double click anywhere ends the opening with a ripple reveal instead of the plain fade.',
            'defaultName.label': 'Restore the default name',
            'defaultName.hint': 'Show DEEPSEEK after ID CONFIRMED, instead of the signed-in account name.',
            'customSplash.label': 'Use my own opening animation',
            'customSplash.hint': 'Choose a video file (MP4, WebM, MOV, GIF...). Up to {max}.',
            'customSplash.toggleLabel': 'Play my own opening animation',
            'customSplash.aria': 'Choose an opening animation file',
            'customSplash.current': 'Kept: {name} ({size}). It plays on the next page load.',
            'customSplash.remove': 'Remove',
            'customSplash.unsupported': 'This browser has no IndexedDB, so an uploaded file cannot be kept.',
            'customSplash.chooseFirst': 'Choose a video file first.',
            'customSplash.empty': 'That file is empty.',
            'customSplash.tooLarge': 'That file is larger than {max}.',
            'customSplash.storeFailed': 'The browser refused to store that file; it may be out of space.',
          },
          zh: {
            nav: '\u5f00\u573a\u52a8\u753b',
            'skipOnDoubleClick.label': '\u53cc\u51fb\u8df3\u8fc7',
            'skipOnDoubleClick.hint': '\u5728\u753b\u9762\u4efb\u610f\u4f4d\u7f6e\u53cc\u51fb\u5373\u53ef\u7ed3\u675f\u5f00\u573a\uff0c\u5e76\u4ee5\u6c34\u6ce2\u6d9f\u6f2a\u8fc7\u6e21\u5230\u754c\u9762\uff0c\u800c\u4e0d\u662f\u76f4\u63a5\u6de1\u51fa\u3002',
            'defaultName.label': '\u6062\u590d\u9ed8\u8ba4\u540d\u5b57',
            'defaultName.hint': 'ID CONFIRMED \u540e\u663e\u793a DEEPSEEK\uff0c\u800c\u4e0d\u662f\u5f53\u524d\u767b\u5f55\u8d26\u53f7\u540d\u3002',
            'customSplash.label': '\u4f7f\u7528\u81ea\u5b9a\u4e49\u5f00\u5c4f\u52a8\u753b',
            'customSplash.hint': '\u9009\u62e9\u4e00\u4e2a\u89c6\u9891\u6587\u4ef6\uff08MP4\u3001WebM\u3001MOV\u3001GIF \u7b49\uff09\uff0c\u4e0a\u9650 {max}\u3002',
            'customSplash.toggleLabel': '\u64ad\u653e\u6211\u4e0a\u4f20\u7684\u5f00\u5c4f\u52a8\u753b',
            'customSplash.aria': '\u9009\u62e9\u5f00\u5c4f\u52a8\u753b\u6587\u4ef6',
            'customSplash.current': '\u5df2\u4fdd\u5b58\uff1a{name}\uff08{size}\uff09\uff0c\u4e0b\u6b21\u6253\u5f00\u9875\u9762\u65f6\u64ad\u653e\u3002',
            'customSplash.remove': '\u79fb\u9664',
            'customSplash.unsupported': '\u5f53\u524d\u6d4f\u89c8\u5668\u4e0d\u652f\u6301 IndexedDB\uff0c\u65e0\u6cd5\u4fdd\u5b58\u4e0a\u4f20\u7684\u6587\u4ef6\u3002',
            'customSplash.chooseFirst': '\u8bf7\u5148\u9009\u62e9\u4e00\u4e2a\u89c6\u9891\u6587\u4ef6\u3002',
            'customSplash.empty': '\u8be5\u6587\u4ef6\u662f\u7a7a\u7684\u3002',
            'customSplash.tooLarge': '\u8be5\u6587\u4ef6\u8d85\u8fc7 {max}\u3002',
            'customSplash.storeFailed': '\u6d4f\u89c8\u5668\u62d2\u7edd\u4fdd\u5b58\u8be5\u6587\u4ef6\uff0c\u53ef\u80fd\u662f\u7a7a\u95f4\u4e0d\u8db3\u3002',
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
