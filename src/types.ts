/** A fingerprint record for one hash observed at one position */
export interface BlockFingerprint {
  hash: string
  /** First time this exact hash was seen (epoch ms) */
  firstSeen: number
  /** Most recent time this hash was seen */
  lastSeen: number
  /** Total observations of this hash at this position */
  count: number
}

/** Stability database — persisted per-agent to track block stability over time */
export interface StabilityDB {
  /** Block position → fingerprints observed at that position */
  positions: Record<number, BlockFingerprint[]>
  /** Hash → stability score (1.0 = never changes, 0.0 = changes every call) */
  scores: Record<string, number>
  /** Total calls observed */
  observations: number
  /** Last write timestamp */
  updated: number
}

/** Classification result after scoring all blocks */
export interface Classified {
  stable: string[]
  unknown: string[]
  dynamic: string[]
}

/** Options for the cache optimizer plugin */
export interface CacheOptimizerOptions {
  /** Minimum block size in bytes to attempt splitting (default: 4000) */
  splitThreshold: number
  /** Path to store stability databases and logs */
  stateDir: string
  /** Minimum observations before switching from heuristics to hash-based scoring */
  warmThreshold: number
}
