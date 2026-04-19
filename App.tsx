import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  Keyboard,
  Modal,
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
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import Svg, { Path, Rect } from 'react-native-svg';
import AudioRecord from 'react-native-audio-record';
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
} from 'react-native-vision-camera';
import {
  useCactusLM,
  useCactusSTT,
  setModelUrlOverride,
  type CactusLMMessage,
} from 'cactus-react-native';
import { ShaderWebView, extractShader } from './ShaderWebView';

// Route Gemma 4 E2B apple zip through Cloudflare. S3 (HF's origin) doesn't
// speak HTTP/3, so assumesHTTP3Capable was a no-op there — metrics showed
// proto=http/1.1. CF does advertise h3, so pointing at deepsteve.com should
// give the h3 flag something to negotiate.
if (__DEV__) {
  setModelUrlOverride('gemma-4-e2b-it', {
    proApple: 'https://deepsteve.com/gemma-4-e2b-it-int4-apple.zip',
  });
}
import { CANNED_SHADERS } from './cannedShaders';

const VISION_MODEL = 'gemma-4-e2b-it';

const SHADER_SYSTEM_PROMPT = `You generate GLSL ES 1.00 fragment shaders for WebGL 1. Output ONLY the shader source code — no explanation, no markdown code fences, no comments outside the shader.

The shader runs over a photo. Declare these uniforms and the varying at the top of your output:

  precision mediump float;
  uniform sampler2D u_texture;   // the input photo
  uniform float u_time;          // seconds since start
  uniform vec2 u_resolution;     // pixel dimensions
  varying vec2 v_uv;             // texture coords, 0..1

Write the final color to gl_FragColor. Modify the photo according to the user's request. Clamp the final RGB to [0, 1] so additive effects don't blow out to white.`;
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

type Screen = 'camera' | 'review' | 'promptEval';

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
  const [screen, setScreen] = useState<Screen>('camera');
  const [photoUri, setPhotoUri] = useState<string | null>(null);

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

  const handlePhotoTaken = useCallback((uri: string) => {
    setPhotoUri(uri);
    setScreen('review');
  }, []);

  const handleDiscard = useCallback(() => {
    setPhotoUri(null);
    setScreen('camera');
  }, []);

  if (screen === 'camera') {
    return (
      <CameraScreen
        onPhoto={handlePhotoTaken}
        onPromptEval={() => setScreen('promptEval')}
      />
    );
  }
  if (screen === 'promptEval') {
    return <PromptEvalScreen onBack={() => setScreen('camera')} lm={lm} />;
  }
  return <ReviewScreen photoUri={photoUri} onDiscard={handleDiscard} lm={lm} stt={stt} />;
}

function CameraScreen({
  onPhoto,
  onPromptEval,
}: {
  onPhoto: (uri: string) => void;
  onPromptEval: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState(false);
  const [position, setPosition] = useState<'back' | 'front'>('back');
  const device = useCameraDevice(position);
  const { hasPermission, requestPermission } = useCameraPermission();
  const photoOutput = usePhotoOutput();

  useEffect(() => {
    if (!hasPermission) requestPermission();
  }, [hasPermission, requestPermission]);

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
        isActive={true}
        outputs={[photoOutput]}
      />

      <View style={[styles.cameraTopBar, { paddingTop: insets.top + 8 }]}>
        <View style={{ flex: 1 }} />
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
        <View style={styles.cameraBottomSlot} />
      </View>
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

  const [isRecording, setIsRecording] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDebug, setShowDebug] = useState(false);
  const [typed, setTyped] = useState('');
  const [nowMs, setNowMs] = useState(Date.now());
  const [downloadStartMs, setDownloadStartMs] = useState<number | null>(null);
  useEffect(() => {
    if (lm.isDownloading && downloadStartMs == null) setDownloadStartMs(Date.now());
    if (!lm.isDownloading && lm.isDownloaded) setDownloadStartMs(null);
  }, [lm.isDownloading, lm.isDownloaded, downloadStartMs]);
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
          {
            role: 'user',
            content: prompt,
            images: [photoUri],
          },
        ];
        await lm.complete({
          messages,
          options: { maxTokens: 512, temperature: 0.2 },
          onToken: (token: string) => {
            if (firstTokenAt == null) firstTokenAt = Date.now();
            tokenCount += 1;
            setResponse(prev => prev + token);
          },
        });
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
    [photoUri, lm],
  );

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
      setTranscript(prompt);
      setResponse('');
      const canned = CANNED_SHADERS[label];
      if (canned) {
        // Pre-baked shader from the eval rounds — skip Gemma entirely.
        setManualShader(canned);
      } else {
        setManualShader(null);
        askGemma(prompt);
      }
    },
    [askGemma, isGenerating, isFinalizing, isRecording],
  );

  const handleSendTyped = useCallback(() => {
    const trimmed = typed.trim();
    if (!trimmed || isGenerating || isFinalizing || isRecording) return;
    setError(null);
    setTranscript(trimmed);
    setResponse('');
    setTyped('');
    setManualShader(null);
    askGemma(trimmed);
  }, [typed, askGemma, isGenerating, isFinalizing, isRecording]);

  const handleShare = useCallback(async () => {
    if (!photoUri) return;
    try {
      await Share.share({ url: photoUri });
    } catch (err) {
      Alert.alert('Share failed', err instanceof Error ? err.message : String(err));
    }
  }, [photoUri]);

  const handleCopyDebug = useCallback(async () => {
    const parts = [
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
  }, [inferenceDebug, response]);

  const shaderSource = useMemo(
    () =>
      manualShader ??
      (response && !isGenerating ? extractShader(response) : null),
    [manualShader, response, isGenerating],
  );

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
        <Image source={{ uri: photoUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ) : null}
      {photoUri && shaderSource && !isGenerating ? (
        <ShaderWebView
          photoUri={photoUri}
          shader={shaderSource}
          style={StyleSheet.absoluteFill}
          onError={msg => setError(`Shader: ${msg}`)}
        />
      ) : null}
      <View style={[StyleSheet.absoluteFill, styles.scrim]} />

      <Pressable
        onPress={() => setShowDebug(true)}
        hitSlop={12}
        style={[styles.debugButton, { top: insets.top + 12 }]}
      >
        <DebugIcon color="#fff" size={20} />
      </Pressable>

      <ScrollView
        style={[styles.outputBox, { marginTop: insets.top + 12 }]}
        contentContainerStyle={styles.outputContent}
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
          <Text style={styles.statusText}>{statusLine}</Text>
        ) : null}
        {transcript ? (
          <Text style={styles.transcriptText}>
            <Text style={styles.transcriptLabel}>You: </Text>
            {transcript}
          </Text>
        ) : null}
        {response ? (
          <Text style={styles.responseText}>
            <Text style={styles.responseLabel}>Gemma: </Text>
            {response}
            {isGenerating ? <Text style={styles.cursor}>▍</Text> : null}
          </Text>
        ) : null}
        {error ? <Text style={styles.errorText}>{error}</Text> : null}
      </ScrollView>

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
          const disabled = isCanned
            ? isRecording || isFinalizing || isGenerating
            : micDisabled || isRecording;
          return (
            <Pressable
              key={ex.label}
              onPress={() => handleExamplePrompt(ex.label, ex.prompt)}
              disabled={disabled}
              style={[styles.chip, disabled && styles.chipDisabled]}
              hitSlop={6}
            >
              <Text style={styles.chipText}>{ex.label}</Text>
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
          <SendIcon color="#fff" size={20} />
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

        <Pressable onPress={handleShare} style={styles.sideButton} hitSlop={12}>
          <ShareIcon color="#fff" size={24} />
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
  chipText: { color: '#f5f7fa', fontSize: 13, fontWeight: '600' },

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
    paddingLeft: 16,
    paddingRight: 6,
    paddingVertical: 4,
  },
  textInput: {
    flex: 1,
    color: '#f5f7fa',
    fontSize: 15,
    paddingVertical: 10,
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
});
