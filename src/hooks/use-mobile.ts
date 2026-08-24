import * as React from "react"

const MOBILE_BREAKPOINT = 768

const query = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`

function subscribe(onChange: () => void) {
  const mql = window.matchMedia(query)
  mql.addEventListener("change", onChange)
  return () => mql.removeEventListener("change", onChange)
}

export function useIsMobile() {
  // useSyncExternalStore instead of the effect+setState shadcn template: the media
  // query IS an external store, and the effect version both double-rendered on mount
  // and tripped react-hooks/set-state-in-effect. Server snapshot is "not mobile" —
  // the same first paint the old undefined initial state produced.
  return React.useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false
  )
}
