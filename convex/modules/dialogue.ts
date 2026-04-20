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
  steps: {
    open: async (ctx, state) => {
      const greeting = await ctx.narrate(
        `You are ${state.speaker_slug}. ${ctx.character.pseudonym} has just approached you. Offer a one-line greeting in character. No meta-commentary.`,
        { speaker: state.speaker_slug, max_tokens: 96 },
      );
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
          says: [`You nod and step away from ${state.speaker_slug}.`],
        };
      }
      const text = String(input?.text ?? "").trim();
      if (!text) {
        return {
          next: "listen",
          says: [`(type something or pick leave)`],
          ui: {
            prompt: `Reply to ${state.speaker_slug}, or walk away.`,
            choices: [{ id: "leave", label: "Walk away" }],
            free_text: true,
          },
        };
      }
      const reply = await ctx.narrate(
        `You are ${state.speaker_slug}. The player just said: "${text}". Reply in one or two sentences, in character.`,
        { speaker: state.speaker_slug, max_tokens: 160 },
      );
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
