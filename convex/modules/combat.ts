// Combat module — simple 1v1 turn-based combat, proves effect-router
// + flow runtime + seeded RNG composing end-to-end.
//
// Minimal for Wave 2: no equipment scaling, no initiative tie-break,
// no status effects. Rolls are seeded per-step so a replay produces
// the same sequence — required for AI caching + test determinism.
//
// State shape:
//   {
//     enemy_slug: string,
//     enemy_hp: number,
//     enemy_max_hp: number,
//     enemy_attack: number,      // base damage roll (1..attack)
//     player_weapon_attack: number, // base damage roll (1..attack)
//     round: number,
//     log: string[],             // last 5 lines for summary render
//     escape_dc: number,         // roll 1..10 must be <= for flee
//   }
//
// Entry: open → announce + initiative → player_turn.
// Player_turn: [attack | flee]. Attack rolls damage → enemy_turn.
//              Flee rolls escape; success → done, failure → enemy_turn.
// Enemy_turn: rolls damage on player via damage effect → back to
//             player_turn, OR if enemy_hp <= 0 → done (victory).
// Done: terminal with summary lines.

import type { ModuleDef } from "@weaver/engine/flows";

type CombatState = {
  // Optional: caller may describe enemy by slug, name, or both.
  enemy_slug?: string;
  enemy_name?: string;
  enemy_hp: number;
  enemy_max_hp: number;
  enemy_attack: number;
  player_weapon_attack: number;
  round: number;
  log: string[];
  escape_dc: number;
  outcome?: "victory" | "defeat" | "fled";
};

const DEFAULTS: Omit<CombatState, "enemy_slug"> = {
  enemy_hp: 10,
  enemy_max_hp: 10,
  enemy_attack: 3,
  player_weapon_attack: 4,
  round: 1,
  log: [],
  escape_dc: 5,
};

export const combatModule: ModuleDef<CombatState> = {
  name: "combat",
  schema_version: 1,
  entry: "open",
  manifest: {
    reads: ["entity:npc", "character.state.hp"],
    writes: ["character.state.hp"],
    emits: ["combat_start", "combat_end"],
  },
  steps: {
    open: async (ctx, state) => {
      const merged: CombatState = { ...DEFAULTS, ...(state as Partial<CombatState>) };
      const name = merged.enemy_name ?? merged.enemy_slug ?? "the enemy";
      ctx.say(`Combat begins. ${ctx.character.pseudonym} faces ${name}.`);
      return {
        next: "player_turn",
        state: {
          ...merged,
          log: [`Round ${merged.round}: ${name} stands ready.`],
        },
      };
    },

    player_turn: async (ctx, state, input) => {
      const s = state as CombatState;
      if (!input) {
        // First entry — show the menu.
        return {
          next: "player_turn",
          says: [
            `Round ${s.round}. ${s.enemy_name ?? s.enemy_slug} has ${s.enemy_hp}/${s.enemy_max_hp} hp.`,
            `You have ${ctx.character.state.hp ?? "?"} hp.`,
          ],
          ui: {
            prompt: `Attack or flee?`,
            choices: [
              { id: "attack", label: "Attack" },
              { id: "flee", label: "Flee" },
            ],
          },
        };
      }

      if (input.choice === "flee") {
        const roll = ctx.rng_int(1, 10);
        if (roll <= s.escape_dc) {
          return {
            next: "done",
            state: { ...s, outcome: "fled" },
            says: [
              `You roll ${roll} vs DC ${s.escape_dc}. You break away and run.`,
            ],
          };
        }
        return {
          next: "enemy_turn",
          state: {
            ...s,
            log: [...s.log, `You tried to flee (rolled ${roll}) — no luck.`],
          },
          says: [`You roll ${roll} vs DC ${s.escape_dc}. You stumble. The enemy presses.`],
        };
      }

      // Default: attack.
      const dmg = ctx.rng_int(1, s.player_weapon_attack);
      const newEnemyHp = Math.max(0, s.enemy_hp - dmg);
      const line = `${ctx.character.pseudonym} strikes for ${dmg} — ${s.enemy_name ?? s.enemy_slug}: ${newEnemyHp}/${s.enemy_max_hp}`;
      if (newEnemyHp <= 0) {
        return {
          next: "done",
          state: {
            ...s,
            enemy_hp: 0,
            outcome: "victory",
            log: [...s.log, line],
          },
          says: [line, `${s.enemy_name ?? s.enemy_slug} falls.`],
        };
      }
      return {
        next: "enemy_turn",
        state: { ...s, enemy_hp: newEnemyHp, log: [...s.log, line].slice(-5) },
        says: [line],
      };
    },

    enemy_turn: async (ctx, state) => {
      const s = state as CombatState;
      const dmg = ctx.rng_int(1, s.enemy_attack);
      const line = `${s.enemy_name ?? s.enemy_slug} hits back for ${dmg}.`;
      const playerHp = Number(ctx.character.state.hp ?? 0);
      const newHp = playerHp - dmg;
      if (newHp <= 0) {
        return {
          next: "done",
          state: {
            ...s,
            outcome: "defeat",
            log: [...s.log, line].slice(-5),
            round: s.round + 1,
          },
          says: [line, `You fall to the ground.`],
          // Effects propagated via the effect router so character.hp
          // updates in the game state alongside the says.
          effects: [{ kind: "damage", amount: dmg }],
        };
      }
      return {
        next: "player_turn",
        state: {
          ...s,
          log: [...s.log, line].slice(-5),
          round: s.round + 1,
        },
        says: [line],
        effects: [{ kind: "damage", amount: dmg }],
      };
    },

    done: { terminal: true },
  },
};
