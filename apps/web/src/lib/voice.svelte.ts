import type {
  VoiceIceResponse,
  VoiceRoomResponse,
  VoiceRoomsResponse,
  VoiceSignalPayload,
  VoiceState,
  VoiceStateUpdatePayload,
} from '@harmony/shared';
import { VOICE_MAX_RECOVER_ATTEMPTS, VOICE_RECOVER_DELAY_MS, VOICE_RECOVER_GRACE_MS } from '@harmony/shared';
import { api } from './api';
import { meta } from './meta.svelte';
import { session } from './session.svelte';
import { playSound } from './sounds';
import { clampVolume, parseVolumes, serializeVolumes, VOICE_VOLUME_DEFAULT } from './voice-volume';
import { webVoiceDisabled } from './voice-mode';

/**
 * The client's voice session. All audio is handled here in the browser: the
 * microphone is captured with echo cancellation, noise suppression and gain
 * control, encoded by the browser's own WebRTC stack, and played back from the
 * relay. The server never sees audio, so apart from the UI this file is the whole
 * client side of a call.
 *
 * The server is the only party that offers. This side answers every offer it is
 * sent, so a renegotiation (someone joining or leaving the room) is just
 * answering again; there is nothing to coordinate.
 *
 * Each relayed track carries its producer's member id as the stream id, so a
 * track can be matched to the member it belongs to — that is what a speaking
 * indicator needs.
 */

/** Root-mean-square above which a track counts as someone talking. */
const speakingLevel = 0.015;
/** How often the speaking indicators are recomputed. */
const speakingPollMs = 120;

/**
 * Turns a failed join into something worth reading. A DOMException name is
 * meaningless to anyone who is not a browser engineer, and the microphone ones
 * have a fix (a permission toggle) a message should name.
 */
function describeFailure(cause: unknown): string {
  if (cause instanceof DOMException) {
    switch (cause.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return 'Microphone access was blocked. Allow the microphone for this site, then try again.';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return 'No microphone was found on this device.';
      case 'NotReadableError':
        return 'The microphone is in use by another app on this device.';
      default:
        return cause.message || cause.name;
    }
  }
  return cause instanceof Error ? cause.message : String(cause);
}

interface RemoteAudio {
  /** The element that actually pulls and decodes the remote track. */
  element: HTMLAudioElement;
  source: MediaElementAudioSourceNode;
  analyser: AnalyserNode;
  gain: GainNode;
}

/** One shared screen as the UI sees it: whose it is, and whether we watch it. */
export interface ScreenTile {
  userId: string;
  name: string;
  /** Whether this client has opted in to watch the stream. */
  watching: boolean;
  /** The picture, once the relay has actually delivered one. */
  stream: MediaStream | null;
}

/** How long a resume waits before re-checking whether the call is still ours to take. */
const resumeRetryMs = 700;
/** How many times a resume re-checks before it leaves a live session alone. */
const maxResumeTries = 6;

/** Where the channel a member is in is remembered, so a reloaded client can rejoin it. */
const savedChannelPrefix = 'harmony:voice:';

/**
 * The channel this member was in, from the last session. localStorage rather than
 * sessionStorage: a phone recreates the webview when it reopens the app, which is
 * a fresh page load, so anything kept only for the tab is already gone.
 */
function readSavedChannel(userId: string | undefined): string | null {
  if (!userId) return null;
  try {
    return localStorage.getItem(savedChannelPrefix + userId);
  } catch {
    return null;
  }
}

function writeSavedChannel(userId: string | undefined, channelId: string | null): void {
  if (!userId) return;
  try {
    if (channelId) localStorage.setItem(savedChannelPrefix + userId, channelId);
    else localStorage.removeItem(savedChannelPrefix + userId);
  } catch {
    // Storage blocked: the call just will not survive a reload.
  }
}

/**
 * Where per-member playback volumes are remembered, keyed by the listener so
 * two accounts in one browser each keep their own set. The rules for what a
 * volume may be, and how the stored map is read and written, live in
 * voice-volume.ts so they can be checked without a browser.
 */
const volumesStoragePrefix = 'harmony:voice-volumes:';

function readSavedVolumes(userId: string): Record<string, number> {
  try {
    return parseVolumes(localStorage.getItem(volumesStoragePrefix + userId));
  } catch {
    // Storage blocked: there is nothing remembered to read.
    return {};
  }
}

function writeSavedVolumes(userId: string, volumes: Record<string, number>): void {
  if (!userId) return;
  try {
    const raw = serializeVolumes(volumes);
    // Nothing adjusted means nothing to remember, so a cleared room leaves no key.
    if (raw === null) localStorage.removeItem(volumesStoragePrefix + userId);
    else localStorage.setItem(volumesStoragePrefix + userId, raw);
  } catch {
    // Storage blocked: the volumes just will not survive a reload.
  }
}

class VoiceStore {
  /** The channel this member is connected to, or null. */
  channelId = $state<string | null>(null);
  /** Everyone in the channel this member is in. */
  members = $state<VoiceState[]>([]);
  /** Rosters for other channels, so the sidebar can show who is where. */
  rosters = $state<Record<string, VoiceState[]>>({});
  /** Member ids currently talking, for the speaking indicators. */
  speaking = $state<Record<string, boolean>>({});
  connecting = $state(false);
  /** The channel a join is working on, so its row can show that it is trying. */
  joining = $state<string | null>(null);
  muted = $state(false);
  deafened = $state(false);
  error = $state<string | null>(null);
  /** The connection's own state, so a dropped call reads as more than silence. */
  connectionState = $state<RTCPeerConnectionState | null>(null);
  /**
   * Whether audio is actually moving, sampled from getStats(). A call can be
   * "connected" and still carry nothing, which between two different networks is
   * the usual failure, so the bar says so rather than pretending all is well.
   */
  sending = $state(false);
  receiving = $state(false);
  /** Whether this member is sharing their screen right now. */
  sharing = $state(false);
  /**
   * Per-member playback gain, only for the members this client adjusted. It is
   * local: it never reaches the server and never changes anyone else's audio.
   * Read it through volumeFor, which supplies the default for the rest.
   */
  volumes = $state<Record<string, number>>({});

  #pc: RTCPeerConnection | null = null;
  #mic: MediaStream | null = null;
  #ctx: AudioContext | null = null;
  /** Everything remote is played through this, so deafening is one gain. */
  #master: GainNode | null = null;
  #remote = new Map<string, RemoteAudio>();
  /** One analyser per speaker, the local microphone included. */
  #analysers = new Map<string, AnalyserNode>();
  #pollTimer: ReturnType<typeof setInterval> | null = null;
  /** Samples RTP counters, to tell a live call from a merely connected one. */
  #statsTimer: ReturnType<typeof setInterval> | null = null;
  #inBytes = 0;
  #outBytes = 0;
  /** The member's own screen capture, while it is being shared. */
  #display: MediaStream | null = null;
  #screenSender: RTCRtpSender | null = null;
  /** Pictures received for each member, whether or not they still share. */
  #receivedScreens = $state<Record<string, MediaStream>>({});
  /** Members whose screens this client has opted in to watch. */
  #watching = $state<Record<string, boolean>>({});
  /** The account the loaded volumes belong to, so a different login reloads them. */
  #volumesOwner: string | null = null;
  /** What a member played at before the menu muted them, so unmuting restores it. */
  #mutedFrom = new Map<string, number>();
  /** The member ids in the room on the last roster, for the join/leave sounds. */
  #lastMembers = new Set<string>();
  #rosterReady = false;
  /** ICE servers from the server, cached until the credentials they carry expire. */
  #ice: { servers: RTCIceServer[]; expiresAt: number } | null = null;
  /** An offer that arrived before the connection was ready to answer it. */
  #offer: string | null = null;
  /** The channel the member wants to be in, kept across a dropped connection. */
  #intended: string | null = null;
  #recovering = false;
  #recoverTimer: ReturnType<typeof setTimeout> | null = null;
  #recoverAttempts = 0;
  /** Retries while the server still shows another session holding the call. */
  #resumeTimer: ReturnType<typeof setTimeout> | null = null;
  #resumeTries = 0;
  /** Guards against a visibility and an online event resuming at once. */
  #resuming = false;

  constructor() {
    // A phone that lost its network is most likely back when the browser says it
    // is, well before any retry timer would notice.
    window.addEventListener('online', () => {
      if (this.#intended && this.#pc?.connectionState !== 'connected') this.#scheduleRecover(0);
      // A page that loaded while offline could not fetch the rooms to rejoin;
      // coming back online is the first chance to.
      else if (!this.channelId) void this.resume();
    });
    // Coming back to the foreground is the cue that a backgrounded client may have
    // lost its call, or that a recreated one needs to rejoin the channel it was in.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void this.resume();
    });
  }

  /** Handles the voice gateway frames; `chat` forwards them here. */
  handleFrame(frame: { t?: string; d?: unknown }): void {
    if (frame.t === 'VOICE_STATE_UPDATE') {
      const payload = frame.d as VoiceStateUpdatePayload;
      this.rosters = { ...this.rosters, [payload.channelId]: payload.members };
      if (payload.channelId === this.channelId) {
        this.members = payload.members;
        this.#applyRoster(payload.members);
      }
    } else if (frame.t === 'VOICE_SIGNAL') {
      const payload = frame.d as VoiceSignalPayload;
      if (payload.channelId === this.channelId) void this.#answer(payload.sdp);
    }
  }

  /** Plays a chime when a member other than you joins or leaves the room. */
  #applyRoster(members: VoiceState[]): void {
    const ids = new Set(members.map((entry) => entry.user.id));
    const me = session.user?.id ?? null;
    // The first roster after joining is the baseline: the people already there
    // did not just arrive, so nothing is announced for them.
    if (this.#rosterReady) {
      const joined = [...ids].some((id) => id !== me && !this.#lastMembers.has(id));
      const left = [...this.#lastMembers].some((id) => id !== me && !ids.has(id));
      if (joined) playSound('voiceConnect');
      if (left) playSound('voiceDisconnect');
    }
    this.#lastMembers = ids;
    this.#rosterReady = true;
  }

  /**
   * Fetches who is in each voice channel now, and rejoins the call this member
   * was in. Called once on load, since the per-channel events only arrive as
   * changes are made; without it a client that loads while somebody is already
   * talking would show an empty room.
   */
  async load(): Promise<void> {
    this.#ensureVolumes();
    const data = await this.#fetchRooms();
    if (data) await this.#resumeWith(data);
  }

  /**
   * Puts this member back in the call they were in before the client went away.
   *
   * A phone that leaves and reopens the app is a fresh webview, so nothing in
   * memory survives; the channel they were in is remembered in localStorage and
   * this restores it. When the server still lists them, the rejoin reattaches the
   * media; when it no longer does, this rejoins the remembered channel afresh.
   * Called on load, on returning to the foreground, and after the online handler.
   */
  async resume(): Promise<void> {
    if (this.#resuming || this.joining) return;
    // Already in a call in this session: make sure it is really still alive, the
    // same way a connection-state change would, rather than rebuild a healthy one.
    if (this.channelId) {
      if (this.#pc) this.#onConnectionState(this.#pc.connectionState);
      return;
    }
    this.#resuming = true;
    try {
      const data = await this.#fetchRooms();
      if (data) await this.#resumeWith(data);
    } finally {
      this.#resuming = false;
    }
  }

  /** The rosters plus self, or null when the request fails (offline, signed out). */
  async #fetchRooms(): Promise<VoiceRoomsResponse | null> {
    try {
      const data = await api<VoiceRoomsResponse>('/voice');
      const rosters: Record<string, VoiceState[]> = {};
      for (const entry of data.channels) rosters[entry.channelId] = entry.members;
      this.rosters = rosters;
      return data;
    } catch {
      // A failed load leaves the sidebar without rosters until the next event.
      return null;
    }
  }

  /**
   * Decides whether to rejoin, from a fresh room snapshot. The server's own
   * record wins when there is one; the remembered channel is the fallback for a
   * member it has already dropped. A live connection held by another session is
   * left alone, but re-checked briefly, which also covers the moment the server
   * notices this one went away and marks the membership detached.
   */
  async #resumeWith(data: VoiceRoomsResponse): Promise<void> {
    // The host owns voice: keep the rosters (already set) but never rejoin.
    if (webVoiceDisabled()) return;
    if (this.channelId || this.joining) return;
    const saved = readSavedChannel(session.user?.id);
    const self = data.self;
    // The server's record wins when there is one; the remembered channel is the
    // fallback for a member it has already dropped from the room.
    const target = self?.channelId ?? saved;
    if (!target) return;
    if (self && !self.detached) {
      // Another session holds the connection, or the server has not yet noticed
      // this one went away. Only wait our turn when this client had joined that
      // channel (a recreated page racing the server); a fresh tab leaves it alone.
      if (saved === target) this.#scheduleResumeRetry();
      return;
    }
    this.#cancelResumeRetry();
    this.#resumeTries = 0;
    await this.join(target);
    // A channel that is gone, or one this member can no longer reach, leaves no
    // membership behind; forget it rather than retrying on every resume.
    if (this.channelId !== target) this.#forget();
  }

  #scheduleResumeRetry(): void {
    if (this.#resumeTimer || this.#resumeTries >= maxResumeTries) return;
    this.#resumeTries += 1;
    this.#resumeTimer = setTimeout(() => {
      this.#resumeTimer = null;
      void this.resume();
    }, resumeRetryMs);
  }

  #cancelResumeRetry(): void {
    if (this.#resumeTimer) {
      clearTimeout(this.#resumeTimer);
      this.#resumeTimer = null;
    }
  }

  /** Remembers the channel, so a recreated client knows which call to rejoin. */
  #remember(channelId: string): void {
    writeSavedChannel(session.user?.id, channelId);
  }

  /** Forgets it, on an explicit leave, a logout, or a rejoin that could not land. */
  #forget(): void {
    writeSavedChannel(session.user?.id, null);
  }

  /**
   * The ICE servers to reach the relay through, fetched from the server and cached
   * until its credentials expire. An instance with nothing configured — the common
   * case on a host with a public IP — returns an empty list, and a failed fetch
   * falls back to whatever was cached before, or to none at all.
   */
  async #iceServers(): Promise<RTCIceServer[]> {
    if (this.#ice && this.#ice.expiresAt > Date.now()) return this.#ice.servers;
    try {
      const data = await api<VoiceIceResponse>('/voice/ice');
      this.#ice = {
        servers: data.iceServers,
        expiresAt: Date.now() + Math.max(0, data.ttlSeconds) * 1000,
      };
      return this.#ice.servers;
    } catch {
      return this.#ice?.servers ?? [];
    }
  }

  /** Answers a server offer. Buffered if the connection is not up yet. */
  async #answer(sdp: string): Promise<void> {
    const pc = this.#pc;
    if (!pc) {
      this.#offer = sdp;
      return;
    }
    const channelId = this.channelId;
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      // The server offers this member's own screen line receive-only, and the
      // first video line in the offer is that one. Left at the browser's default
      // the line negotiates inactive, so a screen attached later would go nowhere;
      // send-only is what makes a later replaceTrack flow without renegotiation.
      const screen = pc.getTransceivers().find((entry) => entry.receiver.track?.kind === 'video');
      if (screen && screen.direction === 'recvonly') screen.direction = 'sendonly';
      await pc.setLocalDescription(await pc.createAnswer());
      if (channelId && pc.localDescription) {
        await api(`/channels/${channelId}/voice/answer`, {
          method: 'POST',
          body: JSON.stringify({ sdp: pc.localDescription.sdp }),
        });
      }
    } catch (cause) {
      this.error = describeFailure(cause);
    }
  }

  /**
   * Wires one incoming stream up for playback and for the speaking indicator.
   *
   * Playback has to run through a media element. A Web Audio
   * MediaStreamAudioSourceNode pulls a local microphone without complaint, but
   * Chromium will not pull a remote WebRTC track through one: the connection
   * reports the packets received and then discards them, so the call is silent
   * and the meter never moves, while Firefox plays the same stream. A media
   * element does pull the track, so the audio goes through a hidden one and Web
   * Audio taps it with createMediaElementSource, which also feeds the analyser.
   */
  #attachRemote(userId: string, stream: MediaStream): void {
    const ctx = this.#ctx;
    const master = this.#master;
    if (!ctx || !master || this.#remote.has(userId)) return;
    const element = document.createElement('audio');
    element.autoplay = true;
    element.srcObject = stream;
    element.style.display = 'none';
    document.body.appendChild(element);
    void element.play().catch(() => undefined);
    const source = ctx.createMediaElementSource(element);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    const gain = ctx.createGain();
    // The member's remembered volume is applied as the line is wired, so a
    // stream that appears after an adjustment still plays at the chosen level.
    gain.gain.value = this.volumeFor(userId);
    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(master);
    this.#remote.set(userId, { element, source, analyser, gain });
    this.#analysers.set(userId, analyser);
  }

  /** Root-mean-square of one analyser's current window. */
  #level(analyser: AnalyserNode): number {
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const value of data) sum += value * value;
    return Math.sqrt(sum / data.length);
  }

  /**
   * Reads the connection's RTP counters to see whether audio is flowing. The
   * counters only ever climb, so a sample that is higher than the last one means
   * packets moved in that direction since then. Silence suppresses them to
   * nearly nothing, which is fine: this is about a dead path, not a quiet one.
   */
  async #sample(): Promise<void> {
    const pc = this.#pc;
    if (!pc) return;
    let inbound: number | null = null;
    let outbound: number | null = null;
    try {
      const report = await pc.getStats();
      report.forEach((entry) => {
        const stat = entry as RTCStats & { kind?: string; bytesReceived?: number; bytesSent?: number };
        if (stat.kind !== 'audio') return;
        if (stat.type === 'inbound-rtp') inbound = (inbound ?? 0) + (stat.bytesReceived ?? 0);
        else if (stat.type === 'outbound-rtp') outbound = (outbound ?? 0) + (stat.bytesSent ?? 0);
      });
    } catch {
      return;
    }
    this.sending = outbound !== null && outbound > this.#outBytes;
    this.receiving = inbound !== null && inbound > this.#inBytes;
    if (inbound !== null) this.#inBytes = inbound;
    if (outbound !== null) this.#outBytes = outbound;
  }

  /** Recomputes who is talking, and only touches state when it changes. */
  #poll(): void {
    const next: Record<string, boolean> = {};
    for (const [userId, analyser] of this.#analysers) {
      if (this.#level(analyser) > speakingLevel) next[userId] = true;
    }
    if (JSON.stringify(next) !== JSON.stringify(this.speaking)) this.speaking = next;
  }

  /** Tears down the audio graph, the meter, and the microphone. */
  #teardown(): void {
    if (this.#pollTimer) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = null;
    }
    if (this.#statsTimer) {
      clearInterval(this.#statsTimer);
      this.#statsTimer = null;
    }
    for (const node of this.#remote.values()) {
      node.source.disconnect();
      node.analyser.disconnect();
      node.gain.disconnect();
      node.element.srcObject = null;
      node.element.remove();
    }
    this.#remote.clear();
    this.#analysers.clear();
    this.speaking = {};
    this.#master?.disconnect();
    this.#master = null;
    for (const track of this.#mic?.getTracks() ?? []) track.stop();
    this.#mic = null;
    this.#lastMembers = new Set();
    this.#rosterReady = false;
    this.connectionState = null;
    this.sending = false;
    this.receiving = false;
    this.#inBytes = 0;
    this.#outBytes = 0;
  }

  /** Joins a channel, or moves there from another one. */
  async join(channelId: string): Promise<void> {
    this.#ensureVolumes();
    // The host app runs voice itself (native), so the web client must not take
    // the microphone. The rosters stay visible; joining does not.
    if (webVoiceDisabled()) return;
    if (this.channelId === channelId || this.joining) return;
    this.#intended = channelId;
    this.#recoverAttempts = 0;
    this.#cancelRecover();
    await this.#establish(channelId);
  }

  /** The join handshake. It leaves the intended channel alone for recovery. */
  async #establish(channelId: string): Promise<void> {
    /*
     * The audio context is made and resumed here, inside the click that started
     * this, before anything is awaited. iOS only lets a context start from a
     * gesture, and the microphone prompt is a dialog the gesture does not
     * survive, so a context created after it comes up suspended and never plays
     * a packet.
     */
    const ctx = this.#ctx ?? new AudioContext();
    this.#ctx = ctx;
    void ctx.resume().catch(() => undefined);
    await this.#disconnect();
    this.connecting = true;
    this.joining = channelId;
    this.error = null;
    try {
      // A phone on a plain-HTTP address, or a browser that never exposes the
      // microphone, has no mediaDevices at all; say so rather than crashing on
      // a property of undefined.
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error('This browser cannot reach the microphone. Voice needs HTTPS or localhost.');
      }
      const mic = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      this.#mic = mic;

      // Everything remote plays through the master gain, so deafening is one
      // change; the local microphone runs through an analyser only, into a silent
      // sink so the meter is pulled without echoing you back.
      const master = ctx.createGain();
      master.gain.value = this.deafened ? 0 : 1;
      master.connect(ctx.destination);
      this.#master = master;
      const micAnalyser = ctx.createAnalyser();
      micAnalyser.fftSize = 512;
      const silent = ctx.createGain();
      silent.gain.value = 0;
      const micSource = ctx.createMediaStreamSource(mic);
      micSource.connect(micAnalyser);
      micAnalyser.connect(silent);
      silent.connect(ctx.destination);
      const me = session.user?.id;
      if (me) this.#analysers.set(me, micAnalyser);
      this.#pollTimer = setInterval(() => this.#poll(), speakingPollMs);

      this.#inBytes = 0;
      this.#outBytes = 0;
      this.#statsTimer = setInterval(() => void this.#sample(), 1000);

      const pc = new RTCPeerConnection({ iceServers: await this.#iceServers() });
      this.#pc = pc;
      pc.onconnectionstatechange = () => {
        this.connectionState = pc.connectionState;
        this.#onConnectionState(pc.connectionState);
      };
      pc.ontrack = (event) => {
        // The relay names each track's producer in its stream id, which is the
        // member the media belongs to.
        const userId = event.streams[0]?.id ?? 'unknown';
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        if (event.track.kind === 'video') this.#attachScreen(userId, stream, event.track);
        else this.#attachRemote(userId, stream);
      };
      for (const track of mic.getTracks()) pc.addTrack(track, mic);

      // The id is set before the request so an offer that races the response is
      // still recognised as ours and answered.
      this.channelId = channelId;
      const room = await api<VoiceRoomResponse>(`/channels/${channelId}/voice`, { method: 'POST' });
      this.members = room.members;
      this.rosters = { ...this.rosters, [channelId]: room.members };
      // The join landed, so remember the channel: a recreated client rejoins it.
      this.#remember(channelId);
      // Anyone already in the room is a baseline, not a fresh arrival.
      this.#lastMembers = new Set(room.members.map((entry) => entry.user.id));
      this.#rosterReady = true;

      if (this.#offer) {
        const buffered = this.#offer;
        this.#offer = null;
        await this.#answer(buffered);
      }
      // A rebuilt call recreates the membership server-side with default flags, so
      // the member's mute, deafen and watched screens are re-sent once it is up.
      this.#sync();
    } catch (cause) {
      this.error = describeFailure(cause);
      await this.#disconnect();
    } finally {
      this.connecting = false;
      this.joining = null;
    }
  }

  /** Leaves the channel because the member asked to. */
  async leave(): Promise<void> {
    this.#intended = null;
    this.#recoverAttempts = 0;
    this.#watching = {};
    this.#cancelRecover();
    this.#cancelResumeRetry();
    this.#forget();
    await this.#disconnect();
  }

  /** Tears down the microphone, the connection and the relayed audio. */
  async #disconnect(): Promise<void> {
    await this.stopScreen().catch(() => undefined);
    const channelId = this.channelId;
    this.channelId = null;
    this.members = [];
    this.#receivedScreens = {};
    this.#offer = null;
    this.#pc?.close();
    this.#pc = null;
    this.#teardown();
    this.muted = false;
    this.deafened = false;
    if (channelId) await api(`/channels/${channelId}/voice`, { method: 'DELETE' }).catch(() => undefined);
  }

  /**
   * Rebuilds a call whose connection dropped, so a lost stream heals without the
   * member having to leave and rejoin by hand.
   */
  #onConnectionState(state: RTCPeerConnectionState): void {
    if (state === 'connected') {
      this.#recoverAttempts = 0;
      this.#cancelRecover();
      return;
    }
    if (state === 'failed') this.#scheduleRecover(0);
    else if (state === 'disconnected') this.#scheduleRecover(VOICE_RECOVER_GRACE_MS);
  }

  #scheduleRecover(delayMs: number): void {
    if (this.#recovering || this.#recoverTimer || !this.#intended) return;
    this.#recoverTimer = setTimeout(() => {
      this.#recoverTimer = null;
      void this.#recover();
    }, delayMs);
  }

  #cancelRecover(): void {
    if (this.#recoverTimer) {
      clearTimeout(this.#recoverTimer);
      this.#recoverTimer = null;
    }
  }

  async #recover(): Promise<void> {
    const target = this.#intended;
    if (!target || this.#recovering) return;
    this.#recovering = true;
    try {
      await this.#establish(target);
    } finally {
      this.#recovering = false;
    }
    if (this.channelId === target) {
      this.#recoverAttempts = 0;
      return;
    }
    this.#recoverAttempts += 1;
    if (this.#intended !== target) return;
    if (this.#recoverAttempts < VOICE_MAX_RECOVER_ATTEMPTS) {
      this.#scheduleRecover(VOICE_RECOVER_DELAY_MS);
    } else {
      this.#intended = null;
      this.error = 'Voice connection lost. Rejoin the channel to try again.';
    }
  }

  setMuted(next: boolean): void {
    this.muted = next;
    this.#applyMic();
    this.#sync();
  }

  setDeafened(next: boolean): void {
    this.deafened = next;
    if (this.#master) this.#master.gain.value = next ? 0 : 1;
    this.#applyMic();
    this.#sync();
  }

  /** The playback gain for one member: the default unless this client changed it. */
  volumeFor(userId: string): number {
    return this.volumes[userId] ?? VOICE_VOLUME_DEFAULT;
  }

  /** Whether this client has adjusted one member away from the default. */
  volumeAdjusted(userId: string): boolean {
    return this.volumes[userId] !== undefined;
  }

  /**
   * Sets one member's playback gain, live, and remembers it for the next stream.
   * The value is a multiplier: 0 is silence, 1 the member's own level and 2 twice
   * as loud. The default stores nothing, so resetting leaves no override behind.
   */
  setVolume(userId: string, gain: number): void {
    const value = clampVolume(gain);
    const next = { ...this.volumes };
    if (value === VOICE_VOLUME_DEFAULT) delete next[userId];
    else next[userId] = value;
    this.volumes = next;
    this.#applyVolume(userId);
    this.#persistVolumes();
  }

  /** Silences one member, or restores the level they had before being muted. */
  toggleMuted(userId: string): void {
    const current = this.volumeFor(userId);
    if (current > 0) {
      this.#mutedFrom.set(userId, current);
      this.setVolume(userId, 0);
      return;
    }
    const restore = this.#mutedFrom.get(userId) ?? VOICE_VOLUME_DEFAULT;
    this.#mutedFrom.delete(userId);
    this.setVolume(userId, restore);
  }

  /** Clears one member's override, back to the default. */
  resetVolume(userId: string): void {
    this.#mutedFrom.delete(userId);
    this.setVolume(userId, VOICE_VOLUME_DEFAULT);
  }

  /** Points one member's live gain at the remembered volume, if they are playing. */
  #applyVolume(userId: string): void {
    const remote = this.#remote.get(userId);
    if (remote) remote.gain.gain.value = this.volumeFor(userId);
  }

  /**
   * Loads the volumes for whoever is signed in, once per account. A browser that
   * switches accounts reloads that account's own set, and live streams are
   * repointed so the change takes effect without a rejoin.
   */
  #ensureVolumes(): void {
    const owner = session.user?.id ?? null;
    if (owner === this.#volumesOwner) return;
    this.#volumesOwner = owner;
    this.volumes = owner ? readSavedVolumes(owner) : {};
    this.#mutedFrom.clear();
    for (const userId of this.#remote.keys()) this.#applyVolume(userId);
  }

  #persistVolumes(): void {
    if (this.#volumesOwner) writeSavedVolumes(this.#volumesOwner, this.volumes);
  }

  /**
   * The screens to show, one per sharing member other than yourself. This is the
   * roster's say-so, not the received track's: the relay only forwards a screen to
   * the viewers that opted in, so a sharing member appears as a watch prompt until
   * this client asks for it, and the tile disappears the moment their share stops
   * rather than freezing on its last frame.
   */
  get screenTiles(): ScreenTile[] {
    const me = session.user?.id ?? null;
    const tiles: ScreenTile[] = [];
    for (const entry of this.members) {
      const id = entry.user.id;
      if (!entry.sharing || id === me) continue;
      tiles.push({
        userId: id,
        name: entry.user.displayName ?? entry.user.username,
        watching: this.#watching[id] === true,
        stream: this.#receivedScreens[id] ?? null,
      });
    }
    return tiles;
  }

  /**
   * The name of another member already sharing a screen in this channel, or null.
   * A room carries one live screen, so the UI disables the share control while
   * this is set and `shareScreen` refuses before it opens the picker. The server
   * is still the authority; this is what makes the dead end visible.
   */
  get screenSharerName(): string | null {
    const me = session.user?.id ?? null;
    const sharer = this.members.find((entry) => entry.sharing && entry.user.id !== me);
    if (!sharer) return null;
    return sharer.user.displayName ?? sharer.user.username;
  }

  /**
   * Starts watching a member's screen. The relay forwards nothing until this is
   * sent, which is what keeps the stream off the wire for everyone who never opted
   * in; the server asks the producer for a keyframe, so the picture starts at once.
   */
  watchScreen(userId: string): void {
    if (this.#watching[userId]) return;
    this.#watching = { ...this.#watching, [userId]: true };
    this.#sync();
  }

  /** Stops watching a member's screen, which stops the relay forwarding it. */
  unwatchScreen(userId: string): void {
    if (!this.#watching[userId]) return;
    const next = { ...this.#watching };
    delete next[userId];
    this.#watching = next;
    this.#sync();
  }

  /**
   * Registers a member's screen for the UI. A remote video line exists from the
   * moment a call starts, so a received track is not the same as a live share: the
   * track stays muted until the relay actually sends a picture, and mute and
   * unmute are what tell an idle line from a live one.
   */
  #attachScreen(userId: string, stream: MediaStream, track: MediaStreamTrack): void {
    const show = (): void => {
      this.#receivedScreens = { ...this.#receivedScreens, [userId]: stream };
    };
    const hide = (): void => {
      if (this.#receivedScreens[userId] !== stream) return;
      const next = { ...this.#receivedScreens };
      delete next[userId];
      this.#receivedScreens = next;
    };
    if (!track.muted) show();
    track.addEventListener('unmute', show);
    track.addEventListener('mute', hide);
    track.addEventListener('ended', hide);
  }

  /**
   * Starts sharing this member's screen. The call already negotiated a send-only
   * video line for it, so this replaces the track on that line and nothing is
   * renegotiated.
   */
  async shareScreen(): Promise<void> {
    const pc = this.#pc;
    if (!pc || this.sharing) return;
    // A room carries one live screen. The server is the authority, but checking
    // the roster first keeps the picker from opening for a share that would be
    // refused, and names whoever already holds it.
    const sharer = this.screenSharerName;
    if (sharer) {
      this.error = `${sharer} is already sharing their screen in this channel.`;
      return;
    }
    const transceiver = pc
      .getTransceivers()
      .find((entry) => entry.receiver.track?.kind === 'video' && entry.currentDirection === 'sendonly');
    if (!transceiver) {
      this.error = 'This call cannot share a screen.';
      return;
    }
    if (!navigator.mediaDevices?.getDisplayMedia) {
      this.error = 'This browser cannot share a screen.';
      return;
    }
    this.error = null;
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({
        // The bounds an administrator set; the browser fits the screen into them.
        video: {
          height: { max: meta.data?.screenShare.height ?? 720 },
          frameRate: { max: meta.data?.screenShare.frameRate ?? 30 },
        },
        audio: false,
      });
      const track = display.getVideoTracks()[0];
      if (!track) throw new Error('The screen capture had no video track.');
      this.#display = display;
      await transceiver.sender.replaceTrack(track);
      this.#screenSender = transceiver.sender;
      this.sharing = true;
      try {
        await this.#pushState();
      } catch (cause) {
        // Someone started sharing between our check and the server's, so the
        // share was refused; drop the capture and surface who has it.
        await this.stopScreen();
        this.error = cause instanceof Error ? cause.message : 'Could not share your screen.';
        return;
      }
      // The browser's own Stop sharing button ends the track; follow it.
      track.addEventListener('ended', () => void this.stopScreen());
    } catch (cause) {
      for (const track of this.#display?.getTracks() ?? []) track.stop();
      this.#display = null;
      this.sharing = false;
      // Cancelling the picker is a choice, not a failure.
      if (cause instanceof DOMException && cause.name === 'NotAllowedError') return;
      this.error = describeFailure(cause);
    }
  }

  /** Stops sharing this member's screen. */
  async stopScreen(): Promise<void> {
    if (!this.sharing && !this.#display) return;
    this.sharing = false;
    this.#sync();
    for (const track of this.#display?.getTracks() ?? []) track.stop();
    this.#display = null;
    const sender = this.#screenSender;
    this.#screenSender = null;
    await sender?.replaceTrack(null).catch(() => undefined);
  }

  /** Clears a failed-join message once it has been read. */
  clearError(): void {
    this.error = null;
  }

  /** Discord's rule: a deafened member is also muted, without touching their setting. */
  #applyMic(): void {
    const live = !this.muted && !this.deafened;
    for (const track of this.#mic?.getAudioTracks() ?? []) track.enabled = live;
  }

  /** Sends the member's own voice flags; resolves once the server accepts them. */
  #pushState(): Promise<void> {
    if (!this.channelId) return Promise.resolve();
    return api(`/channels/${this.channelId}/voice`, {
      method: 'PATCH',
      body: JSON.stringify({
        muted: this.muted,
        deafened: this.deafened,
        sharing: this.sharing,
        watching: Object.keys(this.#watching),
      }),
    }).then(() => undefined);
  }

  /** Fire-and-forget sync for flag changes that need no error handling. */
  #sync(): void {
    void this.#pushState().catch(() => undefined);
  }

  /** Drops everything without telling the server; used when the session ends. */
  reset(): void {
    this.#intended = null;
    this.#recovering = false;
    this.#recoverAttempts = 0;
    this.#cancelRecover();
    this.#cancelResumeRetry();
    this.#resumeTries = 0;
    this.#forget();
    this.#ice = null;
    for (const track of this.#display?.getTracks() ?? []) track.stop();
    this.#display = null;
    this.#screenSender = null;
    this.sharing = false;
    this.#receivedScreens = {};
    this.#watching = {};
    this.#offer = null;
    // Volumes are per account and stay in localStorage; only the loaded copy and
    // the in-memory unmute levels are dropped here.
    this.volumes = {};
    this.#volumesOwner = null;
    this.#mutedFrom.clear();
    this.#pc?.close();
    this.#pc = null;
    this.#teardown();
    this.channelId = null;
    this.members = [];
    this.rosters = {};
    this.joining = null;
    this.muted = false;
    this.deafened = false;
    this.error = null;
  }
}

export const voice = new VoiceStore();
