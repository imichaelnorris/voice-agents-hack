import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Image,
  PermissionsAndroid,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StatusBar,
  StyleSheet,
  Text,
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
  type CactusLMMessage,
} from 'cactus-react-native';

const VISION_MODEL = 'gemma-4-e2b-it';
const VISION_MODEL_OPTIONS = { quantization: 'int4' as const, pro: false };
const STT_MODEL = 'whisper-small';
const STT_MODEL_OPTIONS = { quantization: 'int8' as const, pro: false };

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

type Screen = 'camera' | 'review';

export default function App() {
  const isDarkMode = useColorScheme() === 'dark';
  return (
    <SafeAreaProvider>
      <StatusBar barStyle={isDarkMode ? 'light-content' : 'dark-content'} />
      <Root />
    </SafeAreaProvider>
  );
}

function Root() {
  const [screen, setScreen] = useState<Screen>('camera');
  const [photoUri, setPhotoUri] = useState<string | null>(null);

  const handlePhotoTaken = useCallback((uri: string) => {
    setPhotoUri(uri);
    setScreen('review');
  }, []);

  const handleDiscard = useCallback(() => {
    setPhotoUri(null);
    setScreen('camera');
  }, []);

  if (screen === 'camera') {
    return <CameraScreen onPhoto={handlePhotoTaken} />;
  }
  return <ReviewScreen photoUri={photoUri} onDiscard={handleDiscard} />;
}

function CameraScreen({ onPhoto }: { onPhoto: (uri: string) => void }) {
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
      </View>
    </View>
  );
}

function ReviewScreen({
  photoUri,
  onDiscard,
}: {
  photoUri: string | null;
  onDiscard: () => void;
}) {
  const insets = useSafeAreaInsets();
  const lm = useCactusLM({ model: VISION_MODEL, options: VISION_MODEL_OPTIONS });
  const stt = useCactusSTT({ model: STT_MODEL, options: STT_MODEL_OPTIONS });

  const [isRecording, setIsRecording] = useState(false);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [response, setResponse] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const audioBuffer = useRef<number[]>([]);
  const dataSub = useRef<{ remove: () => void } | null>(null);

  useEffect(() => {
    AudioRecord.init(AUDIO_OPTS);
  }, []);

  const lmAttempted = useRef(false);
  const sttAttempted = useRef(false);

  useEffect(() => {
    if (!lm.isDownloaded && !lm.isDownloading && !lmAttempted.current) {
      lmAttempted.current = true;
      lm.download().catch(e => setError(`LM download: ${String(e)}`));
    }
  }, [lm.isDownloaded, lm.isDownloading, lm.download]);

  useEffect(() => {
    if (!stt.isDownloaded && !stt.isDownloading && !sttAttempted.current) {
      sttAttempted.current = true;
      stt.download().catch(e => setError(`STT download: ${String(e)}`));
    }
  }, [stt.isDownloaded, stt.isDownloading, stt.download]);

  useEffect(() => {
    return () => {
      dataSub.current?.remove();
    };
  }, []);

  const askGemma = useCallback(
    async (prompt: string) => {
      if (!photoUri || !prompt.trim()) return;
      setIsGenerating(true);
      setResponse('');
      setError(null);
      try {
        const messages: CactusLMMessage[] = [
          {
            role: 'user',
            content: prompt,
            images: [photoUri],
          },
        ];
        await lm.complete({
          messages,
          options: { maxTokens: 512, temperature: 0.7 },
          onToken: (token: string) => {
            setResponse(prev => prev + token);
          },
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
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

  const handleShare = useCallback(async () => {
    if (!photoUri) return;
    try {
      await Share.share({ url: photoUri });
    } catch (err) {
      Alert.alert('Share failed', err instanceof Error ? err.message : String(err));
    }
  }, [photoUri]);

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
    : 'Tap the mic and ask Gemma about your photo.';

  const micDisabled = lmBusy || sttBusy || isGenerating || isFinalizing;

  return (
    <View style={styles.screen}>
      {photoUri ? (
        <Image source={{ uri: photoUri }} style={StyleSheet.absoluteFill} resizeMode="cover" />
      ) : null}
      <View style={[StyleSheet.absoluteFill, styles.scrim]} />

      <ScrollView
        style={[styles.outputBox, { marginTop: insets.top + 12 }]}
        contentContainerStyle={styles.outputContent}
      >
        {statusLine ? <Text style={styles.statusText}>{statusLine}</Text> : null}
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
    alignItems: 'center',
    paddingTop: 16,
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
    right: 16,
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
});
