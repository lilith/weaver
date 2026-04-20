# Weaver — Voice Input

## Goal

Voice input available everywhere a player types — world bible builder fields, free-text expansion, chat messages, prompt-based editing. Works on-device (no server round-trip, no cost, no privacy concern). Useful for younger family members who type slowly, for multi-tasking players, and for dictating longer world-building prompts.

## Engine: Whisper via @xenova/transformers (transformers.js)

Runs OpenAI's Whisper models in-browser via ONNX Runtime with WebGPU acceleration. Xenova's distribution ships pre-converted models and a simple JS API.

Model choice: **whisper-base** (74 MB, good accuracy at fast speed). Upgrade to whisper-small (244 MB) only if accuracy issues surface with young kids / strong accents.

```ts
// apps/play/src/lib/voice/whisper.ts
import { pipeline, env } from "@xenova/transformers"

env.backends.onnx.wasm.wasmPaths = "/onnx/"
env.allowLocalModels = false
env.useBrowserCache = true   // caches model in IndexedDB; only downloads once

let transcriber: any | null = null

export async function ensureTranscriber() {
  if (transcriber) return transcriber
  transcriber = await pipeline(
    "automatic-speech-recognition",
    "Xenova/whisper-base",
    { device: "webgpu" }  // falls back to wasm if WebGPU unavailable
  )
  return transcriber
}

export async function transcribe(audio: Float32Array, lang = "en"): Promise<string> {
  const t = await ensureTranscriber()
  const result = await t(audio, { language: lang, task: "transcribe" })
  return result.text.trim()
}
```

## UX

Every text input field has a microphone icon adjacent. Tap-and-hold to record; release to transcribe and insert into the field.

```
┌──────────────────────────────────┐
│  Describe your character...      │
│  [text area]              [🎤]   │
└──────────────────────────────────┘
```

Recording UI: the entire button fills with a waveform visualization during capture, with a live duration counter. On release: a small "transcribing..." state, then the transcribed text appears in the field (appended if there's existing content, replacing if not).

### Behavior details

- Hold-to-record: prevents accidental activation, intuitive for kids.
- Max recording: 60 seconds. Visual warning at 50s.
- Short recording (< 500ms) is discarded without transcribing (probably a misclick).
- Transcription timeout: 10s. On timeout, show error, don't insert anything.
- Before first use on a device: one-time model download (74 MB), shown with progress bar. Cached in IndexedDB thereafter.
- Permission: browser prompts for microphone access on first use; handled by the standard `navigator.mediaDevices.getUserMedia` flow.

### Desktop

Same UX. Spacebar-hold alternative when focus is in a text field and no text selected — power-user shortcut, hidden by default, surfaced via settings.

## Fallback strategy

### WebGPU unavailable

Many iOS Safari versions, older Android devices, and Firefox without WebGPU enabled. Transformers.js auto-falls back to WASM CPU execution. Slower (~3-5x real-time transcription vs. 0.5-1x on WebGPU), but functional.

If CPU transcription of a 10-second clip takes > 30s, the user gives up. We detect this: if transcription exceeds 3x clip duration, show a tooltip suggesting they type instead, and offer "disable voice input on this device" in settings.

### Microphone access denied

Show a friendly message: "Voice input needs microphone access. You can enable it in your browser settings." Provide link to OS-specific help. Voice button greys out; text input works normally.

### Browser doesn't support MediaRecorder / Web Audio API

Rare in 2026. Graceful fallback: voice button hidden entirely.

### Server-side STT (optional, Wave 3+)

For users on truly underpowered devices, a server-side transcription path via Deepgram or Anthropic's forthcoming audio-input Opus variant. Opt-in (requires server round-trip, costs money, but faster on weak devices). Not built in Wave 1.

## Integration points

### 1. World bible builder

Every text field in the 7-step onboarding supports voice. Especially valuable in character creation ("describe your character"), where a kid can ramble verbally while an adult helps edit.

### 2. Free-text expansion

The free-text input on any location page. Hold-to-record, release to submit. Most natural in-game use: "I climb the chapel tower" spoken faster than typed.

### 3. Chat

Per-location chat input supports voice. Transcribed text appears in the input field; user can edit before sending (useful to avoid autocorrect-style errors in the transcription).

### 4. Prompt-based editing

The "Edit with prompt" modal has voice input in its description field.

### 5. NOT in free-form NPC dialogue (Wave 1)

NPC dialogue is still button-choice based in Wave 1. Voice-to-NPC is a Wave 3+ feature involving either (a) structured classification of the utterance, or (b) streaming conversational voice via Deepgram / Inworld. Out of scope.

## Audio pipeline details

### Capture

```ts
const stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    channelCount: 1,
    sampleRate: 16000,           // Whisper's expected rate
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
})
const audioCtx = new AudioContext({ sampleRate: 16000 })
const source = audioCtx.createMediaStreamSource(stream)
// ... record into Float32Array via AudioWorkletNode or ScriptProcessor ...
```

Capture at 16 kHz mono. Whisper expects this rate; resampling in-browser is extra work.

### Visualization

During recording, draw a real-time waveform using `AnalyserNode.getFloatTimeDomainData()`. Reassures the user the mic is working. Doubles as a "this is too quiet" indicator.

### Transcription call

```ts
const audioFloat32 = /* ... captured buffer ... */
const text = await transcribe(audioFloat32, languagePref)
insertIntoField(text)
```

Language preference: default "en" but user can set in settings. Whisper supports 99 languages; Spanish, French, Mandarin, Japanese all solid. Lilith's family likely English-only.

## Performance expectations

On a modern mid-tier device (M1 MacBook Air, Pixel 8, iPhone 14):

- First-time model load: 3-8 seconds (network-dependent).
- Subsequent loads from cache: < 1 second.
- 10-second clip transcription: 1-3 seconds on WebGPU, 5-15 seconds on WASM CPU.

On low-end devices (older Android, cheap Chromebooks):
- WASM CPU transcription: 10-30 seconds for 10-second clip. Usable but frustrating.

## Privacy

On-device processing means:
- Audio never leaves the device.
- No server sees the audio bytes.
- No cost per transcription.
- Works offline (after initial model download).

Declare this clearly in the UI: on first-time voice button tap, a one-line message: "Voice stays on your device. We never hear it."

## Storage

Transcribed text is inserted directly into the field. We do NOT store raw audio:
- Not retained in IndexedDB.
- Not uploaded.
- Clip discarded after transcription completes.

Exception: if a user explicitly requests "show me what I said," we could retain the last recording in-memory for playback during the current modal. Released on navigation. Never persisted.

## Accessibility

- Caption on the voice button: "Record voice input (hold to speak)" for screen readers.
- Alternative: keyboard shortcut (spacebar-hold when field focused) surfaced via settings.
- Visual feedback during recording (waveform + duration) helps hard-of-hearing users confirm it's working.
- Text output appears in a standard input; normal edit controls apply.

## Testing

- Unit: mock MediaRecorder, assert correct pipeline stages invoke.
- Integration: Playwright injects a pre-recorded audio clip into the capture stream, verifies transcription matches expected text.
- Manual: each family member tests voice on their primary device once, reports accuracy and latency.
- Accessibility: screen reader walkthrough of a voice-input flow.

## Cost

**Zero.** On-device, no API calls. Model hosting is static files on Cloudflare Pages; trivial bandwidth.

## Future: streaming voice for NPC conversations (Wave 3+)

For Wave 3's more ambitious voice-first NPC conversations, options:

1. **Deepgram Aura + Nova** — streaming STT and TTS. ~$0.01/minute of audio. Works well for real-time voice chat with NPCs, but adds per-minute cost and server dependency.

2. **Inworld streaming** — purpose-built character voice AI. Higher cost, richer character voice.

3. **Native browser Whisper streaming** — Whisper supports streaming transcription. Implementable in-browser with more engineering, stays free. Best if Wave 3 prioritizes it.

Not Wave 1. Note here for planning visibility.

## Integration into existing specs

- **`05_WORLD_BIBLE_BUILDER.md`** — §"Step 4 — Characters" already notes voice input; link to this doc.
- **`04_EXPANSION_LOOP.md`** — §"Two triggers" add: "Free-text can be dictated via voice; same pipeline."
- **`09_TECH_STACK.md`** — confirm `@xenova/transformers` in dependencies; add `/static/onnx/*` path for WASM backends.
- **`11_PROMPT_EDITING.md`** — §"Universal affordance" mention voice in the edit modal input.
