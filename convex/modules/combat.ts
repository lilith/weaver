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
import { CANONICAL_STATS } from "@weaver/engine/stats";

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

export const combatModule: ModuleDef<CombatState> = {
  name: "combat",
  schema_version: 1,
  entry: "open",
  manifest: {
    reads: ["entity:npc", `character.state.${CANONICAL_STATS.HP}`],
    writes: [`character.state.${CANONICAL_STATS.HP}`],
    emits: ["combat_start", "combat_end"],
  },
  overridable: {
    default_enemy_hp: {
      kind: "number",
      default: 10,
      min: 1,
      max: 999,
      description:
        "Enemy HP when the caller didn't specify. Raise for tougher encounters.",
    },
    default_enemy_attack: {
      kind: "number",
      default: 3,
      min: 0,
      max: 99,
      description:
        "Top of the enemy's per-swing damage roll (damage is 1..this) when unset.",
    },
    default_player_weapon_attack: {
      kind: "number",
      default: 4,
      min: 0,
      max: 99,
      description:
        "Top of the player's per-swing damage roll when unset. Raise to make the player hit harder.",
    },
    default_escape_dc: {
      kind: "number",
      default: 5,
      min: 1,
      max: 10,
      description:
        "Flee check difficulty: roll 1..10 must be <= this to escape. Higher = easier to flee.",
    },
    opening_line: {
      kind: "template",
      default: "Combat begins. {{player}} faces {{enemy}}.",
      placeholders: ["player", "enemy"],
      description: "Shown when combat opens.",
    },
    round_header: {
      kind: "template",
      default:
        "Round {{round}}. {{enemy}} has {{enemy_hp}}/{{enemy_max_hp}} hp.",
      placeholders: ["round", "enemy", "enemy_hp", "enemy_max_hp"],
      description: "First line of each player turn.",
    },
    player_hp_line: {
      kind: "template",
      default: "You have {{hp}} hp.",
      placeholders: ["hp"],
      description: "Second line of each player turn.",
    },
    attack_line: {
      kind: "template",
      default:
        "{{player}} strikes for {{dmg}} — {{enemy}}: {{enemy_hp}}/{{enemy_max_hp}}",
      placeholders: ["player", "dmg", "enemy", "enemy_hp", "enemy_max_hp"],
      description: "Shown after a player attack.",
    },
    victory_line: {
      kind: "template",
      default: "{{enemy}} falls.",
      placeholders: ["enemy"],
      description: "Shown when the enemy drops to 0 hp.",
    },
    flee_success_line: {
      kind: "template",
      default:
        "You roll {{roll}} vs DC {{dc}}. You break away and run.",
      placeholders: ["roll", "dc"],
      description: "Shown when a flee attempt succeeds.",
    },
    flee_fail_line: {
      kind: "template",
      default:
        "You roll {{roll}} vs DC {{dc}}. You stumble. The enemy presses.",
      placeholders: ["roll", "dc"],
      description: "Shown when a flee attempt fails.",
    },
    enemy_hit_line: {
      kind: "template",
      default: "{{enemy}} hits back for {{dmg}}.",
      placeholders: ["enemy", "dmg"],
      description: "Shown on each enemy swing.",
    },
    defeat_line: {
      kind: "string",
      default: "You fall to the ground.",
      max_len: 200,
      description: "Shown when the player drops to 0 hp.",
    },
  },
  steps: {
    open: async (ctx, state) => {
      const defaults: Omit<CombatState, "enemy_slug"> = {
        enemy_hp: ctx.tune<number>("default_enemy_hp"),
        enemy_max_hp: ctx.tune<number>("default_enemy_hp"),
        enemy_attack: ctx.tune<number>("default_enemy_attack"),
        player_weapon_attack: ctx.tune<number>("default_player_weapon_attack"),
        round: 1,
        log: [],
        escape_dc: ctx.tune<number>("default_escape_dc"),
      };
      const merged: CombatState = { ...defaults, ...(state as Partial<CombatState>) };
      const name = merged.enemy_name ?? merged.enemy_slug ?? "the enemy";
      ctx.say(
        ctx.template("opening_line", {
          player: ctx.character.pseudonym,
          enemy: name,
        }),
      );
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
      const enemyName = s.enemy_name ?? s.enemy_slug ?? "the enemy";
      if (!input) {
        return {
          next: "player_turn",
          says: [
            ctx.template("round_header", {
              round: s.round,
              enemy: enemyName,
              enemy_hp: s.enemy_hp,
              enemy_max_hp: s.enemy_max_hp,
            }),
            ctx.template("player_hp_line", {
              hp: String(ctx.character.state[CANONICAL_STATS.HP] ?? "?"),
            }),
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
              ctx.template("flee_success_line", { roll, dc: s.escape_dc }),
            ],
          };
        }
        const fail = ctx.template("flee_fail_line", { roll, dc: s.escape_dc });
        return {
          next: "enemy_turn",
          state: {
            ...s,
            log: [...s.log, `You tried to flee (rolled ${roll}) — no luck.`],
          },
          says: [fail],
        };
      }

      // Default: attack.
      const dmg = ctx.rng_int(1, s.player_weapon_attack);
      const newEnemyHp = Math.max(0, s.enemy_hp - dmg);
      const line = ctx.template("attack_line", {
        player: ctx.character.pseudonym,
        dmg,
        enemy: enemyName,
        enemy_hp: newEnemyHp,
        enemy_max_hp: s.enemy_max_hp,
      });
      if (newEnemyHp <= 0) {
        return {
          next: "done",
          state: {
            ...s,
            enemy_hp: 0,
            outcome: "victory",
            log: [...s.log, line],
          },
          says: [line, ctx.template("victory_line", { enemy: enemyName })],
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
      const enemyName = s.enemy_name ?? s.enemy_slug ?? "the enemy";
      const dmg = ctx.rng_int(1, s.enemy_attack);
      const line = ctx.template("enemy_hit_line", {
        enemy: enemyName,
        dmg,
      });
      const playerHp = Number(ctx.character.state[CANONICAL_STATS.HP] ?? 0);
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
          says: [line, ctx.tune<string>("defeat_line")],
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
