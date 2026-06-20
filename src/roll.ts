/**
 * Core rolling mechanics
 *
 * Pure functions for dice rolling and target checking.
 * No state, no side effects.
 */

/**
 * Roll multiple dice of a given size.
 *
 * @param count - Number of dice to roll
 * @param dieSize - Number of sides on each die
 * @param rng - RNG returning a float in [0,1); defaults to Math.random. Injected
 *   by the core engine (via DiceHost.rng) for deterministic conformance tests (D2).
 * @returns Array of roll results (1 to dieSize inclusive)
 */
export function rollDice(count: number, dieSize: number, rng: () => number = Math.random): number[] {
  if (count <= 0 || dieSize <= 0) return [];
  return Array.from({ length: count }, () =>
    Math.floor(rng() * dieSize) + 1
  );
}

/**
 * Check if any roll matches the target according to the given mode.
 *
 * @param rolls - Array of roll results
 * @param target - Target value to check against
 * @param mode - Comparison mode: 'exact', 'gte', or 'lte'
 * @returns true if any roll matches
 */
export function checkTarget(
  rolls: number[],
  target: number,
  mode: "exact" | "gte" | "lte"
): boolean {
  if (rolls.length === 0) return false;
  switch (mode) {
    case "exact":
      return rolls.includes(target);
    case "gte":
      return rolls.some((r) => r >= target);
    case "lte":
      return rolls.some((r) => r <= target);
    default:
      return false;
  }
}

/**
 * Find the specific roll value that matched the target.
 *
 * For 'exact': the target value itself (if present).
 * For 'gte': the minimum qualifying roll (closest to the threshold).
 * For 'lte': the maximum qualifying roll (closest to the threshold).
 *
 * Returns undefined if no roll matches.
 */
export function findTriggerValue(
  rolls: number[],
  target: number,
  mode: "exact" | "gte" | "lte"
): number | undefined {
  if (rolls.length === 0) return undefined;
  switch (mode) {
    case "exact":
      return rolls.includes(target) ? target : undefined;
    case "gte": {
      const qualifying = rolls.filter((r) => r >= target);
      return qualifying.length > 0 ? Math.min(...qualifying) : undefined;
    }
    case "lte": {
      const qualifying = rolls.filter((r) => r <= target);
      return qualifying.length > 0 ? Math.max(...qualifying) : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Calculate the probability of triggering as a percentage (0-100).
 *
 * For 'exact' mode with 1 target value:
 *   P(at least one hit) = 1 - ((dieSize - 1) / dieSize)^count
 *
 * For 'gte' mode:
 *   P(single miss) = (target - 1) / dieSize
 *   P(at least one hit) = 1 - P(single miss)^count
 *
 * For 'lte' mode:
 *   P(single miss) = (dieSize - target) / dieSize
 *   P(at least one hit) = 1 - P(single miss)^count
 */
export function calculateProbability(
  count: number,
  dieSize: number,
  target: number,
  mode: "exact" | "gte" | "lte"
): number {
  if (count <= 0 || dieSize <= 0) return 0;

  let pMiss: number;
  switch (mode) {
    case "exact":
      pMiss = (dieSize - 1) / dieSize;
      break;
    case "gte":
      pMiss = (target - 1) / dieSize;
      break;
    case "lte":
      pMiss = (dieSize - target) / dieSize;
      break;
    default:
      return 0;
  }

  const pAllMiss = Math.pow(pMiss, count);
  return Math.round((1 - pAllMiss) * 10000) / 100; // round to 2 decimal places
}
