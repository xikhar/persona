import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { Scene } from './components/Scene';
import {
  animationUrlsForType,
  immediateVoiceAnimation,
  type AnimationType,
} from './animation-catalog';
import {
  finishBodyAnimationOverride,
  resolveBodyAnimation,
  type BodyAnimationOverride,
} from './animation-priority';
import {
  loadPackagedSettingsFallback,
  SETTINGS_FALLBACK,
} from './settings-defaults';
import {
  BODY_SPEECH_LEVEL_THRESHOLD,
  bodySpeechSignalActive,
} from './speech-signal';

const INITIAL_STATE: VoiceState = {
  activity: 'idle',
  microphoneMuted: false,
  outputMuted: false,
  phase: 'inactive',
};

export function App() {
  const [voice, setVoice] = useState<VoiceState>(INITIAL_STATE);
  const [audioLevel, setAudioLevel] = useState(0);
  const [hasObservedAudioLevel, setHasObservedAudioLevel] = useState(false);
  const [voiceAnimation, setVoiceAnimation] = useState<AnimationType>('IDLE');
  const [bodyOverride, setBodyOverride] =
    useState<BodyAnimationOverride | null>(null);
  const [settings, setSettings] =
    useState<PersonaSettingsSnapshot>(SETTINGS_FALLBACK);

  useEffect(() => {
    const bridge = window.personaBridge;
    if (!bridge) return;
    void bridge.getSnapshot().then((event) => {
      if (event?.type === 'state') setVoice(event.state);
    });
    return bridge.subscribe((event) => {
      if (event.type === 'state') {
        setVoice(event.state);
        if (event.state.phase === 'inactive') setHasObservedAudioLevel(false);
      } else if (event.type === 'audio-level') {
        setAudioLevel(event.level);
        setHasObservedAudioLevel(true);
        // A native level arrives before the coarser activity event. Make the
        // speaking library available to the scheduler on that first audible
        // packet instead of waiting for a second renderer pass through the
        // voice-state gate. Silence remains scheduler-owned and does not flip
        // this request back to Idle.
        if (event.level > BODY_SPEECH_LEVEL_THRESHOLD) {
          setVoiceAnimation('TALK');
        }
      } else if (event.type === 'animation') {
        if (event.requestId != null) {
          setBodyOverride({
            animation: event.animation,
            animationName: event.animationName,
            animationUrls: event.animationUrls,
            requestId: event.requestId,
          });
        } else if (event.animation !== 'CUSTOM') {
          setVoiceAnimation(event.animation);
        }
      }
    });
  }, []);

  useEffect(() => {
    const settingsBridge = window.personaSettings;
    if (!settingsBridge) {
      void loadPackagedSettingsFallback().then(setSettings);
      return;
    }
    void settingsBridge.get().then(setSettings);
    return settingsBridge.subscribe(setSettings);
  }, []);

  const speaking =
    voice.phase === 'active' &&
    voice.activity === 'speaking' &&
    !voice.outputMuted;
  const bodySpeaking = bodySpeechSignalActive({
    audioLevel,
    audioLevelObserved: hasObservedAudioLevel,
    voiceSpeaking: speaking,
  });
  useEffect(() => {
    const immediateAnimation = immediateVoiceAnimation(voice);
    if (immediateAnimation != null) setVoiceAnimation(immediateAnimation);
    if (voice.phase !== 'active' || voice.outputMuted) setAudioLevel(0);
  }, [voice]);

  const animation = resolveBodyAnimation(voiceAnimation, bodyOverride);
  const defaultModel =
    settings.default_model_id == null
      ? undefined
      : settings.models.find(
          (model) => model.id === settings.default_model_id,
        );
  const animationRequest = bodyOverride?.requestId ?? 0;
  const configuredAnimationUrls = useMemo(
    () => animationUrlsForType(settings.animations, animation),
    [animation, settings.animations],
  );
  const animationUrls =
    bodyOverride?.animationUrls ?? configuredAnimationUrls;
  const idleAnimationUrls = useMemo(
    () => animationUrlsForType(settings.animations, 'IDLE'),
    [settings.animations],
  );
  const preloadAnimationUrls = useMemo(
    () => [
      ...new Set(
        settings.animations.flatMap((configured) => configured.asset_urls),
      ),
    ],
    [settings.animations],
  );
  const overrideRequestId = bodyOverride?.requestId ?? null;
  const handleAnimationComplete = useCallback(() => {
    if (overrideRequestId == null) return;
    setBodyOverride((current) =>
      finishBodyAnimationOverride(current, overrideRequestId),
    );
  }, [overrideRequestId]);

  return defaultModel ? (
    <main className="app">
      <Scene
        animation={animation}
        animationRequest={animationRequest}
        animationUrls={animationUrls}
        fallbackAnimationUrls={idleAnimationUrls}
        preloadAnimationUrls={preloadAnimationUrls}
        audioLevel={audioLevel}
        bodySpeaking={bodySpeaking}
        characterSize={settings.character_size}
        lighting={settings.model_lighting[defaultModel.id]}
        modelUrl={defaultModel.asset_url}
        onAnimationComplete={handleAnimationComplete}
        playback={bodyOverride ? 'once' : 'loop'}
        speaking={speaking}
        bodyTransitionMs={settings.body_transition_ms}
        speakingDebounceMs={settings.speaking_debounce_ms}
        idleInterimMs={settings.idle_interim_ms}
        speakingTransition={settings.speaking_transition}
      />
    </main>
  ) : (
    <main className="app" />
  );
}
