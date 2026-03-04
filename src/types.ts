/**
 * cc-dice type definitions
 *
 * All interfaces and types for the dice trigger system.
 */

export interface DiceSlotConfig {
  name: string;                          // unique slot identifier
  die: number;                           // die size (20 for d20, 6 for d6, etc.)
  target: number;                        // trigger value
  targetMode: "exact" | "gte" | "lte";   // how to check (default 'exact')

  // Dice type
  type: "accumulator" | "fixed" | "single";

  // Accumulator config
  accumulationRate: number;              // turns per +1 die (default 7)
  maxDice: number;                       // cap on dice (default: 100)

  // Fixed config
  fixedCount: number;                    // always roll N dice (default 1)

  // Behavior
  cooldown: "per-session" | "none";      // default 'per-session'
  clearOnSessionStart: boolean;          // default true
  resetOnTrigger: boolean;               // default true - auto-reset accumulator on trigger

  // Hook output
  flavor: boolean;                       // default true - prepend dice emoji + roll lingo
  onTrigger: {
    message: string;                     // stderr message shown to Claude on trigger
  };
}

export interface DiceState {
  depth_at_last_trigger: number;
  last_reset: string;                    // ISO timestamp
}

export interface CheckContext {
  transcriptPath?: string;
  sessionId?: string;
}

export interface DiceResult {
  triggered: boolean;
  rolls: number[];
  best: number;
  triggerValue?: number;                 // the specific roll that matched the target
  diceCount: number;
  probability: number;                   // chance as 0-100
  slotName: string;
}

export interface SlotStatus {
  name: string;
  type: string;
  diceCount: number;
  currentDepth: number;
  depthSinceTrigger: number;
  probability: number;
  nextDiceAt: number;
  sessionId?: string;
}
