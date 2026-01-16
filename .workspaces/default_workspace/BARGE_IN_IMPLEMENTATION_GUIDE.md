# Barge-In Implementation Guide for Company Codebase

This guide explains how to implement the audio interruption (barge-in) system with **confidence-based noise filtering** and **barge-in suppression** to prevent repeated pausing during noise.

---

## Table of Contents
1. [Overview](#overview)
2. [Current State Analysis](#current-state-analysis)
3. [Required Changes](#required-changes)
   - [Backend: socket.service.ts](#1-backend-socketservicets)
   - [Frontend: AudioPlayer.tsx](#2-frontend-audioplayertsx)
   - [Frontend: App.tsx](#3-frontend-apptsx)
4. [Testing the Implementation](#testing-the-implementation)
5. [Configuration Options](#configuration-options)

---

## Overview

The barge-in system allows patients to interrupt AI audio playback by speaking. The key features are:

1. **Immediate pause** when VAD detects speech
2. **Confidence-based filtering** to distinguish real speech from noise
3. **Auto-resume** when low confidence (noise) is detected
4. **Barge-in suppression** to prevent repeated pausing during continuous noise

### Flow Diagram

```
Patient speaks/makes noise
        │
        ▼
   VAD triggers onSpeechStart
        │
        ├──► Frontend: Pause audio immediately
        │
        └──► Backend: patientBargeInStart → pause TTS
                        │
                        ▼
                  VAD onSpeechEnd
                        │
                        ▼
                  patientUtteranceAudio
                        │
                        ▼
                   STT Processing
                        │
        ┌───────────────┼───────────────┐
        │               │               │
    < 0.65          0.65-0.80        ≥ 0.80
   (Noise)        (Uncertain)     (Real Speech)
        │               │               │
        ▼               ▼               ▼
   RESUME AUDIO    Ask to repeat   INTERRUPT &
   + SUPPRESS      (TODO)          Process message
   BARGE-IN
```

---

## Current State Analysis

### What You Already Have ✅

| Component | Status | Notes |
|-----------|--------|-------|
| VAD with onSpeechStart/onSpeechEnd | ✅ | Already triggering barge-in |
| bargeInNonce state | ✅ | Already in App.tsx |
| patientBargeInStart event | ✅ | Backend handles it |
| aiResponseAudioPauseChanged event | ✅ | Defined in socketEvents.ts |
| Confidence thresholds | ✅ | LOW=0.65, HIGH=0.8 in socket.service.ts |
| AudioPlayer pause handling | ✅ | Basic implementation exists |

### What's Missing ❌

| Component | Issue |
|-----------|-------|
| `patientUtteranceStart` handler | Backend only has `patientBargeInStart` |
| `paused` state tracking | `activeAudioResponses` lacks `paused` field |
| `lastAudioResponseBySession` | Not tracking responses after stream ends |
| `pendingBargeIns` map | Not handling barge-in before TTS starts |
| Barge-in suppression | No cooldown after low confidence |
| `audioPlaybackEnded` event | Not cleaning up after frontend playback ends |

---

## Required Changes

### 1. Backend: socket.service.ts

#### 1.1 Add Missing State Tracking Maps

**Location:** Class properties (around line 130)

```typescript
// CURRENT:
private activeAudioResponses = new Map<string, { responseId: string; started: boolean; interrupted: boolean }>();

// CHANGE TO:
private activeAudioResponses = new Map<string, { responseId: string; started: boolean; interrupted: boolean; paused: boolean }>();
private pendingBargeIns = new Map<string, boolean>();  // Track sessions with pending barge-in before TTS starts
private lastAudioResponseBySession = new Map<string, { responseId: string; streamEnded: boolean }>();
```

#### 1.2 Add `patientUtteranceStart` Handler

**Location:** Inside `handlePatientSocketConnection`, after the `patientMessage` handler (around line 400)

```typescript
// Add this new handler - separate from patientBargeInStart
socket.on('patientUtteranceStart', async () => {
  console.log('[STT] patientUtteranceStart received');
  try {
    const sessionId = await this.storageService.roomSessionStrRedisValue.get(socket.data.roomId);
    if (!sessionId) return;

    // Check activeAudioResponses first
    const activeResponse = this.activeAudioResponses.get(sessionId);
    if (activeResponse) {
      console.log('[STT] patientUtteranceStart - pausing active audio:', { responseId: activeResponse.responseId });
      activeResponse.paused = true;
      await this.sendToRoom(socket.data.roomId, 'aiResponseAudioPauseChanged', {
        responseId: activeResponse.responseId,
        paused: true,
      });
      return;
    }

    // Check lastAudioResponseBySession (stream ended but frontend still playing)
    const lastResponse = this.lastAudioResponseBySession.get(sessionId);
    if (lastResponse && lastResponse.streamEnded) {
      console.log('[STT] patientUtteranceStart - pausing last audio:', { responseId: lastResponse.responseId });
      await this.sendToRoom(socket.data.roomId, 'aiResponseAudioPauseChanged', {
        responseId: lastResponse.responseId,
        paused: true,
      });
      return;
    }

    // No TTS yet - set pending barge-in
    console.log('[STT] patientUtteranceStart - setting pending barge-in');
    this.pendingBargeIns.set(sessionId, true);
  } catch (err) {
    this.logger.error({ err }, 'patientUtteranceStart handler failed');
  }
});
```

#### 1.3 Add `audioPlaybackEnded` Handler

**Location:** Right after the `patientUtteranceStart` handler

```typescript
socket.on('audioPlaybackEnded', async (payload: { responseId: string }) => {
  try {
    const sessionId = await this.storageService.roomSessionStrRedisValue.get(socket.data.roomId);
    if (!sessionId) return;

    const lastResponse = this.lastAudioResponseBySession.get(sessionId);
    if (lastResponse && lastResponse.responseId === payload.responseId) {
      console.log('[TTS] Frontend playback ended, clearing lastAudioResponse:', { responseId: payload.responseId });
      this.lastAudioResponseBySession.delete(sessionId);
      this.activeAudioResponses.delete(sessionId);
    }
  } catch (err) {
    this.logger.error({ err }, 'audioPlaybackEnded handler failed');
  }
});
```

#### 1.4 Update `patientUtteranceAudio` Handler

**Location:** In the low confidence handling section (around line 510-530)

```typescript
// CURRENT (around line 510):
if (typeof confidenceScore === 'number' && confidenceScore < LOW_CONFIDENCE) {
  // ... logging ...
  const resumeResponseId =
    pausedResponseId ?? this.activeAudioResponses.get(sessionId)?.responseId ?? null;
  // ...
}

// CHANGE TO:
if (typeof confidenceScore === 'number' && confidenceScore < LOW_CONFIDENCE) {
  this.logger.info(
    { sessionId, confidence: confidenceScore, text: asr.text },
    'Low confidence audio detected, ignoring as noise'
  );
  
  // Get the paused response to resume - check both maps
  const activeResponse = this.activeAudioResponses.get(sessionId);
  const lastResponse = this.lastAudioResponseBySession.get(sessionId);
  const resumeResponseId = pausedResponseId ?? activeResponse?.responseId ?? lastResponse?.responseId ?? null;

  console.log('[STT] Low confidence - attempting resume:', {
    pausedResponseId,
    activeResponseId: activeResponse?.responseId,
    lastResponseId: lastResponse?.responseId,
    resumeResponseId
  });

  if (resumeResponseId) {
    console.log('[STT] Sending unpause event:', { responseId: resumeResponseId });
    if (activeResponse) {
      activeResponse.paused = false;  // Clear paused state
    }
    await this.sendToRoom(socket.data.roomId, "aiResponseAudioPauseChanged", {
      responseId: resumeResponseId,
      paused: false,
    });
  } else {
    this.logger.warn({ sessionId }, "[STT] Low confidence but no active response to resume");
  }
  return;
}
```

#### 1.5 Update `streamAiResponseAudioSegment` Method

**Location:** Around line 750-800

Add tracking for `lastAudioResponseBySession` and check for pending barge-ins:

```typescript
async streamAiResponseAudioSegment(sessionId: string, payload: { ... }) {
  // ... existing setup code ...

  try {
    const { mime, stream } = await this.tts.streamSpeech(trimmed, payload.ttsOptions);
    const responseState = this.activeAudioResponses.get(sessionId);
    if (!responseState) return;

    // ADD: Track this response for potential resume even after stream ends
    this.lastAudioResponseBySession.set(sessionId, { responseId: payload.responseId, streamEnded: false });

    // ADD: Check for pending barge-in that happened before TTS started
    if (this.pendingBargeIns.get(sessionId)) {
      console.log('[TTS] Pending barge-in found, starting in paused state:', { responseId: payload.responseId });
      this.pendingBargeIns.delete(sessionId);
      responseState.paused = true;
    }

    if (!responseState.started) {
      await this.sendToRoom(roomId, 'micStatusChanged', { status: 'interrupting' });
      this.emitToRoomSockets(socketIds, 'aiResponseAudioStreamStart', {
        responseId: payload.responseId,
        mime,
      });
      responseState.started = true;

      // ADD: If already paused (pending barge-in), immediately send pause event
      if (responseState.paused) {
        console.log('[TTS] Sending immediate pause due to pending barge-in:', { responseId: payload.responseId });
        await this.sendToRoom(roomId, 'aiResponseAudioPauseChanged', {
          responseId: payload.responseId,
          paused: true,
        });
      }
    }
    
    // ... rest of streaming loop ...
  }
}
```

#### 1.6 Update `finalizeAiResponseAudioStream` Method

**Location:** Around line 830

```typescript
async finalizeAiResponseAudioStream(sessionId: string, responseId: string) {
  const activeResponse = this.activeAudioResponses.get(sessionId);
  if (!activeResponse) return;
  
  // ... existing code to get roomId and socketIds ...

  this.emitToRoomSockets(socketIds, 'aiResponseAudioStreamEnd', { responseId });

  // ADD: Mark stream as ended in lastAudioResponseBySession
  const lastResponse = this.lastAudioResponseBySession.get(sessionId);
  if (lastResponse && lastResponse.responseId === responseId) {
    lastResponse.streamEnded = true;
    console.log('[TTS] Stream ended, keeping lastAudioResponse for potential resume:', { responseId });
  }

  // ADD: If paused, keep the response for potential resume
  if (activeResponse.paused) {
    console.log('[TTS] Stream ended but paused, keeping activeResponse for potential resume:', { responseId });
    return;
  }

  await this.sendToRoom(roomId, 'micStatusChanged', { status: 'listening' });
  this.activeAudioResponses.delete(sessionId);
}
```

---

### 2. Frontend: AudioPlayer.tsx

#### 2.1 Add Barge-In Suppression Ref

**Location:** After existing refs (around line 48)

```typescript
// CURRENT:
const localBargeInActiveRef = useRef(false);
const lastBargeInNonceRef = useRef<number | undefined>(undefined);

// ADD AFTER:
// When backend detects low confidence (noise), suppress barge-in briefly to avoid re-pausing
const bargeInSuppressedUntilRef = useRef<number>(0);
```

#### 2.2 Update Barge-In Effect

**Location:** Around line 95

```typescript
// CURRENT:
useEffect(() => {
  if (typeof bargeInNonce !== "number") return;
  if (lastBargeInNonceRef.current === bargeInNonce) return;
  lastBargeInNonceRef.current = bargeInNonce;

  localBargeInActiveRef.current = true;
  const el = audioRef.current;
  if (el) {
    el.pause();
  }
  // ...
}, [bargeInNonce]);

// CHANGE TO:
useEffect(() => {
  if (typeof bargeInNonce !== "number") return;
  if (lastBargeInNonceRef.current === bargeInNonce) return;
  lastBargeInNonceRef.current = bargeInNonce;

  // Check if barge-in is currently suppressed (low confidence cooldown)
  if (Date.now() < bargeInSuppressedUntilRef.current) {
    console.log("[TTS] Barge-in suppressed (low confidence cooldown)");
    return;
  }

  localBargeInActiveRef.current = true;
  const el = audioRef.current;
  if (el) {
    el.pause();
  }
  const state = streamStateRef.current;
  if (state) {
    pendingPauseRef.current = { responseId: state.responseId, paused: true };
  }
  console.log("[TTS] Barge-in activated, audio paused");
}, [bargeInNonce]);
```

#### 2.3 Update handlePauseChanged

**Location:** Around line 275

```typescript
// CURRENT:
const handlePauseChanged = (p: { responseId: string; paused: boolean }) => {
  console.log("[TTS] PauseChanged", p);
  localBargeInActiveRef.current = p.paused;
  pendingPauseRef.current = p;

  const el = audioRef.current;
  if (!el) return;

  if (p.paused) {
    el.pause();
    return;
  }
  if (!el.src) return;
  el.play().catch((err) => {
    console.warn("[TTS] Resume playback blocked", err);
  });
};

// CHANGE TO:
const handlePauseChanged = (p: { responseId: string; paused: boolean }) => {
  const state = streamStateRef.current;
  console.log("[TTS] PauseChanged received:", {
    ...p,
    currentStreamResponseId: state?.responseId ?? null
  });

  // Check if we have a valid stream for this response
  if (!state) {
    console.warn("[TTS] PauseChanged but no active stream state");
    return;
  }
  if (state.responseId !== p.responseId) {
    console.warn("[TTS] PauseChanged responseId mismatch - ignoring");
    return;
  }

  localBargeInActiveRef.current = p.paused;
  pendingPauseRef.current = p;

  const el = audioRef.current;
  if (!el) {
    console.warn("[TTS] PauseChanged but no audio element");
    return;
  }

  if (p.paused) {
    console.log("[TTS] Pausing audio playback");
    el.pause();
    return;
  }

  // Resume playback - this means low confidence was detected
  // Suppress barge-in for 2 seconds to avoid immediate re-pause from ongoing noise
  bargeInSuppressedUntilRef.current = Date.now() + 2000;
  console.log("[TTS] Barge-in suppressed for 2s (low confidence resume)");
  localBargeInActiveRef.current = false;

  if (!el.src) {
    console.warn("[TTS] Cannot resume - no audio src");
    return;
  }
  console.log("[TTS] Resuming audio playback");
  el.play().catch((err) => {
    console.warn("[TTS] Resume playback blocked", err);
  });
};
```

#### 2.4 Add audioPlaybackEnded Emit

**Location:** In `cleanupStream` function (around line 70)

```typescript
// CURRENT:
const cleanupStream = useCallback((emitEnd = false) => {
  const state = streamStateRef.current;
  pendingPauseRef.current = null;
  localBargeInActiveRef.current = false;
  // ... cleanup code ...
  streamStateRef.current = null;
  if (emitEnd) {
    onEndRef.current?.();
  }
}, []);

// CHANGE TO:
const cleanupStream = useCallback((emitEnd = false) => {
  const state = streamStateRef.current;
  const responseIdToNotify = state?.responseId;
  pendingPauseRef.current = null;
  localBargeInActiveRef.current = false;
  // ... existing cleanup code ...
  streamStateRef.current = null;

  // Notify backend that audio playback finished
  if (responseIdToNotify) {
    socketRef.current?.emit("audioPlaybackEnded", { responseId: responseIdToNotify });
    console.log("[TTS] Notified backend of playback end:", { responseId: responseIdToNotify });
  }

  if (emitEnd) {
    onEndRef.current?.();
  }
}, [socketRef]);
```

---

### 3. Frontend: App.tsx

#### 3.1 Add `patientUtteranceStart` Emit

**Location:** In VAD onSpeechStart (around line 67)

```typescript
// CURRENT:
onSpeechStart: () => {
  console.log("[VAD] onSpeechStart triggered (barge-in)");
  setBargeInNonce((prev) => prev + 1);
  socketRef.current?.emit("patientBargeInStart");
},

// CHANGE TO:
onSpeechStart: () => {
  console.log("[VAD] onSpeechStart triggered");
  setBargeInNonce((prev) => prev + 1);
  socketRef.current?.emit("patientUtteranceStart");  // Changed from patientBargeInStart
},
```

---

## Testing the Implementation

### Test Cases

| Test | Expected Behavior |
|------|-------------------|
| Speak clearly during AI audio | Audio pauses, processes speech, new AI response |
| Hum during AI audio | Audio pauses briefly, then resumes automatically |
| Multiple hums in a row | Audio continues after first resume (suppression active) |
| Speak before AI starts responding | AI response starts paused, then unpauses after low confidence |
| AI audio ends while paused | Can still resume if low confidence detected |

### Debug Logging

Look for these console logs:

```
[STT] patientUtteranceStart received
[STT] patientUtteranceStart - pausing active audio: { responseId: '...' }
[STT] Low confidence - attempting resume: { ... }
[STT] Sending unpause event: { responseId: '...' }
[TTS] Barge-in suppressed for 2s (low confidence resume)
[TTS] Resuming audio playback
[TTS] Barge-in suppressed (low confidence cooldown)
```

---

## Configuration Options

### Adjustable Parameters

| Parameter | Location | Default | Description |
|-----------|----------|---------|-------------|
| `LOW_CONFIDENCE` | socket.service.ts | 0.65 | Below this = noise |
| `HIGH_CONFIDENCE` | socket.service.ts | 0.80 | Above this = real speech |
| Suppression duration | AudioPlayer.tsx | 2000ms | Cooldown after low confidence |
| `redemptionMs` | App.tsx VAD | 1200ms | Time before speech end triggers |
| `positiveSpeechThreshold` | App.tsx VAD | 0.2 | VAD sensitivity |
| `minSpeechMs` | App.tsx VAD | 400ms | Minimum speech duration |

### Tuning Tips

1. **Too many false interruptions?** Lower `positiveSpeechThreshold` or increase `minSpeechMs`
2. **Audio doesn't resume fast enough?** Reduce suppression duration from 2000ms
3. **Missing real speech?** Increase `LOW_CONFIDENCE` threshold
4. **Processing noise as speech?** Decrease `HIGH_CONFIDENCE` threshold

---

## Summary Checklist

- [ ] Add `paused` field to `activeAudioResponses` type
- [ ] Add `pendingBargeIns` map
- [ ] Add `lastAudioResponseBySession` map  
- [ ] Add `patientUtteranceStart` socket handler
- [ ] Add `audioPlaybackEnded` socket handler
- [ ] Update low confidence handling to check both maps
- [ ] Update `streamAiResponseAudioSegment` for pending barge-ins
- [ ] Update `finalizeAiResponseAudioStream` for stream-ended tracking
- [ ] Add `bargeInSuppressedUntilRef` to AudioPlayer
- [ ] Update barge-in effect to check suppression
- [ ] Update `handlePauseChanged` to set suppression on resume
- [ ] Add `audioPlaybackEnded` emit to cleanupStream
- [ ] Change `patientBargeInStart` to `patientUtteranceStart` in App.tsx
