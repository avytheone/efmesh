/** Local integrations may be skipped; CI must never turn missing services green. */
export const requireIntegrationInCi = (dependency: string, available: boolean): void => {
  if (process.env.CI && !available) {
    throw new Error(`CI requires ${dependency}; install/start it before running integration tests`)
  }
}
