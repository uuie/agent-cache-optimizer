/** A fingerprint record for one hash observed at one position */
export interface BlockFingerprint {
  hash: string
  firstSeen: number
  lastSeen: number
  count: number
}

/** Content-addressed fingerprint — position-independent */
export interface ContentFingerprint {
  hash: string
  firstSeen: number
  lastSeen: number
  count: number
}

/** Stability database — persisted per-agent */
export interface StabilityDB {
  /** Position-based fingerprints (legacy, fallback) */
  positions: Record<number, BlockFingerprint[]>
  /** Position-based scores */
  scores: Record<string, number>
  /** Content-addressed fingerprints (primary) */
  contentIndex: Record<string, ContentFingerprint>
  /** Content-addressed scores */
  contentScores: Record<string, number>
  /** Number of calls that contributed to contentIndex */
  contentObservations: number
  /** Total observations */
  observations: number
  /** Last write timestamp */
  updated: number
}

/** Classification result */
export interface Classified {
  stable: string[]
  unknown: string[]
  dynamic: string[]
}

/** Options for the cache optimizer plugin */
export interface CacheOptimizerOptions {
  splitThreshold: number
  stateDir: string
  warmThreshold: number
}
