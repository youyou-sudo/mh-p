import { eden, unwrap } from "./api"
import { createStore, useStore } from "./store"

export interface HealthReport {
  panel: string
  sqlite: "ok" | "error"
  schemaVersion: number
  engine: {
    mode: string
    status: string
    pid: number | null
    version: string | null
    /** REST /version 是否可达 */
    rest: "ok" | "unreachable"
    apiLatencyMs: number
    slotUsed: number
    slotCapacity: number
    providerCount: number
    proxyCount: number
    uptimeSec: number
    restarts: number
    lastPublishAt: number | null
    reloadNeeded: boolean
  }
  gateway: { listen: string; enabled: boolean; activeConns: number; authFailures5m: number; banned: number }
  ports: { pool: number; used: number; cooling: number; bindable: { port: number; ok: boolean }[] }
  checks: { id: string; label: string; ok: boolean; detail: string; level: "ok" | "degraded" | "error" }[]
  overall: "ok" | "degraded"
}

const healthStore = createStore<HealthReport | null>(null)
const healthAtStore = createStore<number>(0)

let healthPromise: Promise<HealthReport | null> | null = null

export function refreshHealth(force = false): Promise<HealthReport | null> {
  if (healthPromise && !force) return healthPromise
  const stale = Date.now() - healthAtStore.get() > 8_000
  if (!force && !stale) return Promise.resolve(healthStore.get())
  healthPromise = unwrap(eden.api.health.get())
    .then((h) => {
      healthStore.set(h)
      healthAtStore.set(Date.now())
      return h
    })
    .catch(() => healthStore.get())
    .finally(() => {
      healthPromise = null
    })
  return healthPromise
}

export function useHealth(): HealthReport | null {
  return useStore(healthStore)
}

let healthTimer: ReturnType<typeof setInterval> | null = null

export function startHealthLoop(intervalMs = 60_000): () => void {
  if (healthTimer) clearInterval(healthTimer)
  void refreshHealth()
  healthTimer = setInterval(() => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return
    void refreshHealth()
  }, intervalMs)
  return () => {
    if (healthTimer) clearInterval(healthTimer)
    healthTimer = null
  }
}
