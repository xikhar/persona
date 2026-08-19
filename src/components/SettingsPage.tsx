import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Scene } from './Scene';
import { AnimationsSection } from './settings/AnimationsSection';
import { AppearanceSection } from './settings/AppearanceSection';
import { DeveloperSection } from './settings/DeveloperSection';
import { McpSection } from './settings/McpSection';
import { ModelsSection } from './settings/ModelsSection';
import { SECTION_ICONS } from './settings/section-icons';
import { VoiceSection } from './settings/VoiceSection';
import { VroidConditionsOfUse } from './settings/VroidCharacters';
import {
  animationExpression,
  animationUrlsForType,
  type PlayableAnimationType,
} from '../animation-catalog';
import { useThemePreference } from '../hooks/useThemePreference';
import { errorMessage } from '../settings-errors';
import {
  SECTIONS,
  settingsSection,
  type SettingsSection,
} from '../settings-sections';
import {
  lightingNumberInRange,
  loadPackagedSettingsFallback,
  MAX_AVATAR_WINDOW_HEIGHT,
  MAX_AVATAR_WINDOW_WIDTH,
  MIN_AVATAR_WINDOW_HEIGHT,
  MIN_AVATAR_WINDOW_WIDTH,
  SETTINGS_FALLBACK,
  resolveLightingSettings,
  type LightingNumberField,
} from '../settings-defaults';
import { groupVroidCharacters } from '../vroid-characters';
import { forgetMissingVroidPortraits } from '../vroid-portraits';
import {
  expressionsForModel,
  type ModelExpressionReport,
} from '../model-expression-catalog';

interface ConfirmationRequest {
  confirmLabel: string;
  detail: ReactNode;
  onConfirm: () => Promise<void>;
  title: string;
}

export function SettingsPage() {
  const bridge = window.personaSettings;
  const vroidHubBridge = window.personaVroidHub;
  const { chooseTheme, preference: themePreference } = useThemePreference();
  const [previewCollapsed, setPreviewCollapsed] = useState(false);
  const [settings, setSettings] =
    useState<PersonaSettingsSnapshot>(SETTINGS_FALLBACK);
  const [section, setSection] = useState<SettingsSection>('models');
  const [selectedModelId, setSelectedModelId] = useState(
    SETTINGS_FALLBACK.default_model_id,
  );
  const [avatarWidthInput, setAvatarWidthInput] = useState(
    String(SETTINGS_FALLBACK.avatar_window.width),
  );
  const [avatarHeightInput, setAvatarHeightInput] = useState(
    String(SETTINGS_FALLBACK.avatar_window.height),
  );
  const [previewAnimation, setPreviewAnimation] =
    useState<PersonaAnimationSettings | null>(null);
  const [expressionReport, setExpressionReport] =
    useState<ModelExpressionReport | null>(null);
  const [previewClipId, setPreviewClipId] = useState<string | null>(null);
  const [previewRequest, setPreviewRequest] = useState(0);
  const [modelName, setModelName] = useState('');
  const [animationMetadata, setAnimationMetadata] =
    useState<CustomAnimationMetadata>({
      animation_name: '',
      animation_description: '',
      animation_trigger_scenario: '',
      expression_name: null,
      expression_weight: 1,
    });
  const [editingAnimationId, setEditingAnimationId] = useState<string | null>(
    null,
  );
  const [editingAnimationMetadata, setEditingAnimationMetadata] =
    useState<CustomAnimationMetadata>({
      animation_name: '',
      animation_description: '',
      animation_trigger_scenario: '',
      expression_name: null,
      expression_weight: 1,
    });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [mcpStatus, setMcpStatus] = useState<PersonaMcpStatus | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);
  const [voiceMode, setVoiceMode] = useState<
    PersonaVoiceSourceSettings['mode']
  >(
    SETTINGS_FALLBACK.voice_source.mode,
  );
  const [voicePattern, setVoicePattern] = useState(
    SETTINGS_FALLBACK.voice_source.process_pattern ?? '',
  );
  const [voiceCatalog, setVoiceCatalog] =
    useState<PersonaVoiceSourceCatalog | null>(null);
  const [voiceSourcesLoading, setVoiceSourcesLoading] = useState(false);
  const [voiceSourceSearch, setVoiceSourceSearch] = useState('');
  const [confirmation, setConfirmation] =
    useState<ConfirmationRequest | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [vroidStatus, setVroidStatus] = useState<PersonaVroidHubStatus | null>(
    null,
  );
  const [vroidCredentials, setVroidCredentials] =
    useState<PersonaVroidHubCredentials | null>(null);
  const [vroidClientIdInput, setVroidClientIdInput] = useState('');
  const [vroidClientSecretInput, setVroidClientSecretInput] = useState('');
  const [vroidCredentialsSaving, setVroidCredentialsSaving] = useState(false);
  const [vroidCharacters, setVroidCharacters] = useState<
    PersonaVroidHubCharacter[] | null
  >(null);
  const [vroidLoading, setVroidLoading] = useState(false);
  // Remounts the portrait of every card when it changes — see
  // refreshVroidCharacters.
  const [vroidPortraitEpoch, setVroidPortraitEpoch] = useState(0);
  const confirmationDialogRef = useRef<HTMLDivElement>(null);
  const confirmationCancelRef = useRef<HTMLButtonElement>(null);
  const confirmationConfirmRef = useRef<HTMLButtonElement>(null);
  const settingsContentRef = useRef<HTMLElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    document.title = 'Persona Settings';
    if (!bridge) {
      void loadPackagedSettingsFallback()
        .then((snapshot) => {
          setSettings(snapshot);
          setSelectedModelId(snapshot.default_model_id);
        })
        .catch((error: unknown) => setNotice(errorMessage(error)));
      return;
    }
    void bridge
      .get()
      .then((snapshot) => {
        setSettings(snapshot);
        setSelectedModelId(snapshot.default_model_id);
      })
      .catch((error: unknown) => setNotice(errorMessage(error)));
    return bridge.subscribe(setSettings);
  }, [bridge]);

  useEffect(() => {
    if (!vroidHubBridge) return;
    void vroidHubBridge
      .getStatus()
      .then(setVroidStatus)
      .catch((error: unknown) => setNotice(errorMessage(error)));
    void vroidHubBridge
      .getCredentials()
      .then((credentials) => {
        setVroidCredentials(credentials);
        setVroidClientIdInput(credentials.clientId ?? '');
      })
      .catch((error: unknown) => setNotice(errorMessage(error)));
    return vroidHubBridge.subscribe(setVroidStatus);
  }, [vroidHubBridge]);

  const refreshVroidCharacters = useCallback(async () => {
    if (!vroidHubBridge) return;
    setVroidLoading(true);
    forgetMissingVroidPortraits();
    // Bumped so every card's portrait effect runs again against the freshened
    // cache; the character ids a refresh returns are usually identical, which
    // on its own would leave the effects — and any stuck placeholder — alone.
    setVroidPortraitEpoch((epoch) => epoch + 1);
    try {
      setVroidCharacters(await vroidHubBridge.listCharacters());
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setVroidLoading(false);
    }
  }, [vroidHubBridge]);

  useEffect(() => {
    if (vroidStatus?.connected) void refreshVroidCharacters();
    else setVroidCharacters(null);
  }, [vroidStatus?.connected, refreshVroidCharacters]);

  const { hearted: heartedVroidCharacters, own: ownVroidCharacters } = useMemo(
    () => groupVroidCharacters(vroidCharacters),
    [vroidCharacters],
  );

  useEffect(() => {
    setVoiceMode(settings.voice_source.mode);
    setVoicePattern(settings.voice_source.process_pattern ?? '');
  }, [settings.voice_source.mode, settings.voice_source.process_pattern]);

  useEffect(() => {
    setPreviewAnimation((current) => {
      if (!current) return null;
      return (
        settings.animations.find((animation) => animation.id === current.id) ??
        null
      );
    });
    setPreviewClipId((current) => {
      if (!current) return null;
      return settings.animations.some((animation) =>
        animation.clips.some((clip) => clip.id === current),
      )
        ? current
        : null;
    });
  }, [settings.animations]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const selectedModel =
    settings.models.find((model) => model.id === selectedModelId) ??
    settings.models.find((model) => model.id === settings.default_model_id) ??
    settings.models[0];
  const availableExpressions = expressionsForModel(
    expressionReport,
    selectedModel?.asset_url ?? null,
  );
  const handleExpressionsChange = useCallback(
    (modelUrl: string, expressions: readonly string[]) => {
      setExpressionReport({ modelUrl, expressions });
    },
    [],
  );

  const customModelCount = settings.models.filter(
    (model) => model.origin === 'user',
  ).length;
  const customAnimationCount = settings.animations.filter(
    (animation) => animation.origin === 'user',
  ).length;

  const previewType: PlayableAnimationType =
    previewAnimation?.animation_type ??
    (previewAnimation ? 'CUSTOM' : 'IDLE');
  const previewExpression = animationExpression(previewAnimation);
  const idleAnimationUrls = useMemo(
    () => animationUrlsForType(settings.animations, 'IDLE'),
    [settings.animations],
  );
  const previewClip = previewAnimation?.clips.find(
    (clip) => clip.id === previewClipId,
  );
  const previewAnimationUrls = useMemo(
    () => (previewClip ? [previewClip.asset_url] : idleAnimationUrls),
    [idleAnimationUrls, previewClip],
  );

  const previewTitle = useMemo(() => {
    if (previewClip) return previewClip.animation_name;
    return 'Character preview';
  }, [previewClip]);

  const updateSnapshot = useCallback((snapshot: PersonaSettingsSnapshot) => {
    setSettings(snapshot);
    return snapshot;
  }, []);

  const run = useCallback(
    async (
      operation: () => Promise<PersonaSettingsSnapshot | null>,
      success: string,
    ) => {
      setBusy(true);
      setNotice(null);
      try {
        const snapshot = await operation();
        if (snapshot) {
          updateSnapshot(snapshot);
          setNotice(success);
        }
        return snapshot;
      } catch (error) {
        setNotice(errorMessage(error));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [updateSnapshot],
  );

  const persistAppearance = useCallback(
    async (
      operation: () => Promise<PersonaSettingsSnapshot>,
      success: string,
    ) => {
      setNotice(null);
      try {
        const snapshot = await operation();
        updateSnapshot(snapshot);
        setNotice(success);
        return snapshot;
      } catch (error) {
        setNotice(errorMessage(error));
        return null;
      }
    },
    [updateSnapshot],
  );

  const refreshMcpStatus = useCallback(async () => {
    setMcpLoading(true);
    try {
      if (!bridge) {
        setMcpStatus(null);
        return;
      }
      setMcpStatus(await bridge.getMcpStatus());
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setMcpLoading(false);
    }
  }, [bridge]);

  const refreshVoiceSources = useCallback(async () => {
    setVoiceSourcesLoading(true);
    try {
      if (!bridge) {
        setVoiceCatalog(null);
        return;
      }
      setVoiceCatalog(await bridge.listVoiceSources());
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setVoiceSourcesLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    if (section !== 'mcp') return;
    void refreshMcpStatus();
  }, [refreshMcpStatus, section, settings.animations]);

  useEffect(() => {
    if (section !== 'voice') return;
    void refreshVoiceSources();
  }, [refreshVoiceSources, section]);

  const copyText = useCallback(async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(`${label} copied.`);
    } catch {
      setNotice(`Unable to copy ${label.toLowerCase()}.`);
    }
  }, []);

  const saveVoiceSource = async (
    source: PersonaVoiceSourceSettings,
    success: string,
  ) => {
    if (!bridge) return null;
    const snapshot = await run(
      () => bridge.setVoiceSource(source),
      success,
    );
    if (!snapshot) {
      setVoiceMode(settings.voice_source.mode);
      return null;
    }
    setVoiceMode(snapshot.voice_source.mode);
    void refreshVoiceSources();
    return snapshot;
  };

  const chooseVoiceMode = (
    mode: PersonaVoiceSourceSettings['mode'],
  ) => {
    setVoiceMode(mode);
    if (mode === 'default' || mode === 'external') {
      void saveVoiceSource(
        {
          mode,
          process_pattern: null,
          source_id: null,
          source_name: null,
        },
        mode === 'default'
          ? 'Automatic ChatGPT and Codex detection enabled.'
          : 'External voice integration enabled.',
      );
    }
  };

  const chooseApplicationSource = (source: PersonaVoiceSource) => {
    void saveVoiceSource(
      {
        mode: 'application',
        process_pattern: null,
        source_id: source.id,
        source_name: source.name,
      },
      `Voice output source set to ${source.name}.`,
    );
  };

  const saveCustomVoiceSource = () => {
    void saveVoiceSource(
      {
        mode: 'custom',
        process_pattern: voicePattern,
        source_id: null,
        source_name: null,
      },
      'Advanced process pattern saved.',
    );
  };

  const openConfirmation = useCallback((request: ConfirmationRequest) => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setConfirmation(request);
  }, []);

  const closeConfirmation = useCallback(() => {
    const previousFocus = previousFocusRef.current;
    setConfirmation(null);
    setConfirming(false);
    window.requestAnimationFrame(() => {
      if (
        previousFocus?.isConnected &&
        !previousFocus.matches(':disabled')
      ) {
        previousFocus.focus();
      } else {
        settingsContentRef.current?.focus();
      }
    });
  }, []);

  useEffect(() => {
    if (!confirmation) return;
    const frame = window.requestAnimationFrame(() =>
      confirmationCancelRef.current?.focus(),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [confirmation]);

  const confirmPendingAction = async () => {
    if (!confirmation || confirming) return;
    setConfirming(true);
    try {
      await confirmation.onConfirm();
    } finally {
      closeConfirmation();
    }
  };

  const importModel = async () => {
    if (!bridge) return;
    const existingModelIds = new Set(settings.models.map((model) => model.id));
    const snapshot = await run(
      () => bridge.importModel({ model_name: modelName }),
      'Model added to your library.',
    );
    if (!snapshot) return;
    const imported = snapshot.models.find(
      (model) => !existingModelIds.has(model.id),
    );
    if (imported) setSelectedModelId(imported.id);
    setModelName('');
  };

  const createAnimation = async () => {
    if (!bridge) return;
    const snapshot = await run(
      () => bridge.createAnimation(animationMetadata),
      'Animation action created. Add one or more VRMA clips to make it playable.',
    );
    if (!snapshot) return;
    setAnimationMetadata({
      animation_name: '',
      animation_description: '',
      animation_trigger_scenario: '',
      expression_name: null,
      expression_weight: 1,
    });
  };

  const addAnimationClips = async (animation: PersonaAnimationSettings) => {
    if (!bridge) return;
    const snapshot = await run(
      () => bridge.addAnimationClips(animation.id),
      `VRMA clips added to ${animation.animation_name}.`,
    );
    if (!snapshot) return;
    const updated = snapshot.animations.find(
      (candidate) => candidate.id === animation.id,
    );
    if (previewAnimation?.id === animation.id) {
      setPreviewAnimation(updated ?? null);
    }
  };

  const setDefaultModel = async (modelId: string) => {
    if (!bridge) return;
    const snapshot = await run(
      () => bridge.setDefaultModel(modelId),
      'Default model updated.',
    );
    if (snapshot) setSelectedModelId(modelId);
  };

  const deleteModel = (model: PersonaModelSettings) => {
    if (!bridge || !model.removable) return;
    openConfirmation({
      confirmLabel: 'Delete',
      title: `Delete “${model.model_name}”?`,
      detail: 'The model and its locally stored VRM file will be removed.',
      onConfirm: async () => {
        const snapshot = await run(
          () => bridge.deleteModel(model.id),
          'Model deleted from your library.',
        );
        if (snapshot && selectedModelId === model.id) {
          setSelectedModelId(snapshot.default_model_id);
        }
      },
    });
  };

  const saveVroidCredentials = async () => {
    if (!vroidHubBridge) return;
    const clientId = vroidClientIdInput.trim();
    const clientSecret = vroidClientSecretInput.trim();
    if (!clientId || !clientSecret) {
      setNotice('Enter both a client ID and client secret.');
      return;
    }
    setVroidCredentialsSaving(true);
    setNotice(null);
    try {
      setVroidStatus(await vroidHubBridge.setCredentials(clientId, clientSecret));
      setVroidCredentials(await vroidHubBridge.getCredentials());
      setVroidClientSecretInput('');
      setVroidCharacters(null);
      setNotice('VRoid Hub app credentials saved.');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setVroidCredentialsSaving(false);
    }
  };

  const clearVroidCredentials = () => {
    if (!vroidHubBridge) return;
    openConfirmation({
      confirmLabel: 'Remove',
      title: 'Remove VRoid Hub app credentials?',
      detail:
        'Persona forgets this OAuth app and disconnects your VRoid Hub sign-in. A character currently in use from Hub is removed.',
      onConfirm: async () => {
        try {
          setVroidStatus(await vroidHubBridge.clearCredentials());
          setVroidCredentials({ clientId: null, hasClientSecret: false });
          setVroidClientIdInput('');
          setVroidClientSecretInput('');
          setVroidCharacters(null);
        } catch (error) {
          setNotice(errorMessage(error));
        }
      },
    });
  };

  const connectVroidHub = async () => {
    if (!vroidHubBridge) return;
    setBusy(true);
    setNotice(null);
    try {
      setVroidStatus(await vroidHubBridge.connect());
      setNotice('Continue signing in to VRoid Hub in your browser.');
    } catch (error) {
      setNotice(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const disconnectVroidHub = () => {
    if (!vroidHubBridge) return;
    openConfirmation({
      confirmLabel: 'Disconnect',
      title: 'Disconnect VRoid Hub?',
      detail:
        'Persona forgets your VRoid Hub sign-in. A character currently in use from Hub is removed until you reconnect and choose it again.',
      onConfirm: async () => {
        try {
          setVroidStatus(await vroidHubBridge.disconnect());
          setVroidCharacters(null);
        } catch (error) {
          setNotice(errorMessage(error));
        }
      },
    });
  };

  const activateVroidCharacter = async (character: PersonaVroidHubCharacter) => {
    if (!vroidHubBridge) return;
    const snapshot = await run(
      () => vroidHubBridge.selectCharacter(character.id, character.name),
      `${character.name} is ready to use.`,
    );
    if (!snapshot) return;
    const hubModel = snapshot.models.find((model) => model.origin === 'hub');
    if (hubModel) setSelectedModelId(hubModel.id);
  };

  const selectVroidCharacter = (character: PersonaVroidHubCharacter) => {
    if (!vroidHubBridge) return;
    if (character.origin === 'own') {
      void activateVroidCharacter(character);
      return;
    }
    // VRoid Hub's third-party integration guidelines require a conditions-
    // of-use confirmation before a hearted (not-owned) model is used.
    const owningCharacterId = character.character_id;
    openConfirmation({
      confirmLabel: 'Use this character',
      title: 'Model Data Conditions of Use',
      detail: (
        <VroidConditionsOfUse
          character={character}
          onOpenHubPage={
            owningCharacterId == null
              ? null
              : () =>
                  void vroidHubBridge.openCharacterPage(
                    owningCharacterId,
                    character.id,
                  )
          }
        />
      ),
      onConfirm: () => activateVroidCharacter(character),
    });
  };

  const beginEditingAnimation = (animation: PersonaAnimationSettings) => {
    if (!animation.editable) return;
    setEditingAnimationId(animation.id);
    setEditingAnimationMetadata({
      animation_name: animation.animation_name,
      animation_description: animation.animation_description,
      animation_trigger_scenario: animation.animation_trigger_scenario,
      expression_name: animation.expression_name,
      expression_weight: animation.expression_weight,
    });
  };

  const saveAnimation = async () => {
    if (!bridge || !editingAnimationId) return;
    const snapshot = await run(
      () =>
        bridge.updateAnimation(
          editingAnimationId,
          editingAnimationMetadata,
        ),
      'Animation details updated.',
    );
    if (!snapshot) return;
    const updated = snapshot.animations.find(
      (animation) => animation.id === editingAnimationId,
    );
    if (previewAnimation?.id === editingAnimationId) {
      setPreviewAnimation(updated ?? null);
    }
    setEditingAnimationId(null);
  };

  const deleteAnimation = (animation: PersonaAnimationSettings) => {
    if (!bridge || !animation.removable) return;
    openConfirmation({
      confirmLabel: 'Delete',
      title: `Delete “${animation.animation_name}”?`,
      detail:
        animation.origin === 'packaged'
          ? 'The action will be removed from your active library. Reset packaged actions can restore it.'
          : 'The action and all of its locally stored VRMA clips will be removed.',
      onConfirm: async () => {
        const snapshot = await run(
          () => bridge.deleteAnimation(animation.id),
          'Animation action removed from your active library.',
        );
        if (!snapshot) return;
        if (previewAnimation?.id === animation.id) {
          setPreviewAnimation(null);
          setPreviewClipId(null);
        }
        if (editingAnimationId === animation.id) {
          setEditingAnimationId(null);
        }
      },
    });
  };

  const deleteAnimationClip = (
    animation: PersonaAnimationSettings,
    clip: PersonaAnimationClipSettings,
  ) => {
    if (!bridge || !clip.removable) return;
    openConfirmation({
      confirmLabel: 'Delete',
      title: `Delete “${clip.animation_name}”?`,
      detail: 'The locally stored VRMA clip will be removed.',
      onConfirm: async () => {
        const snapshot = await run(
          () => bridge.deleteAnimationClip(animation.id, clip.id),
          `${clip.animation_name} removed.`,
        );
        if (!snapshot) return;
        const updated = snapshot.animations.find(
          (candidate) => candidate.id === animation.id,
        );
        if (previewAnimation?.id === animation.id) {
          setPreviewAnimation(updated ?? null);
        }
        if (previewClipId === clip.id) {
          setPreviewClipId(null);
        }
      },
    });
  };

  const resetPackagedAnimations = () => {
    if (
      !bridge ||
      settings.packaged_animation_change_count === 0
    ) {
      return;
    }
    openConfirmation({
      confirmLabel: 'Reset',
      title: 'Reset packaged actions?',
      detail:
        'Packaged names, descriptions, triggers, and visibility will be restored. User-created actions and uploaded clips will not change.',
      onConfirm: async () => {
        const snapshot = await run(
          () => bridge.resetPackagedAnimations(),
          'Packaged animation actions restored.',
        );
        if (!snapshot) return;
        setEditingAnimationId(null);
        setPreviewAnimation(null);
        setPreviewClipId(null);
      },
    });
  };

  const previewCharacterSize = (size: number) => {
    setSettings((current) => ({ ...current, character_size: size }));
  };

  const saveCharacterSize = async (size: number) => {
    if (!bridge) return;
    await persistAppearance(
      () => bridge.setCharacterSize(size),
      `Default character size set to ${Math.round(size * 100)}%.`,
    );
  };

  useEffect(() => {
    setAvatarWidthInput(String(settings.avatar_window.width));
    setAvatarHeightInput(String(settings.avatar_window.height));
  }, [settings.avatar_window]);

  const avatarWidth = Math.round(Number(avatarWidthInput));
  const avatarHeight = Math.round(Number(avatarHeightInput));
  const avatarWindowSizeValid =
    Number.isFinite(avatarWidth) &&
    avatarWidth >= MIN_AVATAR_WINDOW_WIDTH &&
    avatarWidth <= MAX_AVATAR_WINDOW_WIDTH &&
    Number.isFinite(avatarHeight) &&
    avatarHeight >= MIN_AVATAR_WINDOW_HEIGHT &&
    avatarHeight <= MAX_AVATAR_WINDOW_HEIGHT;
  const avatarWindowSizeChanged =
    avatarWidth !== settings.avatar_window.width ||
    avatarHeight !== settings.avatar_window.height;

  const saveAvatarWindowSize = async () => {
    if (!bridge || !avatarWindowSizeValid) return;
    await run(
      () => bridge.setAvatarWindowSize(avatarWidth, avatarHeight),
      `Avatar window resized to ${avatarWidth}×${avatarHeight}.`,
    );
  };

  const previewSpeakingTransition = (
    field: keyof PersonaSpeakingTransitionSettings,
    range: readonly [number, number],
  ) => {
    setSettings((current) => ({
      ...current,
      speaking_transition: {
        ...current.speaking_transition,
        [field]: range,
      },
    }));
  };

  const saveSpeakingTransition = async (
    field: keyof PersonaSpeakingTransitionSettings,
    range: readonly [number, number],
  ) => {
    if (!bridge) return;
    await persistAppearance(
      () =>
        bridge.setSpeakingTransition({
          ...settings.speaking_transition,
          [field]: range,
        }),
      'Speaking transition updated.',
    );
  };

  const previewBodyTransitionMs = (value: number) => {
    setSettings((current) => ({
      ...current,
      body_transition_ms: value,
    }));
  };

  const saveBodyTransitionMs = async (value: number) => {
    if (!bridge) return;
    await persistAppearance(
      () => bridge.setBodyTransitionMs(value),
      'Body transition duration updated.',
    );
  };

  const previewSpeakingDebounceMs = (value: number) => {
    setSettings((current) => ({
      ...current,
      speaking_debounce_ms: value,
    }));
  };

  const saveSpeakingDebounceMs = async (value: number) => {
    if (!bridge) return;
    await persistAppearance(
      () => bridge.setSpeakingDebounceMs(value),
      'Speaking debounce updated.',
    );
  };

  const previewIdleInterimMs = (value: number) => {
    setSettings((current) => ({
      ...current,
      idle_interim_ms: value,
    }));
  };

  const saveIdleInterimMs = async (value: number) => {
    if (!bridge) return;
    await persistAppearance(
      () => bridge.setIdleInterimMs(value),
      'Idle interim updated.',
    );
  };

  const previewVroidHubPlaintextStorageAllowed = (allowed: boolean) => {
    setSettings((current) => ({
      ...current,
      vroid_hub_allow_plaintext_storage: allowed,
    }));
  };

  const saveVroidHubPlaintextStorageAllowed = async (allowed: boolean) => {
    if (!bridge) return;
    await persistAppearance(
      () => bridge.setVroidHubPlaintextStorageAllowed(allowed),
      allowed
        ? 'VRoid Hub Linux override enabled.'
        : 'VRoid Hub Linux override disabled.',
    );
  };

  const requestDeveloperSettingsAccess = () => {
    if (!bridge || settings.developer_settings_enabled) return;
    openConfirmation({
      confirmLabel: 'Enable developer settings',
      title: 'Enable developer settings?',
      detail:
        'These controls change low-level animation behavior and may make motion look unstable or unnatural. Continue only if you are comfortable restoring the packaged defaults.',
      onConfirm: async () => {
        await run(
          () => bridge.enableDeveloperSettings(),
          'Developer settings enabled.',
        );
      },
    });
  };

  const resetDeveloperSettings = () => {
    if (!bridge || !settings.developer_settings_enabled) return;
    openConfirmation({
      confirmLabel: 'Reset',
      title: 'Reset developer settings?',
      detail:
        'All developer-only values will return to the defaults packaged with Persona.',
      onConfirm: async () => {
        await run(
          () => bridge.resetDeveloperSettings(),
          'Developer settings reset to packaged defaults.',
        );
      },
    });
  };

  const previewLighting: PersonaLightingSettings = useMemo(() => {
    return resolveLightingSettings(
      selectedModel ? settings.model_lighting[selectedModel.id] : null,
    );
  }, [selectedModel, settings.model_lighting]);

  const previewLightingField = <
    Field extends keyof PersonaLightingSettings,
  >(
    field: Field,
    value: PersonaLightingSettings[Field],
  ) => {
    if (!selectedModel) return;
    setSettings((current) => ({
      ...current,
      model_lighting: {
        ...current.model_lighting,
        [selectedModel.id]: {
          ...previewLighting,
          [field]: value,
        },
      },
    }));
  };

  const saveLightingField = async <
    Field extends keyof PersonaLightingSettings,
  >(
    field: Field,
    value: PersonaLightingSettings[Field],
  ) => {
    if (!bridge || !selectedModel) return;
    const snapshot = await persistAppearance(
      () =>
        bridge.setModelLighting(selectedModel.id, {
          ...previewLighting,
          [field]: value,
        }),
      'Lighting updated.',
    );
    if (snapshot) return;
    try {
      updateSnapshot(await bridge.get());
    } catch {
      // Keep the original validation error visible.
    }
  };

  const lightingNumber = (
    field: LightingNumberField,
    input: HTMLInputElement,
  ) => lightingNumberInRange(field, input.valueAsNumber);

  const previewLightingNumber = (
    field: LightingNumberField,
    input: HTMLInputElement,
  ) => {
    const value = lightingNumber(field, input);
    if (value != null) previewLightingField(field, value);
  };

  const saveLightingNumber = (
    field: LightingNumberField,
    input: HTMLInputElement,
  ) => {
    const value = lightingNumber(field, input);
    if (value == null) {
      input.value = String(previewLighting[field]);
      return;
    }
    void saveLightingField(field, value);
  };

  const resetLighting = async () => {
    if (!bridge || !selectedModel) return;
    await run(
      () => bridge.resetModelLighting(selectedModel.id),
      'Lighting reset to Persona defaults.',
    );
  };

  const playAnimationClip = (
    animation: PersonaAnimationSettings,
    clip: PersonaAnimationClipSettings,
  ) => {
    setPreviewAnimation(animation);
    setPreviewClipId(clip.id);
    setPreviewRequest((request) => request + 1);
  };

  const normalizedVoiceSearch = voiceSourceSearch.trim().toLowerCase();
  const visibleVoiceSources = (voiceCatalog?.sources ?? []).filter(
    (source) =>
      !normalizedVoiceSearch ||
      `${source.name} ${source.detail}`
        .toLowerCase()
        .includes(normalizedVoiceSearch),
  );
  const selectedVoiceSourceAvailable = (voiceCatalog?.sources ?? []).some(
    (source) => source.id === settings.voice_source.source_id,
  );
  const listenerStatus = voiceCatalog?.listener;
  const voiceSourceDirty =
    voiceMode !== settings.voice_source.mode ||
    (voiceMode === 'custom' &&
      voicePattern.trim() !==
        (settings.voice_source.process_pattern ?? ''));
  const voiceHeading =
    settings.voice_source.mode === 'application'
      ? settings.voice_source.source_name ?? 'Selected application'
      : settings.voice_source.mode === 'custom'
        ? 'Advanced process pattern'
        : settings.voice_source.mode === 'external'
          ? 'External events'
          : 'Automatic detection';
  const developerSettingsModified =
    settings.body_transition_ms !== SETTINGS_FALLBACK.body_transition_ms ||
    settings.speaking_debounce_ms !==
      SETTINGS_FALLBACK.speaking_debounce_ms ||
    settings.idle_interim_ms !== SETTINGS_FALLBACK.idle_interim_ms ||
    settings.vroid_hub_allow_plaintext_storage !==
      SETTINGS_FALLBACK.vroid_hub_allow_plaintext_storage ||
    (['entry_ms', 'exit_ms'] as const).some((field) =>
      settings.speaking_transition[field].some(
        (milliseconds, index) =>
          milliseconds !==
          SETTINGS_FALLBACK.speaking_transition[field][index],
      ),
    );

  const headingSummary =
    section === 'mcp'
      ? mcpStatus
        ? `${mcpStatus.tools.length} tools · ${mcpStatus.playable_actions.length} playable actions`
        : 'Local agent connection'
      : section === 'voice'
        ? voiceHeading
        : section === 'developer'
          ? settings.developer_settings_enabled
            ? 'Developer settings enabled'
            : 'Developer settings locked'
        : `${customModelCount} custom models · ${customAnimationCount} custom actions`;
  const mcpHealth = mcpStatus?.health ?? (mcpLoading ? 'starting' : 'unavailable');
  const mcpServerUrl =
    mcpStatus?.server_url ?? 'http://127.0.0.1:47831/mcp';
  const mcpSetupCommand =
    mcpStatus?.setup_command ??
    `codex mcp add persona --url ${mcpServerUrl}`;

  return (
    <main
      className={`settings-app ${
        previewCollapsed ? 'preview-collapsed' : ''
      }`}
    >
      <aside className="settings-sidebar">
        <div className="settings-brand">
          <img src="./assets/avatar.png" alt="" />
          <div className="settings-brand-copy">
            <strong>Persona</strong>
            <span>Settings</span>
          </div>
        </div>

        <nav aria-label="Settings sections">
          {SECTIONS.map((item) => (
            <button
              className={section === item.id ? 'active' : ''}
              data-testid={`section-${item.id}`}
              key={item.id}
              onClick={() => setSection(item.id)}
              type="button"
              title={item.label}
            >
              <span className="nav-glyph" aria-hidden="true">
                {SECTION_ICONS[item.id]}
              </span>
              <span className="settings-nav-copy">
                <strong>{item.label}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          ))}
        </nav>

        <div className="settings-sidebar-status">
          <span className="status-dot" />
          <span className="settings-status-copy">Changes save automatically</span>
        </div>
      </aside>

      <section
        className="settings-content"
        ref={settingsContentRef}
        tabIndex={-1}
      >
        <header className="settings-heading">
          <div>
            <span className="eyebrow">{settingsSection(section).eyebrow}</span>
            <h1>{settingsSection(section).label}</h1>
          </div>
          <span className="library-count">{headingSummary}</span>
        </header>

        {notice && (
          <div className="settings-notice" role="status">
            <span>{notice}</span>
            <button
              aria-label="Dismiss notification"
              onClick={() => setNotice(null)}
              type="button"
            >
              ×
            </button>
          </div>
        )}

        <div className="settings-scroll">
          {section === 'models' && (
            <ModelsSection
              bridge={bridge}
              busy={busy}
              clearVroidCredentials={clearVroidCredentials}
              connectVroidHub={connectVroidHub}
              copyText={copyText}
              deleteModel={deleteModel}
              disconnectVroidHub={disconnectVroidHub}
              heartedVroidCharacters={heartedVroidCharacters}
              importModel={importModel}
              modelName={modelName}
              ownVroidCharacters={ownVroidCharacters}
              refreshVroidCharacters={refreshVroidCharacters}
              saveVroidCredentials={saveVroidCredentials}
              selectVroidCharacter={selectVroidCharacter}
              selectedModel={selectedModel}
              setDefaultModel={setDefaultModel}
              setModelName={setModelName}
              setSelectedModelId={setSelectedModelId}
              setVroidClientIdInput={setVroidClientIdInput}
              setVroidClientSecretInput={setVroidClientSecretInput}
              settings={settings}
              vroidCharacters={vroidCharacters}
              vroidClientIdInput={vroidClientIdInput}
              vroidClientSecretInput={vroidClientSecretInput}
              vroidCredentials={vroidCredentials}
              vroidCredentialsSaving={vroidCredentialsSaving}
              vroidHubBridge={vroidHubBridge}
              vroidLoading={vroidLoading}
              vroidPortraitEpoch={vroidPortraitEpoch}
              vroidStatus={vroidStatus}
            />
          )}

          {section === 'animations' && (
            <AnimationsSection
              addAnimationClips={addAnimationClips}
              animationMetadata={animationMetadata}
              availableExpressions={availableExpressions}
              beginEditingAnimation={beginEditingAnimation}
              bridge={bridge}
              busy={busy}
              createAnimation={createAnimation}
              deleteAnimation={deleteAnimation}
              deleteAnimationClip={deleteAnimationClip}
              editingAnimationId={editingAnimationId}
              editingAnimationMetadata={editingAnimationMetadata}
              playAnimationClip={playAnimationClip}
              previewClipId={previewClipId}
              resetPackagedAnimations={resetPackagedAnimations}
              saveAnimation={saveAnimation}
              setAnimationMetadata={setAnimationMetadata}
              setEditingAnimationId={setEditingAnimationId}
              setEditingAnimationMetadata={setEditingAnimationMetadata}
              settings={settings}
            />
          )}

          {section === 'appearance' && (
            <AppearanceSection
              avatarHeightInput={avatarHeightInput}
              avatarWidthInput={avatarWidthInput}
              avatarWindowSizeChanged={avatarWindowSizeChanged}
              avatarWindowSizeValid={avatarWindowSizeValid}
              bridge={bridge}
              busy={busy}
              chooseTheme={chooseTheme}
              previewCharacterSize={previewCharacterSize}
              previewLighting={previewLighting}
              previewLightingField={previewLightingField}
              previewLightingNumber={previewLightingNumber}
              resetLighting={resetLighting}
              saveAvatarWindowSize={saveAvatarWindowSize}
              saveCharacterSize={saveCharacterSize}
              saveLightingField={saveLightingField}
              saveLightingNumber={saveLightingNumber}
              selectedModel={selectedModel}
              setAvatarHeightInput={setAvatarHeightInput}
              setAvatarWidthInput={setAvatarWidthInput}
              settings={settings}
              themePreference={themePreference}
            />
          )}

          {section === 'developer' && (
            <DeveloperSection
              bridge={bridge}
              busy={busy}
              developerSettingsModified={developerSettingsModified}
              previewBodyTransitionMs={previewBodyTransitionMs}
              previewIdleInterimMs={previewIdleInterimMs}
              previewSpeakingDebounceMs={previewSpeakingDebounceMs}
              previewSpeakingTransition={previewSpeakingTransition}
              previewVroidHubPlaintextStorageAllowed={previewVroidHubPlaintextStorageAllowed}
              requestDeveloperSettingsAccess={requestDeveloperSettingsAccess}
              resetDeveloperSettings={resetDeveloperSettings}
              saveBodyTransitionMs={saveBodyTransitionMs}
              saveIdleInterimMs={saveIdleInterimMs}
              saveSpeakingDebounceMs={saveSpeakingDebounceMs}
              saveSpeakingTransition={saveSpeakingTransition}
              saveVroidHubPlaintextStorageAllowed={saveVroidHubPlaintextStorageAllowed}
              settings={settings}
            />
          )}

          {section === 'voice' && (
            <VoiceSection
              bridge={bridge}
              busy={busy}
              chooseApplicationSource={chooseApplicationSource}
              chooseVoiceMode={chooseVoiceMode}
              copyText={copyText}
              listenerStatus={listenerStatus}
              refreshVoiceSources={refreshVoiceSources}
              saveCustomVoiceSource={saveCustomVoiceSource}
              selectedVoiceSourceAvailable={selectedVoiceSourceAvailable}
              setVoiceMode={setVoiceMode}
              setVoicePattern={setVoicePattern}
              setVoiceSourceSearch={setVoiceSourceSearch}
              settings={settings}
              visibleVoiceSources={visibleVoiceSources}
              voiceCatalog={voiceCatalog}
              voiceHeading={voiceHeading}
              voiceMode={voiceMode}
              voicePattern={voicePattern}
              voiceSourceDirty={voiceSourceDirty}
              voiceSourceSearch={voiceSourceSearch}
              voiceSourcesLoading={voiceSourcesLoading}
            />
          )}

          {section === 'mcp' && (
            <McpSection
              copyText={copyText}
              mcpHealth={mcpHealth}
              mcpLoading={mcpLoading}
              mcpServerUrl={mcpServerUrl}
              mcpSetupCommand={mcpSetupCommand}
              mcpStatus={mcpStatus}
              refreshMcpStatus={refreshMcpStatus}
            />
          )}
        </div>
      </section>

      <aside className="settings-preview">
        <button
          aria-expanded={!previewCollapsed}
          aria-label={
            previewCollapsed ? 'Expand preview pane' : 'Collapse preview pane'
          }
          className="settings-preview-toggle"
          onClick={() => setPreviewCollapsed((collapsed) => !collapsed)}
          title={previewCollapsed ? 'Expand preview' : 'Collapse preview'}
          type="button"
        >
          <span aria-hidden="true">{previewCollapsed ? '‹' : '›'}</span>
        </button>

        {!previewCollapsed && (
          <>
            <div className="preview-header">
              <div>
                <span className="eyebrow">Live preview</span>
                <strong>{selectedModel?.model_name ?? 'Persona'}</strong>
              </div>
              <span className="preview-live">
                <i />
                Live
              </span>
            </div>
            <div className="preview-stage" data-testid="settings-preview">
              {selectedModel && (
                <Scene
                  animation={previewType}
                  animationRequest={previewRequest}
                  animationUrls={previewAnimationUrls}
                  fallbackAnimationUrls={idleAnimationUrls}
                  expressionName={previewExpression.expressionName}
                  expressionWeight={previewExpression.expressionWeight}
                  onExpressionsChange={handleExpressionsChange}
                  audioLevel={0}
                  bodySpeaking={previewType === 'TALK'}
                  characterSize={settings.character_size}
                  lighting={previewLighting}
                  enablePan={false}
                  framingMargin={1.22}
                  groundShadow
                  modelUrl={selectedModel.asset_url}
                  onAnimationComplete={() => {
                    setPreviewAnimation(null);
                    setPreviewClipId(null);
                  }}
                  playback={previewClip ? 'once' : 'loop'}
                  speaking={previewType === 'TALK'}
                  bodyTransitionMs={settings.body_transition_ms}
                  speakingDebounceMs={settings.speaking_debounce_ms}
                  idleInterimMs={settings.idle_interim_ms}
                  speakingTransition={settings.speaking_transition}
                />
              )}
              <div className="preview-hint">
                Drag to rotate · Scroll to zoom
              </div>
            </div>
            <div className="preview-now-playing">
              <span>Now previewing</span>
              <strong>{previewTitle}</strong>
              {previewAnimation && (
                <small>{previewAnimation.animation_description}</small>
              )}
            </div>
          </>
        )}
      </aside>

      {confirmation && (
        <div
          className="settings-dialog-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !confirming) {
              closeConfirmation();
            }
          }}
        >
          <div
            aria-busy={confirming}
            aria-describedby="settings-confirmation-detail"
            aria-labelledby="settings-confirmation-title"
            aria-modal="true"
            className="settings-dialog"
            onKeyDown={(event) => {
              if (event.key === 'Escape' && !confirming) {
                event.preventDefault();
                closeConfirmation();
                return;
              }
              if (event.key !== 'Tab') return;
              const first = confirmationCancelRef.current;
              const last = confirmationConfirmRef.current;
              if (!first || !last) return;
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (
                !event.shiftKey &&
                document.activeElement === last
              ) {
                event.preventDefault();
                first.focus();
              }
            }}
            ref={confirmationDialogRef}
            role="dialog"
          >
            <div className="settings-dialog-icon" aria-hidden="true">
              !
            </div>
            <div className="settings-dialog-copy">
              <span className="eyebrow">Confirm change</span>
              <h2 id="settings-confirmation-title">
                {confirmation.title}
              </h2>
              <div
                className="settings-dialog-detail"
                id="settings-confirmation-detail"
              >
                {confirmation.detail}
              </div>
            </div>
            <div className="settings-dialog-actions">
              <button
                className="secondary-button"
                disabled={confirming}
                onClick={closeConfirmation}
                ref={confirmationCancelRef}
                type="button"
              >
                Cancel
              </button>
              <button
                className="settings-dialog-confirm"
                disabled={confirming}
                onClick={() => void confirmPendingAction()}
                ref={confirmationConfirmRef}
                type="button"
              >
                {confirming ? 'Working…' : confirmation.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
