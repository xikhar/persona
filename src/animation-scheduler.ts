import * as THREE from 'three';
import { randomAnimationUrl, type PlayableAnimationType } from './animation-catalog';
import {
  rankBlendedMotionTransitions,
  selectMotionTransition,
  selectVariedMotionTransition,
  type MotionClipSource,
  type MotionTransitionRanking,
} from './animation-motion';

const WEIGHT_EPSILON = 0.0001;
const MAX_SEQUENCE_TRANSITION_FRACTION = 0.45;
const MINIMUM_FULL_WEIGHT_FRACTION = 0.1;

export type AnimationPlayback = 'loop' | 'once';

export const DEFAULT_BODY_TRANSITION_MS = 700;
export const DEFAULT_SPEAKING_DEBOUNCE_MS = 350;
export const DEFAULT_IDLE_INTERIM_MS = 350;
export const DEFAULT_SPEAKING_TRANSITION: PersonaSpeakingTransitionSettings = {
  entry_ms: [810, 945],
  exit_ms: [630, 855],
};

export interface AnimationSchedulerTiming {
  bodyTransitionMs: number;
  idleInterimMs: number;
  speakingDebounceMs: number;
  speakingTransition: PersonaSpeakingTransitionSettings;
}

export interface AnimationScheduleRequest {
  animationRequest: number;
  animationUrls: readonly string[];
  fallbackAnimationUrls?: readonly string[];
  // Explicitly `| undefined`: the request key does not include the callback, so
  // a repeat of the same request carries the current one, and a repeat with no
  // callback has to clear the previous one rather than leave it to fire.
  onComplete?: (() => void) | undefined;
  playback: AnimationPlayback;
  type: PlayableAnimationType;
}

export interface AnimationSchedulerDebugEvent {
  event: string;
  time: number;
  [key: string]: unknown;
}

export interface AnimationSchedulerSnapshot {
  active: { id: number; type: PlayableAnimationType; url: string } | null;
  speakingActive: boolean;
  transition: { reason: string; to: string } | null;
  weights: Array<{
    actionTime: number;
    id: number;
    running: boolean;
    url: string;
    weight: number;
  }>;
}

interface TransitionTiming {
  entry: number;
  exit: number;
  total: number;
}

interface ActionRecord {
  action: THREE.AnimationAction;
  clip: THREE.AnimationClip;
  id: number;
  url: string;
}

interface LoadedClip {
  clip: THREE.AnimationClip;
  url: string;
}

interface NormalizedRequest extends AnimationScheduleRequest {
  animationUrls: string[];
  epoch: number;
  fallbackAnimationUrls: string[];
  key: string;
}

interface ActiveAction {
  playback: AnimationPlayback;
  record: ActionRecord;
  startTime: number;
  type: PlayableAnimationType;
}

interface SelectedTarget {
  loaded: LoadedClip;
  ranking: MotionTransitionRanking | null;
  startTime: number;
}

interface TargetSelection extends SelectedTarget {
  fallback: boolean;
}

interface ActiveTransition {
  entry: number;
  exit: number;
  reason: string;
  sources: Map<ActionRecord, number>;
  startedAt: number;
  target: ActiveAction | null;
  total: number;
}

interface SequencePlan {
  epoch: number;
  nextUrl: string | null;
  playback: AnimationPlayback;
  selectNext: () => Promise<SelectedTarget | null>;
  selection: Promise<SelectedTarget | null> | null;
  source: ActionRecord;
  startAtActionTime: number;
  startAtMixerTime: number;
  started: boolean;
  timing: TransitionTiming;
  type: PlayableAnimationType;
}

interface PendingCompletion {
  action: THREE.AnimationAction;
  callback: () => void;
  epoch: number;
}

interface AnimationSchedulerOptions {
  debug?: (event: AnimationSchedulerDebugEvent) => void;
  loadClip: (url: string) => Promise<THREE.AnimationClip>;
  random?: () => number;
  speakingActive?: boolean;
  timing: AnimationSchedulerTiming;
}

function uniqueUrls(urls: readonly string[] | undefined): string[] {
  return [...new Set(urls ?? [])];
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothStep(value: number): number {
  const progress = clampUnit(value);
  return progress * progress * (3 - 2 * progress);
}

function gentleLinearStep(value: number): number {
  const progress = clampUnit(value);
  // Keep most of the blend at a constant visible rate. A small smoothstep
  // component softens the endpoints without concentrating the pose change in
  // a fast middle burst, as a full smoothstep/smootherstep curve would.
  return 0.8 * progress + 0.2 * smoothStep(progress);
}

function sampleRange(
  range: readonly [number, number],
  random: () => number,
): number {
  return range[0] + (range[1] - range[0]) * clampUnit(random());
}

export function speakingTransitionTiming(
  settings: PersonaSpeakingTransitionSettings,
  random: () => number = Math.random,
): TransitionTiming {
  const entry = sampleRange(settings.entry_ms, random) / 1000;
  const exit = sampleRange(settings.exit_ms, random) / 1000;
  return { entry, exit, total: entry + exit };
}

export function bodyTransitionTiming(milliseconds: number): TransitionTiming {
  const total = Math.max(0, milliseconds) / 1000;
  return { entry: total / 2, exit: total / 2, total };
}

export function transitionProgress(
  elapsedSeconds: number,
  timing: Pick<TransitionTiming, 'entry' | 'exit' | 'total'>,
): number {
  if (timing.total <= Number.EPSILON) return 1;
  const elapsed = Math.max(0, elapsedSeconds);
  if (elapsed < timing.entry) {
    return timing.entry <= Number.EPSILON
      ? 0.5
      : 0.5 * gentleLinearStep(elapsed / timing.entry);
  }
  if (timing.exit <= Number.EPSILON) return 1;
  return 0.5 +
    0.5 * gentleLinearStep((elapsed - timing.entry) / timing.exit);
}

export function fitTransitionTiming(
  timing: TransitionTiming,
  maximumSeconds: number,
): TransitionTiming {
  const total = Math.min(timing.total, Math.max(0, maximumSeconds));
  if (timing.total <= Number.EPSILON || total >= timing.total) return timing;
  const scale = total / timing.total;
  return {
    entry: timing.entry * scale,
    exit: timing.exit * scale,
    total,
  };
}

export function nextSequenceTransitionTime(
  clipDuration: number,
  transitionDuration: number,
): number {
  const duration = Math.max(0, clipDuration);
  // Use the clip itself as the clock. A transition normally ends at the clip
  // boundary, but every target gets at least the first fifth of its authored
  // motion before it can be retargeted.
  return Math.max(duration * 0.2, duration - Math.max(0, transitionDuration));
}

function requestKey(request: AnimationScheduleRequest): string {
  return JSON.stringify([
    request.animationRequest,
    request.type,
    request.playback,
    uniqueUrls(request.animationUrls),
    uniqueUrls(request.fallbackAnimationUrls),
  ]);
}

export class AnimationScheduler {
  private readonly mixer: THREE.AnimationMixer;
  private readonly loadClip: (url: string) => Promise<THREE.AnimationClip>;
  private readonly random: () => number;
  private readonly debug?: (event: AnimationSchedulerDebugEvent) => void;
  private readonly clips = new Map<string, Promise<LoadedClip>>();
  private readonly readyClips = new Map<string, LoadedClip>();
  private readonly contributing = new Set<ActionRecord>();
  private readonly previousUrl = new Map<PlayableAnimationType, string>();
  private readonly recentSpeakingUrls: string[] = [];
  private desired: NormalizedRequest | null = null;
  private active: ActiveAction | null = null;
  private transition: ActiveTransition | null = null;
  private sequencePlan: SequencePlan | null = null;
  private completion: PendingCompletion | null = null;
  private timing: AnimationSchedulerTiming;
  private rawSpeakingActive: boolean;
  private speakingActive: boolean;
  private speakingSilenceStartedAt: number | null = null;
  private deferSpeakingUntilIdle = false;
  private idleInterimStartedAt: number | null = null;
  private speakingRevision = 0;
  private resolvingEpoch: number | null = null;
  private nextActionId = 1;
  private epoch = 0;
  private disposed = false;

  constructor(mixer: THREE.AnimationMixer, options: AnimationSchedulerOptions) {
    this.mixer = mixer;
    this.loadClip = options.loadClip;
    this.random = options.random ?? Math.random;
    if (options.debug) this.debug = options.debug;
    this.timing = options.timing;
    this.speakingActive = options.speakingActive ?? false;
    this.rawSpeakingActive = this.speakingActive;
    this.mixer.addEventListener('finished', this.handleFinished);
  }

  setTiming(timing: AnimationSchedulerTiming): void {
    this.timing = timing;
    this.log('timing-updated', {
      bodyTransitionMs: timing.bodyTransitionMs,
      idleInterimMs: timing.idleInterimMs,
      speakingDebounceMs: timing.speakingDebounceMs,
      speakingTransition: timing.speakingTransition,
    });
  }

  prepare(urls: readonly string[]): void {
    this.preload(urls);
  }

  setSpeakingActive(active: boolean): void {
    if (this.rawSpeakingActive === active) return;
    this.rawSpeakingActive = active;
    this.log('speaking-signal', { active });
    if (active) {
      this.speakingSilenceStartedAt = null;
      if (!this.speakingActive) this.commitSpeakingActive(true);
      return;
    }
    if (!this.speakingActive) return;
    this.speakingSilenceStartedAt = this.mixer.time;
    this.log('speaking-release-scheduled', {
      debounceMs: this.timing.speakingDebounceMs,
    });
    if (this.timing.speakingDebounceMs <= 0) {
      this.commitSpeakingActive(false);
    }
  }

  private commitSpeakingActive(active: boolean): void {
    if (this.speakingActive === active) return;
    this.speakingActive = active;
    this.speakingRevision += 1;
    this.log('speaking-activity', { active });
    const request = this.desired;
    if (!request || !this.isSpeakingRequest(request)) return;
    if (this.resolvingEpoch === request.epoch) {
      this.log('speaking-activity-deferred', {
        active,
        epoch: request.epoch,
      });
      return;
    }

    if (
      active &&
      (this.transition?.reason === 'speaking-gap' ||
        this.idleInterimStartedAt != null)
    ) {
      this.sequencePlan = null;
      this.deferSpeakingUntilIdle = true;
      this.log('speaking-resume-deferred', {
        phase: this.transition ? 'idle-transition' : 'idle-interim',
      });
      return;
    }
    const source = this.active?.record;
    if (!source) {
      if (active && this.idleInterimStartedAt == null) {
        void this.resumeSpeaking(request);
      } else if (!active) {
        this.deferSpeakingUntilIdle = false;
        this.idleInterimStartedAt = null;
      }
      return;
    }
    if (active && this.active?.type === 'IDLE') {
      this.sequencePlan = null;
      void this.resumeSpeaking(request);
      return;
    }
    if (!active) {
      this.sequencePlan = null;
      this.deferSpeakingUntilIdle = false;
      this.idleInterimStartedAt = null;
      if (this.active?.type !== 'IDLE') void this.transitionToIdle(request);
      return;
    }
    this.scheduleNextSequenceAction(source, request);
  }

  getDebugSnapshot(): AnimationSchedulerSnapshot {
    return {
      active: this.active
        ? {
            id: this.active.record.id,
            type: this.active.type,
            url: this.active.record.url,
          }
        : null,
      speakingActive: this.speakingActive,
      transition: this.transition
        ? {
            reason: this.transition.reason,
            to: this.transition.target?.record.url ?? 'rest-pose',
          }
        : null,
      weights: [...this.contributing].map((record) => ({
        actionTime: record.action.time,
        id: record.id,
        running: record.action.isRunning(),
        url: record.url,
        weight: record.action.getEffectiveWeight(),
      })),
    };
  }

  async request(request: AnimationScheduleRequest): Promise<void> {
    if (this.disposed) return;
    const key = requestKey(request);
    if (this.desired?.key === key) {
      this.desired.onComplete = request.onComplete;
      this.log('request-retained', {
        request: request.animationRequest,
        type: request.type,
      });
      return;
    }

    const previousType = this.active?.type ?? this.desired?.type ?? null;
    const epoch = ++this.epoch;
    const normalized: NormalizedRequest = {
      ...request,
      animationUrls: uniqueUrls(request.animationUrls),
      epoch,
      fallbackAnimationUrls: uniqueUrls(request.fallbackAnimationUrls),
      key,
    };
    this.desired = normalized;
    this.sequencePlan = null;
    this.completion = null;
    if (!this.isSpeakingRequest(normalized)) {
      this.deferSpeakingUntilIdle = false;
      this.idleInterimStartedAt = null;
    }
    this.resolvingEpoch = epoch;
    this.log('request', {
      animationUrls: normalized.animationUrls,
      fallbackAnimationUrls: normalized.fallbackAnimationUrls,
      playback: normalized.playback,
      request: normalized.animationRequest,
      type: normalized.type,
    });

    if (
      normalized.playback === 'loop' &&
      this.active?.type === normalized.type &&
      normalized.animationUrls.includes(this.active.record.url)
    ) {
      const retained = this.active.record;
      this.resolvingEpoch = null;
      this.preload(normalized.animationUrls);
      this.preload(normalized.fallbackAnimationUrls);
      this.log('request-retained-action', {
        type: normalized.type,
        url: retained.url,
      });
      if (this.isSpeakingRequest(normalized)) {
        this.scheduleNextSequenceAction(retained, normalized);
      }
      return;
    }

    if (
      this.isSpeakingRequest(normalized) &&
      !this.speakingActive &&
      this.active?.type === 'IDLE' &&
      normalized.fallbackAnimationUrls.includes(this.active.record.url)
    ) {
      this.resolvingEpoch = null;
      this.preload(normalized.animationUrls);
      this.preload(normalized.fallbackAnimationUrls);
      this.log('request-parked-on-idle', {
        url: this.active.record.url,
      });
      return;
    }

    let selection: TargetSelection | null = null;
    try {
      while (true) {
        const speakingRevision = this.speakingRevision;
        selection = await this.selectTarget(normalized);
        if (!this.isCurrent(epoch)) {
          this.log('load-discarded', { epoch, type: normalized.type });
          return;
        }
        if (
          !this.isSpeakingRequest(normalized) ||
          speakingRevision === this.speakingRevision
        ) {
          break;
        }
        this.log('target-selection-retried', {
          epoch,
          speakingActive: this.speakingActive,
        });
      }
    } catch (error) {
      if (!this.isCurrent(epoch)) {
        this.log('load-discarded', { epoch, type: normalized.type });
        return;
      }
      this.log('target-selection-failed', {
        epoch,
        error: error instanceof Error ? error.message : String(error),
        type: normalized.type,
      });
    } finally {
      if (this.resolvingEpoch === epoch) this.resolvingEpoch = null;
    }

    if (!selection) {
      this.log('request-empty', { type: normalized.type });
      this.startTransition(
        null,
        this.transitionTiming(previousType, normalized.type),
        'empty-request',
      );
      if (normalized.playback === 'once') normalized.onComplete?.();
      return;
    }

    const sequence = this.isSpeakingSequence(normalized) && !selection.fallback;
    const playback: AnimationPlayback = sequence
      ? 'once'
      : selection.fallback
        ? 'loop'
        : normalized.playback;
    const record = this.createAction(selection.loaded);
    const target = {
      playback,
      record,
      startTime: selection.startTime,
      type: selection.fallback ? 'IDLE' : normalized.type,
    } satisfies ActiveAction;
    if (!selection.fallback) {
      this.previousUrl.set(normalized.type, record.url);
      if (normalized.type === 'TALK') this.rememberSpeakingUrl(record.url);
    }
    this.startTransition(
      target,
      target.type === 'TALK'
        ? fitTransitionTiming(
            this.transitionTiming(previousType, normalized.type),
            Math.max(
              0,
              (target.record.clip.duration - target.startTime) *
                MAX_SEQUENCE_TRANSITION_FRACTION,
            ),
          )
        : this.transitionTiming(previousType, normalized.type),
      selection.fallback ? 'fallback-request' : 'request',
    );

    if (normalized.playback === 'once' && normalized.onComplete) {
      if (selection.fallback) {
        this.log('one-shot-fallback', { type: normalized.type });
        normalized.onComplete();
      } else {
        this.completion = {
          action: record.action,
          callback: normalized.onComplete,
          epoch,
        };
      }
    }
    if (sequence) {
      this.scheduleNextSequenceAction(record, normalized);
    }
    this.preload(normalized.animationUrls);
    this.preload(normalized.fallbackAnimationUrls);
  }

  update(delta: number): void {
    if (this.disposed) return;
    this.mixer.update(delta);
    this.applyTransition();
    this.updateSpeakingDebounce();
    this.updateIdleInterim();
    const plan = this.sequencePlan;
    if (
      plan &&
      !plan.started &&
      !this.transition &&
      this.speakingActive &&
      this.isCurrent(plan.epoch) &&
      this.mixer.time >= plan.startAtMixerTime
    ) {
      plan.started = true;
      this.log('sequence-due', {
        actionTime: plan.source.action.time,
        from: plan.source.url,
        next: plan.nextUrl,
      });
      void this.advanceSequence(plan);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.epoch += 1;
    this.mixer.removeEventListener('finished', this.handleFinished);
    for (const record of this.contributing) this.stopAction(record);
    this.mixer.stopAllAction();
    this.contributing.clear();
    this.active = null;
    this.transition = null;
    this.sequencePlan = null;
    this.completion = null;
    this.speakingSilenceStartedAt = null;
    this.deferSpeakingUntilIdle = false;
    this.idleInterimStartedAt = null;
    this.resolvingEpoch = null;
    this.clips.clear();
    this.readyClips.clear();
    this.log('disposed');
  }

  private readonly handleFinished = ({
    action,
  }: {
    action: THREE.AnimationAction;
  }): void => {
    const completion = this.completion;
    if (
      !completion ||
      completion.action !== action ||
      completion.epoch !== this.epoch
    ) {
      return;
    }
    this.completion = null;
    this.log('one-shot-complete', { url: this.active?.record.url });
    completion.callback();
  };

  private isCurrent(epoch: number): boolean {
    return !this.disposed && this.epoch === epoch;
  }

  private isSpeakingSequence(request: NormalizedRequest): boolean {
    return (
      this.isSpeakingRequest(request) &&
      request.animationUrls.length > 0
    );
  }

  private isSpeakingRequest(request: NormalizedRequest): boolean {
    return request.type === 'TALK' && request.playback === 'loop';
  }

  private transitionTiming(
    previousType: PlayableAnimationType | null,
    nextType: PlayableAnimationType,
  ): TransitionTiming {
    if (previousType === 'TALK' && nextType === 'TALK') {
      return speakingTransitionTiming(
        this.timing.speakingTransition,
        this.random,
      );
    }
    const previousIsExplicitAction =
      previousType != null &&
      previousType !== 'IDLE' &&
      previousType !== 'TALK';
    const nextIsExplicitAction = nextType !== 'IDLE' && nextType !== 'TALK';
    if (previousIsExplicitAction || nextIsExplicitAction) {
      return speakingTransitionTiming(
        this.timing.speakingTransition,
        this.random,
      );
    }
    return bodyTransitionTiming(this.timing.bodyTransitionMs);
  }

  private async selectTarget(
    request: NormalizedRequest,
  ): Promise<TargetSelection | null> {
    const sources = this.currentMotionSources();
    if (this.isSpeakingRequest(request) && !this.speakingActive) {
      const idle = await this.loadCompatibleTarget(
        sources,
        request.fallbackAnimationUrls,
        { loopTarget: true },
      );
      return idle ? { ...idle, fallback: true } : null;
    }
    const primary =
      sources.length > 0 &&
      (request.type === 'TALK' || request.type === 'IDLE')
        ? await this.loadCompatibleTarget(
            sources,
            request.animationUrls,
            {
              loopTarget: request.type === 'IDLE',
              preferReady: request.type === 'TALK',
              recentUrls:
                request.type === 'TALK' ? [...this.recentSpeakingUrls] : [],
              sampleEntry: request.type === 'TALK',
            },
          )
        : await this.loadFirstTarget(
            request.animationUrls,
            this.previousUrl.get(request.type) ?? null,
          );
    if (primary) return { ...primary, fallback: false };
    const fallback = await this.loadCompatibleTarget(
      sources,
      request.fallbackAnimationUrls,
      { loopTarget: true },
    );
    return fallback ? { ...fallback, fallback: true } : null;
  }

  private candidateOrder(
    urls: readonly string[],
    previous: string | null,
  ): string[] {
    const remaining = uniqueUrls(urls);
    const ordered: string[] = [];
    let excluded = previous;
    while (remaining.length > 0) {
      const next = randomAnimationUrl(remaining, excluded, this.random);
      if (!next) break;
      ordered.push(next);
      remaining.splice(remaining.indexOf(next), 1);
      excluded = null;
    }
    return ordered;
  }

  private async loadFirstAvailable(
    urls: readonly string[],
    previous: string | null,
  ): Promise<LoadedClip | null> {
    for (const url of this.candidateOrder(urls, previous)) {
      try {
        return await this.clipFor(url);
      } catch (error) {
        this.log('load-failed', {
          error: error instanceof Error ? error.message : String(error),
          url,
        });
      }
    }
    return null;
  }

  private async loadFirstTarget(
    urls: readonly string[],
    previous: string | null,
  ): Promise<SelectedTarget | null> {
    const loaded = await this.loadFirstAvailable(urls, previous);
    return loaded ? { loaded, ranking: null, startTime: 0 } : null;
  }

  private async loadCompatibleTarget(
    sources: readonly MotionClipSource[],
    urls: readonly string[],
    {
      loopTarget = false,
      preferReady = false,
      recentUrls = [],
      sampleEntry = false,
    }: {
      loopTarget?: boolean;
      preferReady?: boolean;
      recentUrls?: readonly string[];
      sampleEntry?: boolean;
    } = {},
  ): Promise<SelectedTarget | null> {
    if (sources.length === 0) return this.loadFirstTarget(urls, null);
    const candidateUrls = uniqueUrls(urls);
    let candidates: LoadedClip[];
    const ready = candidateUrls
      .map((url) => this.readyClips.get(url))
      .filter((candidate): candidate is LoadedClip => candidate != null);
    if (preferReady && ready.length > 0) {
      candidates = ready;
      this.preload(candidateUrls);
      this.log('motion-target-ready-set', {
        available: ready.length,
        requested: candidateUrls.length,
      });
    } else if (preferReady) {
      const first = await this.loadFirstResolved(candidateUrls);
      candidates = first ? [first] : [];
    } else {
      candidates = (
        await Promise.all(
          candidateUrls.map(async (url) => {
            try {
              return await this.clipFor(url);
            } catch (error) {
              this.log('load-failed', {
                error: error instanceof Error ? error.message : String(error),
                url,
              });
              return null;
            }
          }),
        )
      ).filter((candidate): candidate is LoadedClip => candidate != null);
    }
    if (candidates.length === 0) return null;
    const rankings = rankBlendedMotionTransitions(
      sources,
      candidates.map(({ clip, url }) => ({ clip, url })),
      {
        entrySampleSeconds: sampleEntry ? 0.3 : 0,
        loopTarget,
      },
    );
    const selected = sampleEntry
      ? selectVariedMotionTransition(rankings, recentUrls, this.random)
      : selectMotionTransition(rankings, recentUrls, this.random);
    if (!selected) return null;
    const loaded = candidates.find(({ url }) => url === selected.url);
    if (!loaded) return null;
    this.log('motion-target-selected', {
      from: sources.map(({ time, url, weight }) => ({
        time: Number(time.toFixed(4)),
        url,
        weight: Number(weight.toFixed(4)),
      })),
      loopTarget,
      ranking: rankings.slice(0, 5).map((ranking) => ({
        poseDistance: Number(ranking.poseDistance.toFixed(4)),
        score: Number(ranking.score.toFixed(4)),
        startTime: Number(ranking.startTime.toFixed(4)),
        url: ranking.url,
        velocityDistance: Number(ranking.velocityDistance.toFixed(4)),
      })),
      selected: selected.url,
      startTime: selected.startTime,
    });
    return { loaded, ranking: selected, startTime: selected.startTime };
  }

  private currentMotionSources(): MotionClipSource[] {
    this.applyTransition();
    return [...this.contributing]
      .map((record) => ({
        clip: record.clip,
        time: record.action.time,
        url: record.url,
        weight: Math.max(0, record.action.getEffectiveWeight()),
      }))
      .filter(({ weight }) => weight > WEIGHT_EPSILON);
  }

  private clipFor(url: string): Promise<LoadedClip> {
    const cached = this.clips.get(url);
    if (cached) return cached;
    this.log('load-started', { url });
    const pending = this.loadClip(url).then((clip) => {
      this.log('load-complete', { duration: clip.duration, url });
      const loaded = { clip, url };
      this.readyClips.set(url, loaded);
      return loaded;
    });
    pending.catch(() => {
      this.clips.delete(url);
      this.readyClips.delete(url);
    });
    this.clips.set(url, pending);
    return pending;
  }

  private createAction(loaded: LoadedClip): ActionRecord {
    const clip = loaded.clip.clone();
    return {
      action: this.mixer.clipAction(clip),
      clip,
      id: this.nextActionId++,
      url: loaded.url,
    };
  }

  private preload(urls: readonly string[]): void {
    for (const url of urls) void this.clipFor(url).catch(() => {});
  }

  private loadFirstResolved(urls: readonly string[]): Promise<LoadedClip | null> {
    const pending = uniqueUrls(urls).map((url) => this.clipFor(url));
    if (pending.length === 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      let failures = 0;
      let settled = false;
      for (const candidate of pending) {
        void candidate.then(
          (loaded) => {
            if (settled) return;
            settled = true;
            resolve(loaded);
          },
          (error: unknown) => {
            failures += 1;
            this.log('load-failed', {
              error: error instanceof Error ? error.message : String(error),
            });
            if (!settled && failures === pending.length) {
              settled = true;
              resolve(null);
            }
          },
        );
      }
    });
  }

  private configureAction(
    target: ActiveAction,
    preserveTime: boolean,
  ): void {
    const action = target.record.action;
    action.stopFading();
    if (!preserveTime) {
      action.reset();
      action.time = Math.min(
        target.record.clip.duration,
        Math.max(0, target.startTime),
      );
    }
    if (target.playback === 'once') {
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
    } else {
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
    }
    action.enabled = true;
    action.setEffectiveTimeScale(1);
    action.play();
  }

  private stopAction(record: ActionRecord): void {
    record.action.stop();
    this.mixer.uncacheClip(record.clip);
  }

  private captureWeights(): Map<ActionRecord, number> {
    this.applyTransition();
    const weights = new Map<ActionRecord, number>();
    let total = 0;
    for (const record of this.contributing) {
      const weight = Math.max(0, record.action.getEffectiveWeight());
      if (weight <= WEIGHT_EPSILON) continue;
      weights.set(record, weight);
      total += weight;
    }
    if (total > 1 + WEIGHT_EPSILON) {
      for (const [record, weight] of weights) {
        weights.set(record, weight / total);
      }
    }
    return weights;
  }

  private startTransition(
    target: ActiveAction | null,
    timing: TransitionTiming,
    reason: string,
  ): void {
    const sources = this.captureWeights();
    const replacing = this.transition != null;
    for (const record of sources.keys()) {
      record.action.setEffectiveTimeScale(1);
    }
    const targetWeight = target ? (sources.get(target.record) ?? 0) : 0;
    if (target) {
      this.configureAction(target, targetWeight > WEIGHT_EPSILON);
      this.contributing.add(target.record);
      target.record.action.setEffectiveWeight(targetWeight);
    }
    for (const record of this.contributing) {
      if (!sources.has(record) && record !== target?.record) {
        this.stopAction(record);
        this.contributing.delete(record);
      }
    }

    this.active = target;
    this.transition = {
      entry: timing.entry,
      exit: timing.exit,
      reason,
      sources,
      startedAt: this.mixer.time,
      target,
      total: timing.total,
    };
    this.log(replacing ? 'transition-retargeted' : 'transition-started', {
      duration: timing.total,
      entry: timing.entry,
      exit: timing.exit,
      from: [...sources].map(([record, weight]) => ({
        actionTime: record.action.time,
        id: record.id,
        url: record.url,
        weight,
      })),
      reason,
      targetActionId: target?.record.id ?? null,
      to: target?.record.url ?? 'rest-pose',
    });
    this.applyTransition();
  }

  private applyTransition(): void {
    const transition = this.transition;
    if (!transition) return;
    const progress = transitionProgress(
      this.mixer.time - transition.startedAt,
      transition,
    );
    const targetRecord = transition.target?.record ?? null;
    const targetStart = targetRecord
      ? (transition.sources.get(targetRecord) ?? 0)
      : 0;
    for (const [record, startWeight] of transition.sources) {
      if (record === targetRecord) continue;
      record.action.setEffectiveWeight(startWeight * (1 - progress));
    }
    if (targetRecord) {
      targetRecord.action.setEffectiveWeight(
        targetStart + (1 - targetStart) * progress,
      );
    }
    if (progress < 1) return;

    for (const record of this.contributing) {
      if (record === targetRecord) continue;
      this.stopAction(record);
    }
    this.contributing.clear();
    if (targetRecord) {
      targetRecord.action.setEffectiveTimeScale(1);
      targetRecord.action.setEffectiveWeight(1);
      this.contributing.add(targetRecord);
    }
    this.transition = null;
    this.log('transition-complete', {
      reason: transition.reason,
      to: targetRecord?.url ?? 'rest-pose',
    });
    if (
      transition.reason === 'speaking-gap' &&
      this.deferSpeakingUntilIdle &&
      this.speakingActive
    ) {
      this.idleInterimStartedAt = this.mixer.time;
      this.log('idle-interim-started', {
        durationMs: this.timing.idleInterimMs,
      });
    }
  }

  private scheduleNextSequenceAction(
    source: ActionRecord,
    request: NormalizedRequest,
  ): void {
    if (
      !this.isCurrent(request.epoch) ||
      !this.isSpeakingRequest(request) ||
      !this.speakingActive ||
      !this.isSpeakingSequence(request)
    ) {
      this.sequencePlan = null;
      return;
    }
    const requestedTiming = speakingTransitionTiming(
      this.timing.speakingTransition,
      this.random,
    );
    const remainingDuration = Math.max(
      0,
      source.clip.duration - source.action.time,
    );
    const timing = fitTransitionTiming(
      requestedTiming,
      remainingDuration * MAX_SEQUENCE_TRANSITION_FRACTION,
    );
    const candidates = request.animationUrls.length > 1
      ? request.animationUrls.filter((url) => url !== source.url)
      : request.animationUrls;
    const startAtActionTime = nextSequenceTransitionTime(
      source.clip.duration,
      timing.total,
    );
    const recentUrls = [...this.recentSpeakingUrls];
    const boundaryDelay = Math.max(
      0,
      startAtActionTime - source.action.time,
    );
    const naturalStartAtMixerTime = this.mixer.time + boundaryDelay;
    const incomingTransitionEnd =
      this.transition?.target?.record === source
        ? this.transition.startedAt + this.transition.total
        : this.mixer.time;
    const minimumFullWeightSeconds =
      remainingDuration * MINIMUM_FULL_WEIGHT_FRACTION;
    const selectNext = () =>
      this.loadCompatibleTarget(
        [{
          clip: source.clip,
          time: startAtActionTime,
          url: source.url,
          weight: 1,
        }],
        candidates,
        {
          recentUrls,
          sampleEntry: true,
        },
      );
    const plan: SequencePlan = {
      epoch: request.epoch,
      nextUrl: null,
      playback: 'once',
      selectNext,
      selection: selectNext(),
      source,
      startAtActionTime,
      startAtMixerTime: Math.max(
        naturalStartAtMixerTime,
        incomingTransitionEnd + minimumFullWeightSeconds,
      ),
      started: false,
      timing,
      type: 'TALK',
    };
    this.sequencePlan = plan;
    this.preload(candidates);
    this.log('sequence-scheduled', {
      candidateCount: candidates.length,
      duration: timing.total,
      from: source.url,
      nextType: plan.type,
      startAtActionTime: plan.startAtActionTime,
      startAtMixerTime: plan.startAtMixerTime,
    });
    if (plan.selection) {
      void plan.selection.then(
        (selection) => {
          if (this.sequencePlan !== plan || !this.isCurrent(plan.epoch)) return;
          this.log('sequence-target-prepared', {
            from: source.url,
            next: selection?.loaded.url ?? null,
            startAtMixerTime: plan.startAtMixerTime,
          });
        },
        (error: unknown) => {
          if (this.sequencePlan !== plan || !this.isCurrent(plan.epoch)) return;
          this.log('sequence-selection-failed', {
            error: error instanceof Error ? error.message : String(error),
            from: source.url,
            type: plan.type,
          });
        },
      );
    }
  }

  private async advanceSequence(plan: SequencePlan): Promise<void> {
    let selection: SelectedTarget | null = null;
    try {
      selection = await (plan.selection ?? plan.selectNext());
    } catch (error) {
      this.log('sequence-selection-failed', {
        error: error instanceof Error ? error.message : String(error),
        from: plan.source.url,
        type: plan.type,
      });
    }
    plan.nextUrl = selection?.loaded.url ?? null;
    const request = this.desired;
    if (
      !request ||
      !this.isCurrent(plan.epoch) ||
      this.sequencePlan !== plan ||
      !this.isSpeakingRequest(request) ||
      !this.speakingActive
    ) {
      this.log('sequence-discarded', {
        from: plan.source.url,
        next: plan.nextUrl,
      });
      return;
    }
    this.log('sequence-advancing', {
      from: plan.source.url,
      to: selection?.loaded.url ?? 'rest-pose',
      type: plan.type,
    });
    const target = selection ? this.createAction(selection.loaded) : null;
    const transitionTiming =
      selection && plan.type === 'TALK'
        ? fitTransitionTiming(
            plan.timing,
            Math.max(
              0,
              (selection.loaded.clip.duration - selection.startTime) *
                MAX_SEQUENCE_TRANSITION_FRACTION,
            ),
          )
        : plan.timing;
    this.startTransition(
      selection && target
        ? {
            playback: plan.playback,
            record: target,
            startTime: selection.startTime,
            type: plan.type,
          }
        : null,
      transitionTiming,
      'speaking-sequence',
    );
    if (
      target &&
      plan.type === 'TALK' &&
      this.isSpeakingSequence(request)
    ) {
      this.previousUrl.set('TALK', target.url);
      this.rememberSpeakingUrl(target.url);
      this.scheduleNextSequenceAction(target, request);
    }
  }

  private updateSpeakingDebounce(): void {
    const startedAt = this.speakingSilenceStartedAt;
    if (
      startedAt == null ||
      this.rawSpeakingActive ||
      !this.speakingActive
    ) {
      return;
    }
    const elapsedMs = (this.mixer.time - startedAt) * 1000;
    if (elapsedMs < this.timing.speakingDebounceMs) return;
    this.speakingSilenceStartedAt = null;
    this.log('speaking-release-committed', {
      elapsedMs: Number(elapsedMs.toFixed(1)),
    });
    this.commitSpeakingActive(false);
  }

  private updateIdleInterim(): void {
    const startedAt = this.idleInterimStartedAt;
    if (startedAt == null) return;
    if (!this.deferSpeakingUntilIdle || !this.speakingActive) {
      this.idleInterimStartedAt = null;
      return;
    }
    const elapsedMs = (this.mixer.time - startedAt) * 1000;
    if (elapsedMs < this.timing.idleInterimMs) return;
    this.idleInterimStartedAt = null;
    this.deferSpeakingUntilIdle = false;
    this.log('idle-interim-complete', {
      elapsedMs: Number(elapsedMs.toFixed(1)),
    });
    const request = this.desired;
    if (request && this.isSpeakingRequest(request)) {
      void this.resumeSpeaking(request);
    }
  }

  private async transitionToIdle(request: NormalizedRequest): Promise<void> {
    let selection: SelectedTarget | null = null;
    try {
      selection = await this.loadCompatibleTarget(
        this.currentMotionSources(),
        request.fallbackAnimationUrls,
        { loopTarget: true },
      );
    } catch (error) {
      this.log('idle-transition-selection-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!this.isCurrent(request.epoch) || this.speakingActive) {
      this.log('idle-transition-discarded', {
        target: selection?.loaded.url ?? null,
      });
      return;
    }
    const record = selection ? this.createAction(selection.loaded) : null;
    this.startTransition(
      record
        ? {
            playback: 'loop',
            record,
            startTime: selection?.startTime ?? 0,
            type: 'IDLE',
          }
        : null,
      bodyTransitionTiming(this.timing.bodyTransitionMs),
      'speaking-gap',
    );
  }

  private async resumeSpeaking(request: NormalizedRequest): Promise<void> {
    let selection: SelectedTarget | null = null;
    try {
      selection = await this.loadCompatibleTarget(
        this.currentMotionSources(),
        request.animationUrls,
        {
          preferReady: true,
          recentUrls: [...this.recentSpeakingUrls],
          sampleEntry: true,
        },
      );
    } catch (error) {
      this.log('speaking-resume-failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (!selection || !this.isCurrent(request.epoch) || !this.speakingActive) {
      this.log('speaking-resume-discarded', {
        target: selection?.loaded.url ?? null,
      });
      return;
    }
    const target = this.createAction(selection.loaded);
    this.previousUrl.set('TALK', target.url);
    this.rememberSpeakingUrl(target.url);
    const playback = this.isSpeakingSequence(request) ? 'once' : 'loop';
    this.startTransition(
      { playback, record: target, startTime: selection.startTime, type: 'TALK' },
      fitTransitionTiming(
        this.transitionTiming(this.active?.type ?? null, 'TALK'),
        Math.max(
          0,
          (selection.loaded.clip.duration - selection.startTime) *
            MAX_SEQUENCE_TRANSITION_FRACTION,
        ),
      ),
      'speaking-resume',
    );
    if (this.isSpeakingSequence(request)) {
      this.scheduleNextSequenceAction(target, request);
    }
  }

  private rememberSpeakingUrl(url: string): void {
    this.recentSpeakingUrls.push(url);
    if (this.recentSpeakingUrls.length > 6) this.recentSpeakingUrls.shift();
  }

  private log(event: string, values: Record<string, unknown> = {}): void {
    this.debug?.({
      event,
      time: Number(this.mixer.time.toFixed(4)),
      ...values,
    });
  }
}
