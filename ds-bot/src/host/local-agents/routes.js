// The local-agent route registration. DSH registers an adapter's providers
// all-or-nothing, so one id another plugin already owns would keep every local
// route out or take the whole team down; the taken ids are filtered out first
// and named once in the log, and the rest register as usual.
export function attachRoutes({ llm, adapter, log = () => {} }) {
  // A newer DSH resolves an injected service on property access and throws before the
  // plugin's context is active, so a function is read when routes are applied, not now.
  const service = typeof llm === 'function' ? llm : () => llm
  let handle
  let owned = new Set()
  let warned = ''
  const register = (routes) => {
    handle = service().registerAdapter(routes, adapter)
    owned = new Set(routes)
  }
  const replace = (routes) => {
    handle.replace(routes)
    owned = new Set(routes)
  }
  return {
    get routes() { return [...owned] },
    // Registers the free routes, or swaps to them when already registered.
    // Returns whether an adapter now serves at least one route.
    apply(wanted) {
      const current = service()
      if (current === undefined || typeof current.registerAdapter !== 'function') return false
      const list = [...new Set(wanted)]
      const taken = new Set((current.listProviders?.() ?? []).map(provider => provider.id).filter(id => !owned.has(id)))
      const skipped = list.filter(route => taken.has(route))
      const routes = list.filter(route => !taken.has(route))
      // One line per change, not one per scan.
      const key = skipped.slice().sort().join(',')
      if (key !== warned) {
        warned = key
        if (skipped.length > 0) log(`local agent route${skipped.length === 1 ? '' : 's'} ${skipped.join(', ')} already taken by another provider; skipped`)
      }
      try {
        if (handle === undefined) {
          if (routes.length === 0) return false
          register(routes)
        } else replace(routes)
        return owned.size > 0
      } catch (error) {
        // Without listProviders() the collision only shows here; skipping the
        // whole batch is still better than failing the team's start.
        log(`local agent routes could not register: ${error?.message ?? error}`)
        return owned.size > 0
      }
    },
    dispose() {
      handle?.()
      handle = undefined
      owned = new Set()
    },
  }
}
