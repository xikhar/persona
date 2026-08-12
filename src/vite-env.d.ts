/// <reference types="vite/client" />

import type * as PersonaApi from '../shared/persona-api';

declare global {
  type VoicePhase = PersonaApi.VoicePhase;
  type VoiceActivity = PersonaApi.VoiceActivity;
  type VoiceState = PersonaApi.VoiceState;
  type AudioListenerStatus = PersonaApi.AudioListenerStatus;
  type PersonaLightingSettings = PersonaApi.PersonaLightingSettings;
  type PersonaSpeakingTransitionSettings =
    PersonaApi.PersonaSpeakingTransitionSettings;
  type PersonaAnimationType = PersonaApi.PersonaAnimationType;
  type PersonaExpressionName = PersonaApi.PersonaExpressionName;
  type PersonaModelSettings = PersonaApi.PersonaModelSettings;
  type PersonaAnimationSettings = PersonaApi.PersonaAnimationSettings;
  type PersonaAnimationClipSettings = PersonaApi.PersonaAnimationClipSettings;
  type PersonaVoiceSourceSettings = PersonaApi.PersonaVoiceSourceSettings;
  type PersonaVoiceSource = PersonaApi.PersonaVoiceSource;
  type PersonaVoiceSourceCatalog = PersonaApi.PersonaVoiceSourceCatalog;
  type PersonaAvatarWindowSize = PersonaApi.PersonaAvatarWindowSize;
  type PersonaSettingsSnapshot = PersonaApi.PersonaSettingsSnapshot;
  type PersonaMcpStatus = PersonaApi.PersonaMcpStatus;
  type CustomAnimationMetadata = PersonaApi.CustomAnimationMetadata;
  type PersonaVroidHubStatus = PersonaApi.PersonaVroidHubStatus;
  type PersonaVroidHubCredentials = PersonaApi.PersonaVroidHubCredentials;
  type VroidHubUsagePermission = PersonaApi.VroidHubUsagePermission;
  type PersonaVroidHubCharacterLicenseV0 =
    PersonaApi.PersonaVroidHubCharacterLicenseV0;
  type PersonaVroidHubCharacterLicenseV1 =
    PersonaApi.PersonaVroidHubCharacterLicenseV1;
  type PersonaVroidHubCharacterLicense =
    PersonaApi.PersonaVroidHubCharacterLicense;
  type PersonaVroidHubCharacter = PersonaApi.PersonaVroidHubCharacter;
  type AvatarBridgeEvent = PersonaApi.AvatarRendererEvent;

  interface Window {
    personaBridge?: PersonaApi.PersonaBridgeApi;
    personaSettings?: PersonaApi.PersonaSettingsApi;
    personaVroidHub?: PersonaApi.PersonaVroidHubApi;
  }
}

export {};
