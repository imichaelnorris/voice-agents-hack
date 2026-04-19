import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Image,
  Keyboard,
  Modal,
  PanResponder,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
  useColorScheme,
  useWindowDimensions,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import AudioRecord from 'react-native-audio-record';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
} from 'react-native-vision-camera';
import { launchImageLibrary } from 'react-native-image-picker';
import {
  useCactusLM,
  useCactusSTT,
  setModelUrlOverride,
  type CactusLMMessage,
} from 'cactus-react-native';
import {
  ShaderWebView,
  extractShader,
  isShaderAnimated,
  type ShaderWebViewHandle,
} from './ShaderWebView';
import * as RNFS from '@dr.pogodin/react-native-fs';

// Route Gemma 4 E2B apple zip through Cloudflare. S3 (HF's origin) doesn't
// speak HTTP/3, so assumesHTTP3Capable was a no-op there — metrics showed
// proto=http/1.1. CF does advertise h3, so pointing at deepsteve.com gives
// the h3 flag something to negotiate.
if (__DEV__) {
  setModelUrlOverride('gemma-4-e2b-it', {
    proApple: 'https://files.deepsteve.com/gemma-4-e2b-it-int4-apple.zip',
  });
}
import { CANNED_SHADERS } from './cannedShaders';

const VISION_MODEL = 'gemma-4-e2b-it';

// Prompt produced by the round-5 stacked-validation eval (see
// SHADER_PROMPT_ANALYSIS.md). Adds two snippets to the round-3
// baseline targeting the two largest compile-pass gaps (pixelate
// 2/5 → 5/5 and thermal 2/5 → 5/5). Net +6 absolute on the 50-prompt
// baseline (34 → 37), no significant regressions outside sampling
// noise.
const SHADER_SYSTEM_PROMPT = `You write GLSL ES 1.00 fragment shaders for WebGL 1 that apply a visual effect to a photo. Output ONLY the shader source — no markdown fences, no prose, no comments outside the shader.

Every shader MUST start with these declarations, in this order:

  precision mediump float;
  uniform sampler2D u_texture;
  uniform float u_time;
  uniform vec2 u_resolution;
  varying vec2 v_uv;

Then a \`void main()\` that reads the photo with \`texture2D(u_texture, v_uv)\`, transforms it according to the user's request, and writes the result to \`gl_FragColor\` clamped to [0, 1].

First, classify the request:
- If it matches a well-known photo/post-processing effect (sepia, invert, vignette, pixelate, chromatic aberration, CRT scanlines, thermal/false-color, posterize, fisheye, hue rotation, gaussian blur, halftone, duotone, etc.), use the classic algorithm for that effect — not a snippet from this prompt.
- If it doesn't match a known effect, write a novel shader composed from the primitives below.

Primitives to compose from:
- Color effects (sepia, invert, tint, desaturate, cross-process): transform the sampled RGB with a matrix, mix, or per-channel operation.
- Distortion effects (pixelate, mosaic, ripple, fisheye): change the UV you sample from — e.g. snap \`v_uv\` to block centers, or add a sin/cos offset.
- Split/offset effects (chromatic aberration, glitch, RGB shift): sample r, g, b separately at slightly different UVs.
- Brightness/vignette: multiply the sampled color by a spatial or luminance-based factor.
- Animated effects: drive the transform with \`u_time\` (seconds).

Do not invent uniforms that aren't declared. Do not use texture2D's result as a float. Do not leave gl_FragColor unset.`;
// pro: true → pulls the -apple.zip variant that bundles the .mlpackage Core ML files.
// Without these, Cactus falls back to CPU prefill and the vision encoder; with a 2B
// multimodal model that means `std::bad_alloc` on capture-sized inputs.
const VISION_MODEL_OPTIONS = { quantization: 'int4' as const, pro: true };
const STT_MODEL = 'whisper-small';
const STT_MODEL_OPTIONS = { quantization: 'int8' as const, pro: false };

// Mirrors the round-1 eval prompts in SHADER_PROMPT_ANALYSIS.md so tapping a chip
// on the phone produces a directly comparable output to the Ollama baseline.
const EXAMPLE_PROMPTS: { label: string; prompt: string }[] = [
  { label: 'Invert', prompt: 'invert the colors' },
  { label: 'CRT', prompt: 'add a CRT scanline effect' },
  { label: 'Underwater', prompt: 'make it look like an underwater scene with caustics' },
  { label: 'Vignette', prompt: 'apply a vignette that darkens the edges' },
  { label: 'Neon', prompt: 'turn it into a neon glow' },
  { label: 'Sepia', prompt: 'make it look like a sepia-toned vintage photo' },
  { label: 'X-Pro 2', prompt: 'apply an X-Pro II Instagram filter — boosted contrast and saturation, warm highlights, strong vignette' },
  { label: 'Overexposure', prompt: 'overexpose the photo — lift the exposure aggressively so highlights blow out to white, slight warm cast' },
];

// 16kHz 16-bit mono PCM, matches Whisper's expected format.
const AUDIO_OPTS = {
  sampleRate: 16000,
  channels: 1,
  bitsPerSample: 16,
  audioSource: 6,
  wavFile: 'voice-agents-hack.wav',
};

function MicIcon({ color = '#fff', size = 28 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 14.25a3.75 3.75 0 0 0 3.75-3.75V6a3.75 3.75 0 1 0-7.5 0v4.5a3.75 3.75 0 0 0 3.75 3.75z"
        stroke={color}
        strokeWidth={1.8}
        fill={color}
        fillOpacity={0.15}
      />
      <Path
        d="M6 10.5a6 6 0 0 0 12 0"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
      />
      <Path d="M12 18v3" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
    </Svg>
  );
}

function StopIcon({ color = '#fff', size = 22 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16">
      <Rect x={3} y={3} width={10} height={10} rx={2} fill={color} />
    </Svg>
  );
}

function CloseIcon({ color = '#fff', size = 24 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M6 6l12 12M18 6L6 18"
        stroke={color}
        strokeWidth={2.2}
        strokeLinecap="round"
      />
    </Svg>
  );
}

function HelpIcon({ color = '#fff', size = 22 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Circle cx={12} cy={12} r={9} stroke={color} strokeWidth={1.8} />
      <Path
        d="M9.2 9.2a2.8 2.8 0 0 1 5.6 0c0 1.8-2.8 2.2-2.8 4"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M12 17.2v.01"
        stroke={color}
        strokeWidth={2.2}
        strokeLinecap="round"
      />
    </Svg>
  );
}

function FlipCameraIcon({ color = '#fff', size = 22 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 8.5V8a2 2 0 0 1 2-2h2l1.5-2h5L16 6h2a2 2 0 0 1 2 2v1"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M20 15.5V16a2 2 0 0 1-2 2h-2l-1.5 2h-5L8 18H6a2 2 0 0 1-2-2v-1"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M7 10l-3 1 1-3M17 14l3-1-1 3"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function ShareIcon({ color = '#fff', size = 24 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3v13M8 7l4-4 4 4"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
      />
    </Svg>
  );
}

function DebugIcon({ color = '#fff', size = 22 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9 5l1.2 1.6h3.6L15 5"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M8 11a4 4 0 0 1 8 0v4a4 4 0 0 1-8 0v-4z"
        stroke={color}
        strokeWidth={1.8}
      />
      <Path
        d="M4 11h4M16 11h4M4 19h4M16 19h4M4 15h4M16 15h4"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
      />
    </Svg>
  );
}

function BackIcon({ color = '#fff', size = 24 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M15 5l-7 7 7 7"
        stroke={color}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function SendIcon({ color = '#fff', size = 22 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4 12l16-7-6 16-2.5-6.5L4 12z"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill={color}
        fillOpacity={0.15}
      />
    </Svg>
  );
}

function RefreshIcon({ color = '#fff', size = 22 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M20 12a8 8 0 1 1-2.34-5.66"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M20 4v4h-4"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function ExpandIcon({ color = '#fff', size = 18 }: { color?: string; size?: number }) {
  // Two diagonal arrows pointing outward (NE + SW) — the standard
  // "expand to fullscreen" affordance.
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M14 10l6-6M20 4v5M20 4h-5M10 14l-6 6M4 20v-5M4 20h5"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function CollapseIcon({ color = '#fff', size = 18 }: { color?: string; size?: number }) {
  // Mirror of ExpandIcon — arrows pointing inward.
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M20 4l-6 6M14 10v-5M14 10h5M4 20l6-6M10 14v5M10 14h-5"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function StarIcon({
  color = '#fff',
  size = 22,
  filled = false,
}: {
  color?: string;
  size?: number;
  filled?: boolean;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M12 3l2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.8 1-6.1L3.2 9.4l6.1-.9L12 3z"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill={filled ? color : 'none'}
      />
    </Svg>
  );
}

function HistoryIcon({ color = '#fff', size = 22 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 12a9 9 0 1 0 3-6.7"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M3 4v5h5"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M12 7v5l3 2"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function CopyIcon({ color = '#fff', size = 22 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect
        x={8}
        y={8}
        width={12}
        height={12}
        rx={2.5}
        stroke={color}
        strokeWidth={1.8}
      />
      <Path
        d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
      />
    </Svg>
  );
}

function CodeIcon({ color = '#fff', size = 18 }: { color?: string; size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M9 7l-5 5 5 5M15 7l5 5-5 5"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function CameraIconLarge({
  color = '#fff',
  size = 88,
}: {
  color?: string;
  size?: number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Path
        d="M10 18h8l3-5h22l3 5h8a4 4 0 0 1 4 4v24a4 4 0 0 1-4 4H10a4 4 0 0 1-4-4V22a4 4 0 0 1 4-4z"
        stroke={color}
        strokeWidth={2.2}
        strokeLinejoin="round"
      />
      <Path
        d="M32 40a8 8 0 1 0 0-16 8 8 0 0 0 0 16z"
        stroke={color}
        strokeWidth={2.2}
      />
      <Path d="M48 24h4" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
    </Svg>
  );
}

function PhotoLibraryIcon({
  color = '#fff',
  size = 26,
}: {
  color?: string;
  size?: number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect
        x={3}
        y={5}
        width={15}
        height={13}
        rx={2}
        stroke={color}
        strokeWidth={1.8}
      />
      <Path
        d="M7 14l3-3 3 3 2-2 3 3"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M21 8v11a2 2 0 0 1-2 2H8"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        opacity={0.6}
      />
    </Svg>
  );
}

function SpeechIconLarge({
  color = '#fff',
  size = 88,
}: {
  color?: string;
  size?: number;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      <Path
        d="M32 30a5 5 0 0 0 5-5v-7a5 5 0 1 0-10 0v7a5 5 0 0 0 5 5z"
        stroke={color}
        strokeWidth={2.2}
        strokeLinejoin="round"
      />
      <Path
        d="M22 24a10 10 0 0 0 20 0"
        stroke={color}
        strokeWidth={2.2}
        strokeLinecap="round"
      />
      <Path d="M32 34v7" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
      <Path
        d="M20 48h24"
        stroke={color}
        strokeWidth={2.2}
        strokeLinecap="round"
      />
      <Path
        d="M8 14l4 2M8 26l4-1M8 38l4-2M56 14l-4 2M56 26l-4-1M56 38l-4-2"
        stroke={color}
        strokeWidth={1.8}
        strokeLinecap="round"
        opacity={0.55}
      />
    </Svg>
  );
}

function RaceBar({
  label,
  progress,
  timeMs,
  isWinner,
  raceDone,
}: {
  label: string;
  progress: number;
  timeMs: number | null;
  isWinner: boolean;
  raceDone: boolean;
}) {
  const pct = Math.round(progress * 100);
  return (
    <View style={styles.raceBarRow}>
      <View style={styles.raceBarHeader}>
        <Text style={[styles.raceBarLabel, isWinner && styles.raceBarLabelWinner]}>
          {isWinner ? '★ ' : ''}{label}
        </Text>
        <Text style={styles.raceBarStat}>
          {timeMs != null
            ? `${(timeMs / 1000).toFixed(1)}s`
            : raceDone
            ? '—'
            : `${pct}%`}
        </Text>
      </View>
      <View style={styles.raceBarTrack}>
        <View
          style={[
            styles.raceBarFill,
            { width: `${pct}%` },
            isWinner && styles.raceBarFillWinner,
          ]}
        />
      </View>
    </View>
  );
}

function base64ToBytes(b64: string): number[] {
  const binary = global.atob(b64);
  const bytes = new Array<number>(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function ensureMicPermission(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;
  const granted = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    {
      title: 'Microphone permission',
      message: 'Allow the app to record audio for voice prompts.',
      buttonPositive: 'OK',
    },
  );
  return granted === PermissionsAndroid.RESULTS.GRANTED;
}

type Screen = 'tutorial' | 'camera' | 'review' | 'promptEval';

// Suggested prompts shown on the tutorial's second screen. These double as
// guardrails for demo-time judges who might otherwise freeze up at the mic.
// They intentionally match the vibe the model handles well (known style
// transfers, simple color/texture shifts) rather than asking for scene
// understanding that it doesn't do reliably.
const TUTORIAL_PROMPTS = [
  'make it feel like a dream',
  'vaporwave sunset',
  'glitchy VHS',
];

// Presence of this file means the user has already seen the tutorial at
// least once, so we skip it on launch. The (?) button on the camera page
// re-opens the tutorial regardless.
const TUTORIAL_FLAG_PATH = `${RNFS.DocumentDirectoryPath}/tutorial-seen.flag`;

// Persisted history of successfully-generated shaders. Many-to-one to
// prompts is fine: re-running the same text adds another entry. Capped at
// 100 newest-first so the file stays small enough to load synchronously.
const SHADER_HISTORY_PATH = `${RNFS.DocumentDirectoryPath}/shader-history.json`;
const SHADER_HISTORY_MAX = 100;
type ShaderHistoryEntry = {
  id: string;
  prompt: string;
  shader: string;
  createdAt: number;
  favorite?: boolean;
};

async function loadShaderHistory(): Promise<ShaderHistoryEntry[]> {
  try {
    const exists = await RNFS.exists(SHADER_HISTORY_PATH);
    if (!exists) return [];
    const raw = await RNFS.readFile(SHADER_HISTORY_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defend against malformed entries leaking from prior schema versions.
    return parsed.filter(
      (e): e is ShaderHistoryEntry =>
        e &&
        typeof e.id === 'string' &&
        typeof e.prompt === 'string' &&
        typeof e.shader === 'string' &&
        typeof e.createdAt === 'number',
    );
  } catch {
    return [];
  }
}

async function saveShaderHistory(entries: ShaderHistoryEntry[]): Promise<void> {
  try {
    await RNFS.writeFile(SHADER_HISTORY_PATH, JSON.stringify(entries), 'utf8');
  } catch {
    // Persistence failure is non-fatal — the in-memory history still works
    // for this session.
  }
}

// Cloudflared quick tunnel pointing at eval_server/server.mjs (localhost:9000).
// Quick-tunnel URLs rotate every restart — update this string and rebuild
// the app when the tunnel is restarted.
const EVAL_WS_URL = 'wss://fluid-bind-reload-calcium.trycloudflare.com';

const DEFAULT_SHADER_PROMPT = `Write a complete GLSL ES 1.00 fragment shader that produces an interesting animated image.

Requirements:
- Use "precision mediump float;" at the top.
- Available uniforms: "uniform float u_time;" (seconds) and "uniform vec2 u_resolution;" (pixels).
- Write to gl_FragColor.
- Output only the shader source code — no markdown, no prose, no backticks.`;

export default function App() {
  const isDarkMode = useColorScheme() === 'dark';
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <Root />
    </SafeAreaProvider>
  );
}

type LmHook = ReturnType<typeof useCactusLM>;
type SttHook = ReturnType<typeof useCactusSTT>;

function Root() {
  // null while we're still checking whether the user has seen the
  // tutorial before. Avoids flashing the tutorial at returning users and
  // also avoids flashing the camera permission fallback at first-time
  // users before the tutorial mounts on top.
  const [screen, setScreen] = useState<Screen | null>(null);
  const [photoUri, setPhotoUri] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    RNFS.exists(TUTORIAL_FLAG_PATH)
      .then(exists => {
        if (cancelled) return;
        setScreen(exists ? 'camera' : 'tutorial');
      })
      .catch(() => {
        if (cancelled) return;
        setScreen('tutorial');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Held at the top level so download state survives navigation between
  // screens. When this was inside ReviewScreen the hook re-instantiated on
  // every mount and restarted the download from zero.
  const lm = useCactusLM({ model: VISION_MODEL, options: VISION_MODEL_OPTIONS });
  const stt = useCactusSTT({ model: STT_MODEL, options: STT_MODEL_OPTIONS });

  // Kick off the download whenever we land in "not downloaded, not downloading".
  // Retries on failure (e.g. tunnel drop, transient 5xx) after a 1.5 s cool-off
  // so we don't spin. The previous one-shot ref would leave the UI stuck on
  // "Preparing Gemma 4 E2B…" whenever the first attempt errored mid-transfer.
  useEffect(() => {
    if (lm.isDownloaded || lm.isDownloading) return;
    const id = setTimeout(() => { lm.download().catch(() => {}); }, 1500);
    return () => clearTimeout(id);
  }, [lm.isDownloaded, lm.isDownloading, lm.download]);

  useEffect(() => {
    if (stt.isDownloaded || stt.isDownloading) return;
    const id = setTimeout(() => { stt.download().catch(() => {}); }, 1500);
    return () => clearTimeout(id);
  }, [stt.isDownloaded, stt.isDownloading, stt.download]);

  // Dev verification: once the Gemma model flips to downloaded, walk the
  // extracted dir and compare file count + total size + a known key file
  // against the reference manifest extracted from the HF zip locally. This
  // isolates whether our downloader/unzip produced the same on-disk state
  // that stock cactus would have.
  //   Expected (from unzip of the HF 4.68 GB zip, sha256 = 3a6e33eb…):
  //     files = 1973, total = 6_751_922_533 bytes,
  //     embed_tokens_per_layer.weights = 2_495_610_976 bytes
  useEffect(() => {
    if (!__DEV__ || !lm.isDownloaded) return;
    let cancelled = false;
    (async () => {
      try {
        const modelDir =
          `${RNFS.DocumentDirectoryPath}/cactus/models/gemma-4-e2b-it-int4-pro`;
        const walk = async (dir: string): Promise<{ count: number; total: number; keyFile?: number }> => {
          const entries = await RNFS.readDir(dir);
          let count = 0, total = 0, keyFile: number | undefined;
          for (const e of entries) {
            if (e.isDirectory()) {
              const sub = await walk(e.path);
              count += sub.count;
              total += sub.total;
              keyFile = keyFile ?? sub.keyFile;
            } else {
              count += 1;
              total += Number(e.size ?? 0);
              if (e.name === 'embed_tokens_per_layer.weights') {
                keyFile = Number(e.size ?? 0);
              }
            }
          }
          return { count, total, keyFile };
        };
        const r = await walk(modelDir);
        if (cancelled) return;
        const filesOk = r.count === 1973;
        const totalOk = r.total === 6_751_922_533;
        const keyOk = r.keyFile === 2_495_610_976;
        console.log(
          `[model.verify] files=${r.count} (${filesOk ? 'OK' : 'MISMATCH expected=1973'}) ` +
          `total=${r.total} (${totalOk ? 'OK' : 'MISMATCH expected=6751922533'}) ` +
          `embed_tokens_per_layer=${r.keyFile ?? 'MISSING'} ` +
          `(${keyOk ? 'OK' : 'MISMATCH expected=2495610976'})`,
        );
      } catch (err) {
        console.log('[model.verify] walk failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [lm.isDownloaded]);

  const handlePhotoTaken = useCallback((uri: string) => {
    setPhotoUri(uri);
    setScreen('review');
  }, []);

  const handleDiscard = useCallback(() => {
    setPhotoUri(null);
    setScreen('camera');
  }, []);

  const handleTutorialDone = useCallback(() => {
    // Fire-and-forget: worst case the flag doesn't land and the user sees
    // the tutorial twice on relaunch, which is harmless.
    RNFS.writeFile(TUTORIAL_FLAG_PATH, '1', 'utf8').catch(() => {});
    setScreen('camera');
  }, []);

  const handleShowTutorial = useCallback(() => setScreen('tutorial'), []);

  // DIAGNOSTIC: previously CameraScreen stayed mounted under everything to
  // keep the AVCaptureSession warm. Suspect that the paused-but-alive
  // capture pipeline (preview IOSurfaces + photo output recycle pool) is
  // contending with the model's working set during inference. Now fully
  // unmount on review/eval so the session is torn down (not just paused).
  // Cost: a cold-start delay on back-nav to camera.
  const cameraMounted = screen === 'camera' || screen === 'tutorial';
  const cameraActive = screen === 'camera' || screen === 'tutorial';
  return (
    <View style={styles.screen}>
      {cameraMounted ? (
        <CameraScreen
          onPhoto={handlePhotoTaken}
          onPromptEval={() => setScreen('promptEval')}
          onShowTutorial={handleShowTutorial}
          lm={lm}
          stt={stt}
          isActive={cameraActive}
        />
      ) : null}
      {screen === 'tutorial' ? (
        <View style={StyleSheet.absoluteFill}>
          <TutorialScreen onDone={handleTutorialDone} />
        </View>
      ) : null}
      {screen === 'review' ? (
        <View style={StyleSheet.absoluteFill}>
          <ReviewScreen
            photoUri={photoUri}
            onDiscard={handleDiscard}
            lm={lm}
            stt={stt}
          />
        </View>
      ) : null}
      {screen === 'promptEval' ? (
        <View style={StyleSheet.absoluteFill}>
          <PromptEvalScreen onBack={() => setScreen('camera')} lm={lm} />
        </View>
      ) : null}
    </View>
  );
}

function TutorialScreen({ onDone }: { onDone: () => void }) {
  const insets = useSafeAreaInsets();
  const [page, setPage] = useState<0 | 1>(0);
  const { hasPermission, requestPermission } = useCameraPermission();

  // Prompt for camera access the moment the user lands on page 2. Page 2
  // already explains that Gemma rewrites the photo, so the permission
  // dialog has the right context behind it. It also gives the pre-mounted
  // CameraScreen time to bring its capture session up before the user
  // taps "Get started".
  useEffect(() => {
    if (page === 1 && !hasPermission) {
      requestPermission().catch(() => {});
    }
  }, [page, hasPermission, requestPermission]);

  const isLast = page === 1;
  const handleNext = () => (isLast ? onDone() : setPage(1));
  const handleBack = () => setPage(0);

  return (
    <View style={styles.screen}>
      <Pressable
        onPress={onDone}
        hitSlop={12}
        style={[styles.tutorialSkip, { top: insets.top + 12 }]}
      >
        <Text style={styles.tutorialSkipText}>Skip</Text>
      </Pressable>

      <View
        style={[
          styles.tutorialBody,
          { paddingTop: insets.top + 64, paddingBottom: insets.bottom + 32 },
        ]}
      >
        <View style={styles.tutorialIllustration}>
          {page === 0 ? (
            <CameraIconLarge color="#f5f7fa" size={104} />
          ) : (
            <SpeechIconLarge color="#f5f7fa" size={104} />
          )}
        </View>

        <Text style={styles.tutorialStep}>Step {page + 1} of 2</Text>
        <Text style={styles.tutorialTitle}>
          {page === 0 ? 'Take a photo' : 'Say how it should look'}
        </Text>
        {page === 1 ? (
          <Text style={styles.tutorialBodyText}>
            Gemma 4 writes shaders for your photo from your prompt — running
            fully on-device. Tap the mic and describe the effect you want.
          </Text>
        ) : null}

        {page === 1 ? (
          <View style={styles.tutorialChipsWrap}>
            <Text style={styles.tutorialTrySaying}>Try saying</Text>
            <View style={styles.tutorialChips}>
              {TUTORIAL_PROMPTS.map(prompt => (
                <View key={prompt} style={styles.tutorialChip}>
                  <Text style={styles.tutorialChipText}>“{prompt}”</Text>
                </View>
              ))}
            </View>
          </View>
        ) : null}

        <View style={styles.tutorialSpacer} />

        <View style={styles.tutorialDots}>
          <View style={[styles.tutorialDot, page === 0 && styles.tutorialDotActive]} />
          <View style={[styles.tutorialDot, page === 1 && styles.tutorialDotActive]} />
        </View>

        <View style={styles.tutorialButtonRow}>
          {isLast ? (
            <Pressable onPress={handleBack} style={styles.tutorialSecondaryButton} hitSlop={8}>
              <Text style={styles.tutorialSecondaryButtonText}>Back</Text>
            </Pressable>
          ) : (
            <View style={styles.tutorialSecondaryPlaceholder} />
          )}
          <Pressable onPress={handleNext} style={styles.tutorialPrimaryButton}>
            <Text style={styles.tutorialPrimaryButtonText}>
              {isLast ? 'Get started' : 'Next'}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function CameraScreen({
  onPhoto,
  onPromptEval,
  onShowTutorial,
  lm,
  stt,
  isActive = true,
}: {
  onPhoto: (uri: string) => void;
  onPromptEval: () => void;
  onShowTutorial: () => void;
  lm: LmHook;
  stt: SttHook;
  isActive?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState<'back' | 'front'>('back');
  const device = useCameraDevice(position);
  const { hasPermission, requestPermission } = useCameraPermission();
  const photoOutput = usePhotoOutput();

  // Pin the download start time the first time a download goes active so
  // the banner can show elapsed seconds (and rough throughput). Reset when
  // the download finishes.
  const [dlStartMs, setDlStartMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const isDownloadingAny = lm.isDownloading || stt.isDownloading;
  useEffect(() => {
    if (isDownloadingAny && dlStartMs == null) setDlStartMs(Date.now());
    if (!isDownloadingAny) setDlStartMs(null);
  }, [isDownloadingAny, dlStartMs]);
  useEffect(() => {
    if (!isDownloadingAny) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isDownloadingAny]);

  const handleTake = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const photoFile = await photoOutput.capturePhotoToFile(
        { flashMode: 'off', enableShutterSound: true },
        {},
      );
      if (!photoFile?.filePath) {
        Alert.alert('Camera', 'No photo returned');
        return;
      }
      const uri = photoFile.filePath.startsWith('file://')
        ? photoFile.filePath
        : `file://${photoFile.filePath}`;
      onPhoto(uri);
    } catch (err) {
      Alert.alert(
        'Camera error',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
    }
  }, [busy, onPhoto, photoOutput]);

  const handlePickFromLibrary = useCallback(async () => {
    if (busy) return;
    try {
      const result = await launchImageLibrary({
        mediaType: 'photo',
        selectionLimit: 1,
        includeBase64: false,
      });
      if (result.didCancel) return;
      if (result.errorCode) {
        Alert.alert('Photo library', result.errorMessage ?? result.errorCode);
        return;
      }
      const asset = result.assets?.[0];
      if (!asset?.uri) return;
      onPhoto(asset.uri);
    } catch (err) {
      Alert.alert(
        'Photo library',
        err instanceof Error ? err.message : String(err),
      );
    }
  }, [busy, onPhoto]);

  // Surface the one-time model download so judges don't stare at a dead camera
  // on first launch. Gemma dominates (~1–2 hr); whisper finishes in seconds.
  // Cactus caches on disk, so subsequent launches skip this entirely.
  const elapsedSec =
    dlStartMs && isDownloadingAny ? Math.max(0, Math.floor((nowMs - dlStartMs) / 1000)) : 0;
  const formatElapsed = (s: number) =>
    s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
  const mbPerSec = (progress: number, totalBytes: number) => {
    if (!dlStartMs || elapsedSec <= 0 || progress <= 0) return null;
    const bytesDone = progress * totalBytes;
    return bytesDone / elapsedSec / (1024 * 1024);
  };

  const downloadBanner = !lm.isDownloaded
    ? {
        label: 'Downloading Gemma 4 E2B',
        progress: lm.downloadProgress ?? 0,
        totalBytes: 4_679_429_616,
      }
    : !stt.isDownloaded
    ? {
        label: 'Downloading speech model',
        progress: stt.downloadProgress ?? 0,
        totalBytes: 281_110_369,
      }
    : null;

  if (!hasPermission) {
    return (
      <View style={[styles.screen, styles.center]}>
        <Text style={styles.title}>Camera access needed</Text>
        <Pressable style={styles.primaryButton} onPress={() => requestPermission()}>
          <Text style={styles.primaryButtonText}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  if (!device) {
    return (
      <View style={[styles.screen, styles.center]}>
        <ActivityIndicator color="#f5f7fa" />
        <Text style={styles.subtitle}>Loading camera…</Text>
      </View>
    );
  }

  return (
    <View style={styles.screen}>
      <Camera
        style={StyleSheet.absoluteFill}
        device={device}
        isActive={isActive}
        outputs={[photoOutput]}
      />

      <View style={[styles.cameraTopBar, { paddingTop: insets.top + 8 }]}>
        <Pressable
          onPress={onShowTutorial}
          style={[styles.flipButton, styles.helpButton]}
          hitSlop={12}
        >
          <HelpIcon color="#fff" size={22} />
        </Pressable>
        {downloadBanner ? (
          <View style={styles.downloadBanner}>
            <View style={styles.downloadBannerRow}>
              <Text style={styles.downloadBannerLabel} numberOfLines={1}>
                {downloadBanner.label}
              </Text>
              <Text style={styles.downloadBannerPct}>
                {Math.round(downloadBanner.progress * 100)}%
              </Text>
            </View>
            <View style={styles.downloadBannerTrack}>
              <View
                style={[
                  styles.downloadBannerFill,
                  { width: `${Math.round(downloadBanner.progress * 100)}%` },
                ]}
              />
            </View>
            {dlStartMs ? (
              <Text style={styles.downloadBannerMeta}>
                {formatElapsed(elapsedSec)} elapsed
                {(() => {
                  const rate = mbPerSec(downloadBanner.progress, downloadBanner.totalBytes);
                  return rate ? ` · ${rate.toFixed(1)} MB/s` : '';
                })()}
              </Text>
            ) : null}
          </View>
        ) : (
          <View style={{ flex: 1 }} />
        )}
        <Pressable
          onPress={() => setPosition(p => (p === 'back' ? 'front' : 'back'))}
          style={styles.flipButton}
          hitSlop={12}
        >
          <FlipCameraIcon color="#fff" size={22} />
        </Pressable>
      </View>

      <View style={[styles.cameraBottomBar, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.cameraBottomSlot}>
          <Pressable
            onPress={onPromptEval}
            style={styles.promptEvalButton}
            hitSlop={8}
          >
            <Text style={styles.promptEvalButtonText}>{'Prompt\nEval'}</Text>
          </Pressable>
        </View>
        <Pressable
          onPress={handleTake}
          disabled={busy}
          style={[styles.shutter, busy && styles.shutterDisabled]}
        >
          {busy ? (
            <ActivityIndicator color="#0f1114" />
          ) : (
            <View style={styles.shutterInner} />
          )}
        </Pressable>
        <View style={styles.cameraBottomSlot}>
          <Pressable
            onPress={handlePickFromLibrary}
            disabled={busy}
            style={styles.libraryButton}
            hitSlop={8}
          >
            <PhotoLibraryIcon color="#fff" size={28} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

function HistoryRowItem({
  entry,
  ago,
  onApply,
  onView,
  onToggleFavorite,
  onDelete,
  onSwipeActive,
}: {
  entry: ShaderHistoryEntry;
  ago: string;
  onApply: () => void;
  onView: () => void;
  onToggleFavorite: () => void;
  onDelete: () => void;
  // Fires with true when this row claims the gesture and false when it
  // releases. The parent uses it to disable scroll on the surrounding
  // ScrollView so a vertical drift mid-swipe doesn't scroll the list.
  onSwipeActive: (active: boolean) => void;
}) {
  // PanResponder + Animated.Value give us swipe-to-delete without adding
  // react-native-gesture-handler. Tuning notes:
  //   - Capture variants run BEFORE descendants/parents (the ScrollView)
  //     get the gesture, so we can claim it before scroll kicks in.
  //   - Activation requires dx to dominate dy by 2× and exceed 6 px so
  //     vertical scrolls aren't stolen on diagonal touches.
  //   - Threshold to commit the delete is 50 px (was 80) for a more
  //     forgiving swipe.
  //   - onPanResponderTerminationRequest returns false so the ScrollView
  //     can't yank the gesture back mid-swipe.
  const SWIPE_DELETE_THRESHOLD = 50;
  const SWIPE_ACTIVATE_DX = 6;
  const translateX = useRef(new Animated.Value(0)).current;
  const [removing, setRemoving] = useState(false);
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponder: (_e, g) =>
          Math.abs(g.dx) > SWIPE_ACTIVATE_DX && Math.abs(g.dx) > Math.abs(g.dy) * 2,
        onMoveShouldSetPanResponderCapture: (_e, g) =>
          Math.abs(g.dx) > SWIPE_ACTIVATE_DX && Math.abs(g.dx) > Math.abs(g.dy) * 2,
        onPanResponderGrant: () => {
          onSwipeActive(true);
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderMove: (_e, g) => {
          translateX.setValue(Math.min(0, g.dx));
        },
        onPanResponderRelease: (_e, g) => {
          onSwipeActive(false);
          if (g.dx < -SWIPE_DELETE_THRESHOLD) {
            setRemoving(true);
            Animated.timing(translateX, {
              toValue: -500,
              duration: 180,
              useNativeDriver: true,
            }).start(() => onDelete());
          } else {
            Animated.spring(translateX, {
              toValue: 0,
              useNativeDriver: true,
              bounciness: 0,
            }).start();
          }
        },
        onPanResponderTerminate: () => {
          onSwipeActive(false);
          Animated.spring(translateX, {
            toValue: 0,
            useNativeDriver: true,
            bounciness: 0,
          }).start();
        },
      }),
    [translateX, onDelete, onSwipeActive],
  );

  return (
    <View style={styles.historyRowOuter}>
      <View style={styles.historyDeleteBg} pointerEvents="none">
        <Text style={styles.historyDeleteText}>Delete</Text>
      </View>
      <Animated.View
        style={[
          styles.historyRow,
          { transform: [{ translateX }], opacity: removing ? 0.6 : 1 },
        ]}
        {...panResponder.panHandlers}
      >
        <Pressable onPress={onToggleFavorite} hitSlop={10} style={styles.historyStar}>
          <StarIcon
            color={entry.favorite ? '#facc15' : '#9ba1a6'}
            size={20}
            filled={!!entry.favorite}
          />
        </Pressable>
        <Pressable style={styles.historyRowBody} onPress={onApply}>
          <Text style={styles.historyPrompt} numberOfLines={2}>
            {entry.prompt}
          </Text>
          <Text style={styles.historyMeta}>{ago}</Text>
        </Pressable>
        <Pressable onPress={onView} hitSlop={10} style={styles.historyView}>
          <CodeIcon color="#9ba1a6" size={18} />
        </Pressable>
      </Animated.View>
    </View>
  );
}

function ReviewScreen({
  photoUri,
  onDiscard,
  lm,
  stt,
}: {
  photoUri: string | null;
  onDiscard: () => void;
  lm: LmHook;
  stt: SttHook;
}) {
  const insets = useSafeAreaInsets();
  const { width: screenW, height: screenH } = useWindowDimensions();

  // Source dimensions of the current photo. Camera captures are 4:3, but
  // library uploads can be anything — square, 16:9, portrait — and we
  // need this to stop the shader canvas from stretching the texture to
  // a portrait phone aspect. null while Image.getSize is in flight.
  const [imgDims, setImgDims] = useState<{ w: number; h: number } | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [showShader, setShowShader] = useState(false);
  const [isCapturing, setIsCapturing] = useState(false);
  const [typed, setTyped] = useState('');
  // Output text starts collapsed (tiny pill at the top showing just the
  // status / last-line teaser); tap to expand into the full streaming
  // transcript + Gemma response.
  const [isOutputExpanded, setIsOutputExpanded] = useState(false);
  const outputScrollRef = useRef<ScrollView>(null);

  const [history, setHistory] = useState<ShaderHistoryEntry[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  useEffect(() => {
    let cancelled = false;
    loadShaderHistory().then(entries => {
      if (!cancelled) setHistory(entries);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const appendHistory = useCallback((prompt: string, shader: string) => {
    setHistory(prev => {
      const entry: ShaderHistoryEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        prompt,
        shader,
        createdAt: Date.now(),
        favorite: false,
      };
      // When trimming to MAX, never evict favorites — drop oldest non-fav
      // first. So a user who's favorited 100 entries simply stops getting
      // new history (acceptable scope for the hackathon).
      const merged = [entry, ...prev];
      let next = merged;
      if (merged.length > SHADER_HISTORY_MAX) {
        const favs = merged.filter(e => e.favorite);
        const nonFavs = merged.filter(e => !e.favorite);
        const keepNonFavs = Math.max(0, SHADER_HISTORY_MAX - favs.length);
        next = [...favs, ...nonFavs.slice(0, keepNonFavs)].sort(
          (a, b) => b.createdAt - a.createdAt,
        );
      }
      saveShaderHistory(next);
      return next;
    });
  }, []);
  const toggleFavorite = useCallback((id: string) => {
    setHistory(prev => {
      const next = prev.map(e =>
        e.id === id ? { ...e, favorite: !e.favorite } : e,
      );
      saveShaderHistory(next);
      return next;
    });
  }, []);
  const deleteFromHistory = useCallback((id: string) => {
    setHistory(prev => {
      const next = prev.filter(e => e.id !== id);
      saveShaderHistory(next);
      return next;
    });
  }, []);
  // Source shown by the "Shader source" modal — when the user taps the
  // code-icon on a history row we want to inspect that entry's source
  // without applying it (which would replace the live shader). Falls back
  // to the active shaderSource when the modal opens via the existing
  // "View shader" path.
  const [viewerShader, setViewerShader] = useState<string | null>(null);
  // Set to true while any history row is being actively swiped, so the
  // surrounding ScrollView stops scrolling — otherwise a vertical drift
  // mid-swipe would scroll the list out from under the user.
  const [historyRowSwiping, setHistoryRowSwiping] = useState(false);
  // Holds the (prompt, shader) from the most recent Gemma generation
  // until the WebView confirms it compiled. On onReady → commit to
  // history; on onError → drop. Keeps compile-failed shaders out of
  // the saved list.
  const pendingSaveRef = useRef<{ prompt: string; shader: string } | null>(null);
  const sortedHistory = useMemo(() => {
    // Favorites first (newest favorite at top), then non-favorites by
    // createdAt desc.
    return [...history].sort((a, b) => {
      const fa = a.favorite ? 1 : 0;
      const fb = b.favorite ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return b.createdAt - a.createdAt;
    });
  }, [history]);
  const [nowMs, setNowMs] = useState(Date.now());
  const [downloadStartMs, setDownloadStartMs] = useState<number | null>(null);
  useEffect(() => {
    if (lm.isDownloading && downloadStartMs == null) setDownloadStartMs(Date.now());
    if (!lm.isDownloading && lm.isDownloaded) setDownloadStartMs(null);
  }, [lm.isDownloading, lm.isDownloaded, downloadStartMs]);

  useEffect(() => {
    if (!photoUri) {
      setImgDims(null);
      return;
    }
    let cancelled = false;
    Image.getSize(
      photoUri,
      (w, h) => {
        if (!cancelled) setImgDims({ w, h });
      },
      () => {
        if (!cancelled) setImgDims(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [photoUri]);

  // Fit the photo's aspect ratio inside the window, centered, letterboxed
  // by the screen background. Both the <Image> layer and the WebGL canvas
  // live inside this frame so the shader samples 1:1 with the source —
  // no stretching when an uploaded 16:9 or square image hits a portrait
  // phone aspect.
  const photoFrame = useMemo(() => {
    if (!imgDims) return null;
    const imgAspect = imgDims.w / imgDims.h;
    const screenAspect = screenW / screenH;
    let w: number;
    let h: number;
    if (imgAspect > screenAspect) {
      w = screenW;
      h = screenW / imgAspect;
    } else {
      h = screenH;
      w = screenH * imgAspect;
    }
    return {
      width: w,
      height: h,
      left: (screenW - w) / 2,
      top: (screenH - h) / 2,
    };
  }, [imgDims, screenW, screenH]);
  // Set when a chip with a canned shader is tapped. Skips Gemma; flows
  // straight into ShaderWebView. Cleared whenever the user uses voice or
  // text input so generation reclaims the screen.
  const [manualShader, setManualShader] = useState<string | null>(null);

  const audioBuffer = useRef<number[]>([]);
  const dataSub = useRef<{ remove: () => void } | null>(null);

  // Raise the text-input row above the keyboard when it appears. The row is
  // absolutely positioned, so KeyboardAvoidingView can't do the work for us.
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvt, e => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvt, () => {
      setKeyboardHeight(0);
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  useEffect(() => {
    AudioRecord.init(AUDIO_OPTS);
  }, []);

  // Tick once per second while the LM is downloading so the elapsed-time
  // readout on the status line actually moves.
  useEffect(() => {
    if (!lm.isDownloading) return;
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [lm.isDownloading]);

  useEffect(() => {
    return () => {
      dataSub.current?.remove();
    };
  }, []);

  const [inferenceDebug, setInferenceDebug] = useState<string>('');

  const askGemma = useCallback(
    async (prompt: string) => {
      if (!photoUri || !prompt.trim()) return;
      setIsGenerating(true);
      setResponse('');
      setError(null);
      const startedAt = Date.now();
      let tokenCount = 0;
      let firstTokenAt: number | null = null;
      const header = [
        `── askGemma start @ ${new Date(startedAt).toISOString()}`,
        `prompt: ${JSON.stringify(prompt)}`,
        `photoUri: ${photoUri}`,
        `lm.isDownloaded=${lm.isDownloaded} lm.isDownloading=${lm.isDownloading} progress=${lm.downloadProgress ?? 'n/a'}`,
        `model=${VISION_MODEL} opts=${JSON.stringify(VISION_MODEL_OPTIONS)}`,
      ].join('\n');
      setInferenceDebug(header);
      try {
        const messages: CactusLMMessage[] = [
          { role: 'system', content: SHADER_SYSTEM_PROMPT },
          { role: 'user', content: prompt },
        ];
        let acc = '';
        let lastFlush = 0;
        await lm.complete({
          messages,
          options: { maxTokens: 512, temperature: 0.2 },
          onToken: (token: string) => {
            if (firstTokenAt == null) firstTokenAt = Date.now();
            tokenCount += 1;
            acc += token;
            const now = Date.now();
            // Throttle UI updates to ~10 Hz so the user still sees streaming
            // text but we don't queue a re-render per token.
            if (now - lastFlush > 100) {
              lastFlush = now;
              setResponse(acc);
            }
          },
        });
        setResponse(acc);
        const extracted = extractShader(acc);
        if (extracted) {
          // Defer: only save to history once the WebView confirms the
          // shader compiled and linked. onReady commits; onError drops.
          pendingSaveRef.current = { prompt, shader: extracted };
        }
        const doneAt = Date.now();
        setInferenceDebug(
          [
            header,
            `── askGemma ok (+${doneAt - startedAt}ms)`,
            `first token: ${firstTokenAt ? `${firstTokenAt - startedAt}ms` : 'never'}`,
            `tokens: ${tokenCount}`,
          ].join('\n'),
        );
      } catch (err) {
        const failedAt = Date.now();
        const msg = err instanceof Error ? err.message : String(err);
        const stack = err instanceof Error ? err.stack : undefined;
        let errJson = '';
        try {
          errJson = JSON.stringify(
            err,
            err && typeof err === 'object'
              ? Object.getOwnPropertyNames(err as object)
              : undefined,
            2,
          );
        } catch {}
        console.error('[askGemma] lm.complete failed', err);
        setInferenceDebug(
          [
            header,
            `── askGemma FAILED (+${failedAt - startedAt}ms)`,
            `first token: ${firstTokenAt ? `${firstTokenAt - startedAt}ms` : 'never'}`,
            `tokens before failure: ${tokenCount}`,
            `error name: ${err instanceof Error ? err.name : typeof err}`,
            `error message: ${msg}`,
            stack ? `stack:\n${stack}` : '',
            errJson && errJson !== '{}' ? `error object:\n${errJson}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
        setError(msg);
      } finally {
        setIsGenerating(false);
      }
    },
    [photoUri, lm, appendHistory],
  );

  // Cancel an in-flight inference if the screen unmounts (user navigates
  // back to camera). Stash lm in a ref so the cleanup only fires on real
  // unmount — listing `lm` in the dep array would re-fire the cleanup
  // every time useCactusLM returns a new wrapper object (which happens
  // on every parent re-render), aborting the active generation mid-
  // stream.
  const lmStopRef = useRef(lm);
  lmStopRef.current = lm;
  useEffect(() => {
    return () => {
      lmStopRef.current.stop().catch(() => {});
    };
  }, []);

  const stopRecordingAndAsk = useCallback(async () => {
    setIsFinalizing(true);
    try {
      await AudioRecord.stop();
    } catch {}
    dataSub.current?.remove();
    dataSub.current = null;
    setIsRecording(false);

    const audio = audioBuffer.current.slice();
    audioBuffer.current = [];

    try {
      const res = await stt.transcribe({
        audio,
        options: { useVad: true },
      });
      const text = (res.response ?? '').trim();
      setTranscript(text);
      if (text) {
        setManualShader(null);
        askGemma(text);
      } else {
        setError('No speech detected. Try again.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsFinalizing(false);
    }
  }, [stt, askGemma]);

  const startRecording = useCallback(async () => {
    const ok = await ensureMicPermission();
    if (!ok) {
      setError('Microphone permission denied');
      return;
    }
    setError(null);
    setTranscript('');
    setResponse('');
    audioBuffer.current = [];
    dataSub.current = AudioRecord.on('data', (b64: string) => {
      const bytes = base64ToBytes(b64);
      for (let i = 0; i < bytes.length; i++) {
        audioBuffer.current.push(bytes[i]);
      }
    }) as unknown as { remove: () => void };
    AudioRecord.start();
    setIsRecording(true);
  }, []);

  const handleMicPress = useCallback(() => {
    if (isGenerating || isFinalizing) return;
    if (isRecording) {
      stopRecordingAndAsk();
    } else {
      startRecording();
    }
  }, [isRecording, isGenerating, isFinalizing, startRecording, stopRecordingAndAsk]);

  const handleExamplePrompt = useCallback(
    (label: string, prompt: string) => {
      if (isGenerating || isFinalizing || isRecording) return;
      setError(null);
      const canned = CANNED_SHADERS[label];
      if (canned) {
        // Tapping the already-active canned chip toggles it off.
        if (manualShader === canned) {
          setManualShader(null);
          setTranscript('');
          setResponse('');
          return;
        }
        // Pre-baked shader from the eval rounds — skip Gemma entirely.
        // Mirror the generated-shader path: pipe the source through
        // setResponse so the output box at the top shows it (collapsed
        // teaser + tap-to-expand), same as anything Gemma writes.
        setTranscript(prompt);
        setResponse(canned);
        setManualShader(canned);
      } else {
        setTranscript(prompt);
        setResponse('');
        setManualShader(null);
        askGemma(prompt);
      }
    },
    [askGemma, isGenerating, isFinalizing, isRecording, manualShader],
  );

  const handleSendTyped = useCallback(() => {
    const trimmed = typed.trim();
    if (!trimmed || isGenerating || isFinalizing || isRecording) return;
    setError(null);
    setTranscript(trimmed);
    setResponse('');
    setManualShader(null);
    askGemma(trimmed);
  }, [typed, askGemma, isGenerating, isFinalizing, isRecording]);

  const shaderViewRef = useRef<ShaderWebViewHandle | null>(null);

  const handleCopyDebug = useCallback(async () => {
    const parts = [
      error ? `[error]\n${error}` : '',
      inferenceDebug ? `[inference]\n${inferenceDebug}` : '',
      response ? `[response]\n${response}` : '',
    ].filter(Boolean);
    if (parts.length === 0) {
      Alert.alert('Nothing to copy', 'The model has not produced any output yet.');
      return;
    }
    try {
      await Share.share({ message: parts.join('\n\n') });
    } catch (err) {
      Alert.alert('Share failed', err instanceof Error ? err.message : String(err));
    }
  }, [error, inferenceDebug, response]);

  const shaderSource = useMemo(
    () =>
      manualShader ??
      (response && !isGenerating ? extractShader(response) : null),
    [manualShader, response, isGenerating],
  );

  const handleCopyShader = useCallback(async () => {
    const src = viewerShader || shaderSource;
    if (!src) {
      Alert.alert('No shader', 'Generate or pick a shader first.');
      return;
    }
    try {
      await Share.share({ message: src });
    } catch (err) {
      Alert.alert('Share failed', err instanceof Error ? err.message : String(err));
    }
  }, [shaderSource, viewerShader]);

  const handleShare = useCallback(async () => {
    if (!photoUri || isCapturing) return;
    const tmpDir = RNFS.TemporaryDirectoryPath.replace(/\/$/, '');
    try {
      const canCaptureShader =
        !!shaderViewRef.current && !!shaderSource && !isGenerating;
      if (!canCaptureShader) {
        await Share.share({ url: photoUri });
        return;
      }
      setIsCapturing(true);
      // Animated shaders share as a 5s video of the offscreen canvas; static
      // shaders share as a PNG at the photo's native resolution.
      if (isShaderAnimated(shaderSource!)) {
        const { data, mime } = await shaderViewRef.current!.captureVideo(5000);
        const ext = mime.includes('webm') ? 'webm' : 'mp4';
        const path = `${tmpDir}/shader-${Date.now()}.${ext}`;
        await RNFS.writeFile(path, data, 'base64');
        await Share.share({ url: `file://${path}` });
      } else {
        const dataUri = await shaderViewRef.current!.capture();
        const base64 = dataUri.replace(/^data:image\/png;base64,/, '');
        const path = `${tmpDir}/shader-${Date.now()}.png`;
        await RNFS.writeFile(path, base64, 'base64');
        await Share.share({ url: `file://${path}` });
      }
    } catch (err) {
      Alert.alert('Share failed', err instanceof Error ? err.message : String(err));
    } finally {
      setIsCapturing(false);
    }
  }, [photoUri, shaderSource, isGenerating, isCapturing]);

  const lmBusy = lm.isDownloading || !lm.isDownloaded;
  const sttBusy = stt.isDownloading || !stt.isDownloaded;

  const statusLine = lm.isDownloading
    ? `Downloading Gemma 4 E2B… ${Math.round((lm.downloadProgress ?? 0) * 100)}%`
    : stt.isDownloading
    ? `Downloading Whisper… ${Math.round((stt.downloadProgress ?? 0) * 100)}%`
    : !lm.isDownloaded
    ? 'Preparing Gemma 4 E2B…'
    : !stt.isDownloaded
    ? 'Preparing Whisper…'
    : isFinalizing
    ? 'Transcribing…'
    : isGenerating
    ? 'Gemma is thinking…'
    : isRecording
    ? 'Listening — tap mic to stop.'
    : transcript
    ? ''
    : 'Type or speak a prompt to generate a shader for this image.';

  const micDisabled = lmBusy || sttBusy || isGenerating || isFinalizing;

  return (
    <View style={styles.screen}>
      {photoUri ? (
        photoFrame ? (
          // Pressable instead of plain View so a tap anywhere on the
          // photo dismisses the keyboard. ShaderWebView is
          // pointerEvents="none" and Image has no onPress, so taps fall
          // through to this Pressable. When the keyboard is closed,
          // Keyboard.dismiss is a no-op.
          <Pressable
            style={[styles.photoFrame, photoFrame]}
            onPress={Keyboard.dismiss}
          >
            <Image
              source={{ uri: photoUri }}
              style={StyleSheet.absoluteFill}
              resizeMode="cover"
            />
            {shaderSource ? (
              <ShaderWebView
                ref={shaderViewRef}
                photoUri={photoUri}
                shader={shaderSource}
                style={StyleSheet.absoluteFill}
                onError={msg => {
                  setError(`Shader: ${msg}`);
                  pendingSaveRef.current = null;
                }}
                onReady={() => {
                  const p = pendingSaveRef.current;
                  if (p) {
                    appendHistory(p.prompt, p.shader);
                    pendingSaveRef.current = null;
                  }
                }}
              />
            ) : null}
          </Pressable>
        ) : (
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={Keyboard.dismiss}
          >
            <Image
              source={{ uri: photoUri }}
              style={StyleSheet.absoluteFill}
              resizeMode="contain"
            />
          </Pressable>
        )
      ) : null}
      <View style={[StyleSheet.absoluteFill, styles.scrim]} />

      <Pressable
        onPress={() => setShowDebug(true)}
        hitSlop={12}
        style={[styles.debugButton, { top: insets.top + 12 }]}
      >
        <DebugIcon color="#fff" size={20} />
      </Pressable>

      <View
        style={[
          styles.outputBox,
          { marginTop: insets.top + 12 },
          // Give the box more room when the user wants to read the full
          // shader source, otherwise stay short to leave the photo visible.
          isOutputExpanded ? { maxHeight: '40%' } : null,
        ]}
      >
        <Pressable
          onPress={() => setIsOutputExpanded(v => !v)}
          style={{
            height: 34,
            alignItems: 'flex-end',
            justifyContent: 'center',
            paddingRight: 14,
          }}
        >
          {isOutputExpanded ? (
            <CollapseIcon color="#9ba1a6" size={14} />
          ) : (
            <ExpandIcon color="#9ba1a6" size={14} />
          )}
        </Pressable>
        <ScrollView
          ref={outputScrollRef}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 16, gap: 10 }}
          scrollEnabled={isOutputExpanded}
          showsVerticalScrollIndicator={isOutputExpanded}
          onContentSizeChange={() => {
            // Auto-scroll the streaming tail into view ONLY while a
            // generation is in flight. After it finishes, leave the scroll
            // position at the top so the user can read "You: ..." first
            // and scroll down through Gemma's full output themselves.
            if (isOutputExpanded && isGenerating) {
              outputScrollRef.current?.scrollToEnd({ animated: false });
            }
          }}
        >
          {lm.isDownloading ? (
            <View style={styles.raceCard}>
              <Text style={styles.raceTitle}>
                Downloading Gemma 4 E2B —{' '}
                {downloadStartMs
                  ? `${Math.floor((nowMs - downloadStartMs) / 1000)}s elapsed`
                  : '…'}
              </Text>
              <RaceBar
                label="4.68 GB"
                progress={lm.downloadProgress ?? 0}
                timeMs={null}
                isWinner={false}
                raceDone={false}
              />
            </View>
          ) : null}
          {statusLine && !lm.isDownloading ? (
            <Text style={styles.statusText} numberOfLines={isOutputExpanded ? 0 : 1}>
              {statusLine}
            </Text>
          ) : null}
          {transcript ? (
            <Text
              style={styles.transcriptText}
              numberOfLines={isOutputExpanded ? 0 : 1}
            >
              <Text style={styles.transcriptLabel}>You: </Text>
              {transcript}
            </Text>
          ) : null}
          {response ? (
            <Text
              style={styles.responseText}
              numberOfLines={isOutputExpanded ? 0 : 1}
            >
              <Text style={styles.responseLabel}>Gemma: </Text>
              {isOutputExpanded
                ? response
                : isGenerating
                  ? (response.split('\n').filter(l => l.trim()).pop() || response)
                  : response}
              {isGenerating ? <Text style={styles.cursor}>▍</Text> : null}
            </Text>
          ) : null}
          {error ? (
            <Text style={styles.errorText} numberOfLines={isOutputExpanded ? 0 : 1}>
              {error}
            </Text>
          ) : null}
        </ScrollView>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={[styles.chipRow, { bottom: insets.bottom + 196 }]}
        contentContainerStyle={styles.chipRowContent}
      >
        {EXAMPLE_PROMPTS.map(ex => {
          // Canned-shader chips don't need Gemma at all — they bypass the
          // model and feed the WebView directly. So they stay tappable
          // even while the model is still downloading or initializing.
          const isCanned = ex.label in CANNED_SHADERS;
          const isActive = isCanned && manualShader === CANNED_SHADERS[ex.label];
          const disabled = isCanned
            ? isRecording || isFinalizing || isGenerating
            : micDisabled || isRecording;
          return (
            <Pressable
              key={ex.label}
              onPress={() => handleExamplePrompt(ex.label, ex.prompt)}
              disabled={disabled}
              style={[
                styles.chip,
                isActive && styles.chipActive,
                disabled && styles.chipDisabled,
              ]}
              hitSlop={6}
            >
              <Text style={[styles.chipText, isActive && styles.chipTextActive]}>
                {ex.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View
        style={[
          styles.inputRow,
          {
            bottom:
              keyboardHeight > 0 ? keyboardHeight + 12 : insets.bottom + 130,
          },
        ]}
      >
        <Pressable
          onPress={() => setShowHistory(true)}
          disabled={history.length === 0}
          style={[
            styles.historyButton,
            history.length === 0 && styles.sendButtonDisabled,
          ]}
          hitSlop={8}
        >
          <HistoryIcon color="#fff" size={20} />
        </Pressable>
        <TextInput
          value={typed}
          onChangeText={setTyped}
          placeholder="Describe the shader…"
          placeholderTextColor="rgba(245,247,250,0.5)"
          style={styles.textInput}
          editable={!micDisabled && !isRecording}
          returnKeyType="send"
          onSubmitEditing={handleSendTyped}
          blurOnSubmit
          multiline={false}
        />
        <Pressable
          onPress={handleSendTyped}
          disabled={!typed.trim() || micDisabled || isRecording}
          style={[
            styles.sendButton,
            (!typed.trim() || micDisabled || isRecording) && styles.sendButtonDisabled,
          ]}
          hitSlop={8}
        >
          {keyboardHeight === 0 && typed.trim() ? (
            <RefreshIcon color="#fff" size={20} />
          ) : (
            <SendIcon color="#fff" size={20} />
          )}
        </Pressable>
      </View>

      <View style={[styles.bottomRow, { paddingBottom: insets.bottom + 20 }]}>
        <Pressable onPress={onDiscard} style={styles.sideButton} hitSlop={12}>
          <CloseIcon color="#fff" size={26} />
        </Pressable>

        <Pressable
          onPress={handleMicPress}
          disabled={micDisabled}
          style={[
            styles.micButton,
            isRecording && styles.micButtonRecording,
            micDisabled && styles.micButtonDisabled,
          ]}
          hitSlop={12}
        >
          {isFinalizing || isGenerating ? (
            <ActivityIndicator color="#fff" size="large" />
          ) : isRecording ? (
            <StopIcon color="#fff" size={26} />
          ) : (
            <MicIcon color="#fff" size={34} />
          )}
        </Pressable>

        <Pressable
          onPress={handleShare}
          disabled={isCapturing}
          style={[styles.sideButton, isCapturing && { opacity: 0.5 }]}
          hitSlop={12}
        >
          {isCapturing ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <ShareIcon color="#fff" size={24} />
          )}
        </Pressable>
      </View>

      <Modal
        visible={showDebug}
        animationType="slide"
        transparent={false}
        onRequestClose={() => setShowDebug(false)}
      >
        <View style={styles.debugScreen}>
          <View style={[styles.debugTopBar, { paddingTop: insets.top + 8 }]}>
            <Pressable
              onPress={() => setShowDebug(false)}
              hitSlop={12}
              style={styles.debugTopIcon}
            >
              <CloseIcon color="#fff" size={24} />
            </Pressable>
            <Text style={styles.debugTitle}>Model output</Text>
            <Pressable
              onPress={handleCopyDebug}
              hitSlop={12}
              style={styles.debugTopIcon}
            >
              <CopyIcon color="#fff" size={22} />
            </Pressable>
          </View>
          <ScrollView
            style={styles.debugBody}
            contentContainerStyle={styles.debugBodyContent}
          >
            {error ? (
              <Text
                selectable
                style={[styles.debugText, { color: '#f87171', marginBottom: 12 }]}
              >
                {'[error]\n' + error}
              </Text>
            ) : null}
            {inferenceDebug ? (
              <Text selectable style={[styles.debugText, styles.debugInferenceText]}>
                {inferenceDebug}
              </Text>
            ) : null}
            <Text selectable style={styles.debugText}>
              {response || '(no output yet)'}
            </Text>
          </ScrollView>
        </View>
      </Modal>

      <Modal
        visible={showShader}
        animationType="slide"
        transparent={false}
        onRequestClose={() => {
          setShowShader(false);
          setViewerShader(null);
        }}
      >
        <View style={styles.debugScreen}>
          <View style={[styles.debugTopBar, { paddingTop: insets.top + 8 }]}>
            <Pressable
              onPress={() => {
                setShowShader(false);
                setViewerShader(null);
              }}
              hitSlop={12}
              style={styles.debugTopIcon}
            >
              <CloseIcon color="#fff" size={24} />
            </Pressable>
            <Text style={styles.debugTitle}>Shader source</Text>
            <Pressable
              onPress={handleCopyShader}
              hitSlop={12}
              style={styles.debugTopIcon}
            >
              <CopyIcon color="#fff" size={22} />
            </Pressable>
          </View>
          <ScrollView
            style={styles.debugBody}
            contentContainerStyle={styles.debugBodyContent}
          >
            <Text selectable style={styles.debugText}>
              {viewerShader || shaderSource || '(no shader active)'}
            </Text>
          </ScrollView>
        </View>
      </Modal>

      <Modal
        visible={showHistory}
        animationType="slide"
        transparent={false}
        onRequestClose={() => setShowHistory(false)}
      >
        <View style={styles.debugScreen}>
          <View style={[styles.debugTopBar, { paddingTop: insets.top + 8 }]}>
            <Pressable
              onPress={() => setShowHistory(false)}
              hitSlop={12}
              style={styles.debugTopIcon}
            >
              <CloseIcon color="#fff" size={24} />
            </Pressable>
            <Text style={styles.debugTitle}>Shader history</Text>
            <View style={{ width: 40, height: 40 }} />
          </View>
          <ScrollView
            style={styles.debugBody}
            contentContainerStyle={{ paddingBottom: 24 }}
            scrollEnabled={!historyRowSwiping}
          >
            {sortedHistory.length === 0 ? (
              <Text style={[styles.debugText, { padding: 16, textAlign: 'center' }]}>
                No shaders yet. Generate one and it'll show up here.
              </Text>
            ) : (
              sortedHistory.map(entry => {
                const ageMs = Date.now() - entry.createdAt;
                const seconds = Math.floor(ageMs / 1000);
                const ago =
                  seconds < 60
                    ? `${seconds}s ago`
                    : seconds < 3600
                    ? `${Math.floor(seconds / 60)}m ago`
                    : seconds < 86400
                    ? `${Math.floor(seconds / 3600)}h ago`
                    : `${Math.floor(seconds / 86400)}d ago`;
                return (
                  <HistoryRowItem
                    key={entry.id}
                    entry={entry}
                    ago={ago}
                    onApply={() => {
                      setManualShader(entry.shader);
                      setTranscript(entry.prompt);
                      // Pipe the shader source through setResponse so the
                      // top output box shows it (same shape as a fresh
                      // Gemma generation). Without this the box only
                      // shows "You: ..." with no shader text.
                      setResponse(entry.shader);
                      setError(null);
                      setShowHistory(false);
                    }}
                    onView={() => {
                      setViewerShader(entry.shader);
                      setShowHistory(false);
                      setShowShader(true);
                    }}
                    onToggleFavorite={() => toggleFavorite(entry.id)}
                    onDelete={() => deleteFromHistory(entry.id)}
                    onSwipeActive={setHistoryRowSwiping}
                  />
                );
              })
            )}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

type EvalWsStatus = 'idle' | 'connecting' | 'connected' | 'error';

type EvalLogEntry = {
  id: string;
  prompt: string;
  response?: string;
  error?: string;
  ts: number;
};

type EvalInferenceMsg = {
  type: 'inference';
  id: string;
  prompt: string;
  // Optional system message — lets the eval server iterate on the system
  // prompt across runs without reshipping the app.
  systemPrompt?: string;
  // Per-request inference options (override the defaults below).
  options?: {
    maxTokens?: number;
    temperature?: number;
  };
};

function PromptEvalScreen({ onBack, lm }: { onBack: () => void; lm: LmHook }) {
  const insets = useSafeAreaInsets();

  const [promptOverride, setPromptOverride] = useState('');
  const [oneShotOutput, setOneShotOutput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<EvalWsStatus>('idle');
  const [log, setLog] = useState<EvalLogEntry[]>([]);
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(() => new Set());
  // Tick once per minute so the "X min ago" labels update without us having
  // to recompute on every render.
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // Keep-awake: NOT wired right now — @sayem314/react-native-keep-awake
  // pinned CLANG_CXX_LANGUAGE_STANDARD to c++17 and broke RN 0.85's
  // ReactCommon (`requires` clause is C++20). Workaround: iOS Settings →
  // Display & Brightness → Auto-Lock → Never while running batches.

  const toggleLogExpanded = useCallback((id: string) => {
    setExpandedLogIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const formatRelativeTime = (ts: number): string => {
    const ageMs = Math.max(0, nowMs - ts);
    const seconds = Math.floor(ageMs / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours} hr ago`;
  };

  const wsRef = useRef<WebSocket | null>(null);
  const chainRef = useRef<Promise<void>>(Promise.resolve());
  const lmRef = useRef(lm);
  useEffect(() => {
    lmRef.current = lm;
  }, [lm]);

  useEffect(() => {
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  const runInference = useCallback(
    async (
      prompt: string,
      systemPrompt?: string,
      reqOptions?: { maxTokens?: number; temperature?: number },
    ): Promise<string> => {
      let response = '';
      const messages: CactusLMMessage[] = systemPrompt
        ? [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
          ]
        : [{ role: 'user', content: prompt }];
      await lmRef.current.complete({
        messages,
        options: {
          maxTokens: reqOptions?.maxTokens ?? 1024,
          temperature: reqOptions?.temperature ?? 0.7,
        },
        onToken: (token: string) => {
          response += token;
        },
      });
      return response;
    },
    [],
  );

  const handleOneShot = useCallback(async () => {
    if (isGenerating || !lm.isDownloaded) return;
    const prompt = promptOverride.trim() || DEFAULT_SHADER_PROMPT;
    setIsGenerating(true);
    setOneShotOutput('');
    setError(null);
    try {
      await lm.complete({
        messages: [{ role: 'user', content: prompt }],
        options: { maxTokens: 1024, temperature: 0.7 },
        onToken: (token: string) => {
          setOneShotOutput(prev => prev + token);
        },
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsGenerating(false);
    }
  }, [isGenerating, lm, promptOverride]);

  const handleInferenceRequest = useCallback(
    async (req: EvalInferenceMsg) => {
      const ws = wsRef.current;
      // The hook-wrapped lm.complete() races on a React-state isGenerating
      // closure: the chain serializes our requests, but the closure hasn't
      // re-rendered between back-to-back chain entries, so the second call
      // sees a stale "still generating" value and rejects. Retry with a
      // small backoff to give React a chance to settle.
      let response: string | null = null;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 6; attempt++) {
        try {
          response = await runInference(req.prompt, req.systemPrompt, req.options);
          break;
        } catch (err) {
          lastErr = err;
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('already generating')) {
            await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
            continue;
          }
          break;
        }
      }
      if (response !== null) {
        ws?.send(
          JSON.stringify({ type: 'response', id: req.id, response }),
        );
        setLog(prev =>
          [
            { id: req.id, prompt: req.prompt, response, ts: Date.now() },
            ...prev,
          ].slice(0, 50),
        );
      } else {
        const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
        ws?.send(
          JSON.stringify({ type: 'error', id: req.id, error: message }),
        );
        setLog(prev =>
          [
            { id: req.id, prompt: req.prompt, error: message, ts: Date.now() },
            ...prev,
          ].slice(0, 50),
        );
      }
    },
    [runInference],
  );

  const connectClient = useCallback(() => {
    if (wsRef.current) return;
    setError(null);
    setWsStatus('connecting');
    const ws = new WebSocket(EVAL_WS_URL);
    wsRef.current = ws;
    ws.onopen = () => {
      setWsStatus('connected');
      try {
        ws.send(JSON.stringify({ type: 'hello', model: VISION_MODEL }));
      } catch {}
    };
    ws.onmessage = evt => {
      try {
        const data = typeof evt.data === 'string' ? evt.data : '';
        const msg = JSON.parse(data);
        if (msg && msg.type === 'inference' && typeof msg.id === 'string' && typeof msg.prompt === 'string') {
          chainRef.current = chainRef.current.then(async () => {
            // Yield so React can flush the previous request's
            // setIsGenerating(false) before we kick off the next one.
            // Otherwise the hook-wrapped lm.complete() reads a stale
            // closure and rejects with "already generating".
            await new Promise(r => setTimeout(r, 80));
            return handleInferenceRequest(msg as EvalInferenceMsg);
          });
        }
      } catch (err) {
        setError(`Parse error: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    ws.onerror = () => {
      setWsStatus('error');
      setError('WebSocket error');
    };
    ws.onclose = () => {
      wsRef.current = null;
      setWsStatus(prev => (prev === 'error' ? 'error' : 'idle'));
    };
  }, [handleInferenceRequest]);

  const disconnectClient = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;
    setWsStatus('idle');
  }, []);

  const clientActive = wsStatus === 'connected' || wsStatus === 'connecting';

  const lmStatusLine = lm.isDownloading
    ? `Downloading Gemma 4 E2B… ${Math.round((lm.downloadProgress ?? 0) * 100)}%`
    : !lm.isDownloaded
    ? 'Preparing Gemma 4 E2B…'
    : null;

  const oneShotDisabled = !lm.isDownloaded || isGenerating;

  return (
    <View style={styles.screen}>
      <View style={[styles.evalTopBar, { paddingTop: insets.top + 8 }]}>
        <Pressable onPress={onBack} style={styles.debugTopIcon} hitSlop={12}>
          <BackIcon color="#fff" size={22} />
        </Pressable>
        <Text style={styles.debugTitle}>Prompt Eval</Text>
        <View style={{ width: 40 }} />
      </View>

      <ScrollView
        style={styles.evalBody}
        contentContainerStyle={styles.evalBodyContent}
        keyboardShouldPersistTaps="handled"
      >
        {lmStatusLine ? (
          <Text style={styles.statusText}>{lmStatusLine}</Text>
        ) : null}

        <Text style={styles.evalSectionLabel}>Produce shader example</Text>
        <TextInput
          style={styles.evalInput}
          placeholder="Optional override (leave empty to use default shader prompt)"
          placeholderTextColor="#6b7280"
          value={promptOverride}
          onChangeText={setPromptOverride}
          multiline
          editable={!isGenerating}
        />
        <Pressable
          onPress={handleOneShot}
          disabled={oneShotDisabled}
          style={[
            styles.evalPrimaryButton,
            oneShotDisabled && styles.evalButtonDisabled,
          ]}
        >
          {isGenerating ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.evalPrimaryButtonText}>Produce shader example</Text>
          )}
        </Pressable>
        {!lm.isDownloaded ? (
          <Text style={styles.evalCaption}>
            (need to install model before this is enabled)
          </Text>
        ) : null}
        {oneShotOutput ? (
          <View style={styles.evalOutputBox}>
            <Text selectable style={styles.evalOutputText}>
              {oneShotOutput}
              {isGenerating ? <Text style={styles.cursor}>▍</Text> : null}
            </Text>
          </View>
        ) : null}

        <View style={styles.evalDivider} />

        <Text style={styles.evalSectionLabel}>Client mode</Text>
        <Text style={styles.evalCaption}>
          Turns this phone into an on-device inference worker. A local Claude
          Code agent on your laptop spawns a batch of shader prompts (to
          test prompt and response quality), sends each one over the
          WebSocket, and collects Gemma's output for scoring. Use this to
          run evals against the quantized Cactus build you can't touch from
          the laptop directly.
        </Text>
        <Text style={styles.evalCaption}>
          1. On your laptop, cd into {`eval_server/ `}and start the server
          (or the Claude Code agent that drives it).{'\n'}
          2. Tap "Start client mode" below.{'\n'}
          3. Trigger the batch from the laptop — results log here.
        </Text>
        {!lm.isDownloaded ? (
          <Text style={styles.evalCaption}>
            (need to install model before this is enabled)
          </Text>
        ) : null}
        <Pressable
          onPress={clientActive ? disconnectClient : connectClient}
          disabled={!lm.isDownloaded}
          style={[
            clientActive ? styles.evalDangerButton : styles.evalPrimaryButton,
            !lm.isDownloaded && styles.evalButtonDisabled,
          ]}
        >
          <Text style={styles.evalPrimaryButtonText}>
            {wsStatus === 'connecting'
              ? 'Connecting… tap to cancel'
              : wsStatus === 'connected'
              ? 'Disconnect client'
              : 'Start client mode'}
          </Text>
        </Pressable>
        <Text style={styles.evalStatusText}>
          Status: {wsStatus}
          {wsStatus === 'connected' ? `  —  ${EVAL_WS_URL}` : ''}
        </Text>

        {error ? <Text style={styles.errorText}>{error}</Text> : null}

        {log.length > 0 ? (
          <View style={styles.evalLogBox}>
            <Text style={styles.evalSectionLabel}>Recent requests</Text>
            {log.map(entry => {
              const expanded = expandedLogIds.has(entry.id);
              return (
                <Pressable
                  key={`${entry.id}-${entry.ts}`}
                  onPress={() => toggleLogExpanded(entry.id)}
                  style={styles.evalLogRow}
                >
                  <View style={styles.evalLogHeader}>
                    <Text style={styles.evalLogPrompt} numberOfLines={expanded ? undefined : 2}>
                      #{entry.id.slice(0, 8)} · {entry.prompt}
                    </Text>
                    <Text style={styles.evalLogTime}>
                      {formatRelativeTime(entry.ts)}
                    </Text>
                  </View>
                  {entry.error ? (
                    <Text
                      style={styles.errorText}
                      numberOfLines={expanded ? undefined : 3}
                      selectable={expanded}
                    >
                      {entry.error}
                    </Text>
                  ) : (
                    <Text
                      style={styles.evalLogResponse}
                      numberOfLines={expanded ? undefined : 3}
                      selectable={expanded}
                    >
                      {entry.response}
                    </Text>
                  )}
                </Pressable>
              );
            })}
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#0f1114' },
  center: { alignItems: 'center', justifyContent: 'center', padding: 24 },
  title: { color: '#f5f7fa', fontSize: 24, fontWeight: '700' },
  subtitle: { color: '#9ba1a6', fontSize: 14, marginTop: 8 },
  primaryButton: {
    marginTop: 20,
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: '#3b82f6',
  },
  primaryButtonText: { color: '#fff', fontWeight: '700' },

  cameraTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  flipButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  helpButton: { marginRight: 12 },

  downloadBanner: {
    flex: 1,
    marginRight: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    gap: 6,
  },
  downloadBannerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  downloadBannerLabel: {
    flex: 1,
    color: '#e5e7eb',
    fontSize: 12,
    fontWeight: '600',
  },
  downloadBannerPct: {
    color: '#e5e7eb',
    fontSize: 12,
    fontVariant: ['tabular-nums'],
    marginLeft: 8,
  },
  downloadBannerTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  downloadBannerFill: {
    height: '100%',
    backgroundColor: '#f5f7fa',
    borderRadius: 2,
  },
  downloadBannerMeta: {
    color: '#9ba1a6',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },

  cameraBottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 16,
    paddingHorizontal: 24,
  },
  cameraBottomSlot: { flex: 1, alignItems: 'center' },
  promptEvalButton: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(15,17,20,0.7)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  libraryButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(15,17,20,0.7)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  promptEvalButtonText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 16,
  },
  shutter: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: '#f5f7fa',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 4,
    borderColor: '#1f2937',
  },
  shutterDisabled: { opacity: 0.6 },
  shutterInner: {
    width: 68,
    height: 68,
    borderRadius: 34,
    backgroundColor: '#fff',
    borderWidth: 2,
    borderColor: '#0f1114',
  },

  scrim: { backgroundColor: 'rgba(0,0,0,0.35)' },
  photoFrame: { position: 'absolute', overflow: 'hidden' },

  outputBox: {
    position: 'absolute',
    left: 16,
    right: 64,
    top: 0,
    maxHeight: '55%',
    backgroundColor: 'rgba(15,17,20,0.82)',
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
  },
  outputContent: { padding: 16, gap: 10 },
  statusText: {
    color: '#9ba1a6',
    fontSize: 13,
    fontStyle: 'italic',
  },
  transcriptLabel: { color: '#a78bfa', fontWeight: '700' },
  transcriptText: { color: '#e5e7eb', fontSize: 15, lineHeight: 21 },
  responseLabel: { color: '#34d399', fontWeight: '700' },
  responseText: { color: '#f5f7fa', fontSize: 16, lineHeight: 23 },
  cursor: { color: '#34d399' },
  errorText: { color: '#f87171', fontSize: 13 },

  raceCard: {
    gap: 10,
    paddingVertical: 4,
  },
  raceTitle: { color: '#f5f7fa', fontSize: 14, fontWeight: '700' },
  raceBarRow: { gap: 4 },
  raceBarHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  raceBarLabel: { color: '#c8cbce', fontSize: 12, fontWeight: '600' },
  raceBarLabelWinner: { color: '#34d399' },
  raceBarStat: { color: '#c8cbce', fontSize: 12, fontVariant: ['tabular-nums'] },
  raceBarTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
    alignSelf: 'stretch',
  },
  raceBarFill: {
    height: '100%',
    backgroundColor: '#60a5fa',
    borderRadius: 3,
  },
  raceBarFillWinner: { backgroundColor: '#34d399' },
  raceSummary: {
    color: '#e5e7eb',
    fontSize: 12,
    marginTop: 4,
    fontStyle: 'italic',
  },
  chipRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    maxHeight: 48,
  },
  chipRowContent: {
    paddingHorizontal: 20,
    gap: 8,
    alignItems: 'center',
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(15,17,20,0.75)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  chipDisabled: { opacity: 0.4 },
  chipActive: {
    backgroundColor: '#f5f7fa',
    borderColor: '#f5f7fa',
  },
  chipText: { color: '#f5f7fa', fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: '#0f1114' },

  inputRow: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(15,17,20,0.82)',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    paddingLeft: 6,
    paddingRight: 6,
    paddingVertical: 4,
  },
  textInput: {
    flex: 1,
    color: '#f5f7fa',
    fontSize: 15,
    paddingVertical: 10,
  },
  historyButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyRowOuter: {
    position: 'relative',
    backgroundColor: '#0f1114',
  },
  historyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.06)',
    gap: 12,
    backgroundColor: '#0f1114',
  },
  historyDeleteBg: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    width: '100%',
    backgroundColor: '#7f1d1d',
    alignItems: 'flex-end',
    justifyContent: 'center',
    paddingRight: 24,
  },
  historyDeleteText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 14,
  },
  historyStar: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyRowBody: {
    flex: 1,
  },
  historyView: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  historyPrompt: {
    color: '#f5f7fa',
    fontSize: 15,
    lineHeight: 20,
  },
  historyMeta: {
    color: '#9ba1a6',
    fontSize: 12,
    marginTop: 4,
  },
  sendButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: '#3b82f6',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: { opacity: 0.4 },

  bottomRow: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    paddingHorizontal: 32,
  },
  sideButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(15,17,20,0.7)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  micButton: {
    width: 96,
    height: 96,
    borderRadius: 48,
    backgroundColor: '#3b82f6',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.2)',
  },
  micButtonRecording: { backgroundColor: '#ef4444' },
  micButtonDisabled: { opacity: 0.5 },

  debugButton: {
    position: 'absolute',
    right: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(15,17,20,0.82)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 10,
  },

  shaderButton: {
    position: 'absolute',
    right: 64,
    height: 40,
    paddingHorizontal: 12,
    borderRadius: 20,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: 'rgba(15,17,20,0.82)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    zIndex: 10,
  },
  shaderButtonDisabled: { opacity: 0.4 },
  shaderButtonText: {
    color: '#f5f7fa',
    fontSize: 13,
    fontWeight: '600',
  },

  debugScreen: { flex: 1, backgroundColor: '#0f1114' },
  debugTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  debugTopIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  debugTitle: { color: '#f5f7fa', fontSize: 16, fontWeight: '700' },
  debugBody: { flex: 1 },
  debugBodyContent: { padding: 16, paddingBottom: 48 },
  debugText: {
    color: '#e5e7eb',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: 13,
    lineHeight: 20,
  },
  debugInferenceText: {
    color: '#fbbf24',
    marginBottom: 16,
    paddingBottom: 16,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },

  evalTopBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  evalBody: { flex: 1 },
  evalBodyContent: { padding: 16, paddingBottom: 48, gap: 12 },
  evalSectionLabel: {
    color: '#f5f7fa',
    fontSize: 15,
    fontWeight: '700',
  },
  evalCaption: {
    color: '#9ba1a6',
    fontSize: 13,
    marginTop: -6,
  },
  evalInput: {
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    borderRadius: 12,
    padding: 12,
    color: '#f5f7fa',
    fontSize: 14,
    minHeight: 80,
    textAlignVertical: 'top',
  },
  evalPrimaryButton: {
    backgroundColor: '#3b82f6',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  evalDangerButton: {
    backgroundColor: '#ef4444',
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  evalPrimaryButtonText: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 15,
  },
  evalButtonDisabled: { opacity: 0.5 },
  evalOutputBox: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 12,
    padding: 12,
  },
  evalOutputText: {
    color: '#e5e7eb',
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    fontSize: 12,
    lineHeight: 18,
  },
  evalDivider: {
    height: 1,
    backgroundColor: 'rgba(255,255,255,0.08)',
    marginVertical: 8,
  },
  evalStatusText: {
    color: '#9ba1a6',
    fontSize: 12,
  },
  evalLogBox: {
    marginTop: 8,
    gap: 8,
  },
  evalLogRow: {
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    borderRadius: 10,
    padding: 10,
    gap: 4,
  },
  evalLogHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 8,
  },
  evalLogPrompt: {
    color: '#a78bfa',
    fontSize: 12,
    fontWeight: '700',
    flex: 1,
  },
  evalLogTime: {
    color: '#6b7280',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
  },
  evalLogResponse: {
    color: '#e5e7eb',
    fontSize: 12,
    fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace' }),
    lineHeight: 17,
  },

  tutorialBody: {
    flex: 1,
    paddingHorizontal: 28,
  },
  tutorialSkip: {
    position: 'absolute',
    right: 20,
    zIndex: 10,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  tutorialSkipText: {
    color: '#9ba1a6',
    fontSize: 14,
    fontWeight: '600',
  },
  tutorialIllustration: {
    alignSelf: 'center',
    width: 168,
    height: 168,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 40,
  },
  tutorialStep: {
    color: '#9ba1a6',
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
    marginBottom: 8,
  },
  tutorialTitle: {
    color: '#f5f7fa',
    fontSize: 28,
    fontWeight: '700',
    marginBottom: 14,
  },
  tutorialBodyText: {
    color: '#c8cbce',
    fontSize: 16,
    lineHeight: 24,
  },
  tutorialChipsWrap: {
    marginTop: 28,
    gap: 12,
  },
  tutorialTrySaying: {
    color: '#9ba1a6',
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  tutorialChips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  tutorialChip: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  tutorialChipText: {
    color: '#f5f7fa',
    fontSize: 14,
    fontWeight: '500',
  },
  tutorialSpacer: { flex: 1, minHeight: 24 },
  tutorialDots: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 20,
  },
  tutorialDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.22)',
  },
  tutorialDotActive: {
    backgroundColor: '#f5f7fa',
    width: 22,
  },
  tutorialButtonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  tutorialSecondaryPlaceholder: { flex: 0, width: 0 },
  tutorialSecondaryButton: {
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.22)',
  },
  tutorialSecondaryButtonText: {
    color: '#f5f7fa',
    fontSize: 15,
    fontWeight: '600',
  },
  tutorialPrimaryButton: {
    flex: 1,
    paddingVertical: 16,
    borderRadius: 14,
    backgroundColor: '#f5f7fa',
    alignItems: 'center',
    justifyContent: 'center',
  },
  tutorialPrimaryButtonText: {
    color: '#0f1114',
    fontSize: 16,
    fontWeight: '700',
  },
});
