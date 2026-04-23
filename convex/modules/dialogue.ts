// Dialogue module — step-keyed state machine for talking to an NPC.
//
// Proves the ModuleCtx surface end-to-end: assembleNarrativePrompt via
// ctx.narrate() (Sonnet), NPC memory auto-write via the narrate()
// wrapper, ctx.state persistence across turns.
//
// Flow shape:
//   state = { speaker_slug: string, exchanges: number }
//   steps:
//     open      — NPC greets; offer [say something | leave]
//     listen    — waits for player input (free text or "leave")
//     respond   — calls Sonnet, appends reply, loops back to listen
//     done      — terminal
//
// Caller creates the flow via `flow_start` effect or `flows.start`
// mutation with initial_state = { speaker_slug: "mara" }.

import type { ModuleDef } from "@weaver/engine/flows";

type DialogueState = {
  speaker_slug: string;
  exchanges: number;
};

export const dialogueModule: ModuleDef<DialogueState> = {
  name: "dialogue",
  schema_version: 1,
  entry: "open",
  manifest: {
    reads: ["entity:npc", "entity:character", "npc_memory"],
    writes: ["npc_memory", "character.state.pending_says"],
    emits: [],
  },
  overridable: {
    greet_prompt: {
      kind: "template",
      default:
        "You are {{speaker}}. {{player}} has just approached you. Offer a one-line greeting in character. No meta-commentary.",
      placeholders: ["speaker", "player"],
      description:
        "Sonnet prompt for the opening NPC greeting. Keep it short; the response is capped at `greet_max_tokens`.",
    },
    greet_max_tokens: {
      kind: "number",
      default: 96,
      min: 16,
      max: 400,
      description: "Max tokens for the opening greeting.",
    },
    reply_prompt: {
      kind: "template",
      default:
        'You are {{speaker}}. The player just said: "{{player_text}}". Reply in one or two sentences, in character.',
      placeholders: ["speaker", "player_text"],
      description: "Sonnet prompt for each NPC reply during the back-and-forth.",
    },
    reply_max_tokens: {
      kind: "number",
      default: 160,
      min: 32,
      max: 600,
      description: "Max tokens for each NPC reply.",
    },
    leave_text: {
      kind: "template",
      default: "You nod and step away from {{speaker}}.",
      placeholders: ["speaker"],
      description: "Line shown when the player walks away.",
    },
    empty_input_text: {
      kind: "string",
      default: "(type something or pick leave)",
      max_len: 200,
      description: "Shown when the player submits blank text.",
    },
  },
  steps: {
    open: async (ctx, state) => {
      const prompt = ctx.template("greet_prompt", {
        speaker: state.speaker_slug,
        player: ctx.character.pseudonym,
      });
      const greeting = await ctx.narrate(prompt, {
        speaker: state.speaker_slug,
        max_tokens: ctx.tune<number>("greet_max_tokens"),
      });
      ctx.say(`${state.speaker_slug}: "${greeting}"`);
      return {
        next: "listen",
        state: { ...state, exchanges: 0 },
        ui: {
          prompt: `Reply to ${state.speaker_slug}, or walk away.`,
          choices: [{ id: "leave", label: "Walk away" }],
          free_text: true,
        },
      };
    },
    listen: async (ctx, state, input) => {
      if (input?.choice === "leave") {
        return {
          next: "done",
          says: [
            ctx.template("leave_text", { speaker: state.speaker_slug }),
          ],
        };
      }
      const text = String(input?.text ?? "").trim();
      if (!text) {
        return {
          next: "listen",
          says: [ctx.tune<string>("empty_input_text")],
          ui: {
            prompt: `Reply to ${state.speaker_slug}, or walk away.`,
            choices: [{ id: "leave", label: "Walk away" }],
            free_text: true,
          },
        };
      }
      const prompt = ctx.template("reply_prompt", {
        speaker: state.speaker_slug,
        player_text: text,
      });
      const reply = await ctx.narrate(prompt, {
        speaker: state.speaker_slug,
        max_tokens: ctx.tune<number>("reply_max_tokens"),
      });
      ctx.say(`${ctx.character.pseudonym}: "${text}"`);
      ctx.say(`${state.speaker_slug}: "${reply}"`);
      return {
        next: "listen",
        state: { ...state, exchanges: state.exchanges + 1 },
        ui: {
          prompt: `Continue, or walk away.`,
          choices: [{ id: "leave", label: "Walk away" }],
          free_text: true,
        },
      };
    },
    done: { terminal: true },
  },
};
