import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { ActivityIndicator, StyleSheet, View, type ViewStyle } from 'react-native';
import { WebView } from 'react-native-webview';
import * as RNFS from '@dr.pogodin/react-native-fs';

// Static heuristic: a shader is "animated" if it reads u_time somewhere
// beyond its uniform declaration. Comments are stripped first so a commented-
// out reference doesn't flip the flag.
export function isShaderAnimated(src: string): boolean {
  if (!src) return false;
  const stripped = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const matches = stripped.match(/\bu_time\b/g);
  return (matches?.length ?? 0) > 1;
}

// Pull a fragment shader source out of whatever Gemma emits — handles
// fenced markdown, leading prose, and the bare-source happy path.
export function extractShader(text: string): string | null {
  if (!text) return null;
  const fence = text.match(/```(?:glsl|frag|fragment|hlsl|c)?\s*\n([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  const precision = text.search(/precision\s+(?:lowp|mediump|highp)\s+float/);
  if (precision !== -1) return text.slice(precision).trim();
  return text.trim();
}

const VERTEX_SHADER = `attribute vec2 a_position;
varying vec2 v_uv;
void main() {
  // Texture v_uv: y is flipped so the photo isn't upside down.
  v_uv = vec2((a_position.x + 1.0) * 0.5, 1.0 - (a_position.y + 1.0) * 0.5);
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

function htmlFor(fragSrc: string, imageDataUri: string): string {
  // Embed the shader and image directly. Escape backticks/JS terminators
  // since we're doing string interpolation into a script tag.
  const safeFrag = JSON.stringify(fragSrc);
  const safeVert = JSON.stringify(VERTEX_SHADER);
  const safeImg = JSON.stringify(imageDataUri);
  return `<!DOCTYPE html>
<html><head>
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<style>
  html, body { margin: 0; padding: 0; height: 100%; background: transparent; overflow: hidden; }
  canvas { display: block; width: 100%; height: 100%; }
  #err { position: fixed; left: 0; right: 0; bottom: 0; max-height: 50%; overflow: auto; color: #f87171; background: rgba(0,0,0,0.85); padding: 8px; font: 11px ui-monospace, monospace; white-space: pre-wrap; display: none; }
</style></head>
<body>
<canvas id="c"></canvas>
<pre id="err"></pre>
<script>
(function(){
  function reportError(msg){
    var e = document.getElementById('err');
    e.textContent = msg;
    e.style.display = 'block';
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify({type:'error', msg: msg}));
    }
  }
  try {
    var canvas = document.getElementById('c');
    var dpr = window.devicePixelRatio || 1;
    function size(){
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
    }
    size();
    window.addEventListener('resize', size);

    var gl = canvas.getContext('webgl', { preserveDrawingBuffer: false, antialias: true });
    if (!gl) { reportError('WebGL not available'); return; }

    function compile(type, src){
      var s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error((type === gl.FRAGMENT_SHADER ? 'Fragment' : 'Vertex') + ' shader compile error:\\n' + gl.getShaderInfoLog(s));
      }
      return s;
    }

    var vs = compile(gl.VERTEX_SHADER, ${safeVert});
    var fs = compile(gl.FRAGMENT_SHADER, ${safeFrag});
    var prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('Program link error:\\n' + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);

    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    var aPos = gl.getAttribLocation(prog, 'a_position');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    var uTex = gl.getUniformLocation(prog, 'u_texture');
    var uTime = gl.getUniformLocation(prog, 'u_time');
    var uRes = gl.getUniformLocation(prog, 'u_resolution');

    var img = new Image();
    img.onerror = function(){ reportError('Failed to load image'); };
    img.onload = function(){
      try {
        var tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.activeTexture(gl.TEXTURE0);
        gl.uniform1i(uTex, 0);

        var start = performance.now();
        function render(){
          gl.viewport(0, 0, canvas.width, canvas.height);
          if (uTime) gl.uniform1f(uTime, (performance.now() - start) / 1000);
          if (uRes) gl.uniform2f(uRes, canvas.width, canvas.height);
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
          requestAnimationFrame(render);
        }
        render();

        // Build a fresh offscreen GL context + program + photo texture at the
        // requested size. Used for still-frame capture and for video
        // recording, which need preserveDrawingBuffer and their own render
        // target independent of the visible canvas.
        function setupOffscreen(w, h){
          var off = document.createElement('canvas');
          off.width = w; off.height = h;
          var og = off.getContext('webgl', { preserveDrawingBuffer: true, antialias: true });
          if (!og) throw new Error('Offscreen WebGL unavailable');
          function ocompile(type, src){
            var s = og.createShader(type);
            og.shaderSource(s, src);
            og.compileShader(s);
            if (!og.getShaderParameter(s, og.COMPILE_STATUS)) {
              throw new Error((type === og.FRAGMENT_SHADER ? 'Fragment' : 'Vertex') + ' compile:\\n' + og.getShaderInfoLog(s));
            }
            return s;
          }
          var ovs = ocompile(og.VERTEX_SHADER, ${safeVert});
          var ofs = ocompile(og.FRAGMENT_SHADER, ${safeFrag});
          var oprog = og.createProgram();
          og.attachShader(oprog, ovs);
          og.attachShader(oprog, ofs);
          og.linkProgram(oprog);
          if (!og.getProgramParameter(oprog, og.LINK_STATUS)) {
            throw new Error('Link:\\n' + og.getProgramInfoLog(oprog));
          }
          og.useProgram(oprog);
          var obuf = og.createBuffer();
          og.bindBuffer(og.ARRAY_BUFFER, obuf);
          og.bufferData(og.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), og.STATIC_DRAW);
          var oaPos = og.getAttribLocation(oprog, 'a_position');
          og.enableVertexAttribArray(oaPos);
          og.vertexAttribPointer(oaPos, 2, og.FLOAT, false, 0, 0);
          var otex = og.createTexture();
          og.bindTexture(og.TEXTURE_2D, otex);
          og.pixelStorei(og.UNPACK_FLIP_Y_WEBGL, false);
          og.texImage2D(og.TEXTURE_2D, 0, og.RGBA, og.RGBA, og.UNSIGNED_BYTE, img);
          og.texParameteri(og.TEXTURE_2D, og.TEXTURE_WRAP_S, og.CLAMP_TO_EDGE);
          og.texParameteri(og.TEXTURE_2D, og.TEXTURE_WRAP_T, og.CLAMP_TO_EDGE);
          og.texParameteri(og.TEXTURE_2D, og.TEXTURE_MIN_FILTER, og.LINEAR);
          og.texParameteri(og.TEXTURE_2D, og.TEXTURE_MAG_FILTER, og.LINEAR);
          og.activeTexture(og.TEXTURE0);
          og.uniform1i(og.getUniformLocation(oprog, 'u_texture'), 0);
          return {
            canvas: off, gl: og, prog: oprog, w: w, h: h,
            uTime: og.getUniformLocation(oprog, 'u_time'),
            uRes: og.getUniformLocation(oprog, 'u_resolution')
          };
        }

        // One-shot PNG at the photo's native resolution.
        window.__captureFrame = function(){
          try {
            var w = img.naturalWidth || img.width;
            var h = img.naturalHeight || img.height;
            if (!w || !h) throw new Error('Image not ready');
            var s = setupOffscreen(w, h);
            if (s.uTime) s.gl.uniform1f(s.uTime, (performance.now() - start) / 1000);
            if (s.uRes) s.gl.uniform2f(s.uRes, w, h);
            s.gl.viewport(0, 0, w, h);
            s.gl.drawArrays(s.gl.TRIANGLE_STRIP, 0, 4);
            var url = s.canvas.toDataURL('image/png');
            if (window.ReactNativeWebView) {
              window.ReactNativeWebView.postMessage(JSON.stringify({type:'capture', data: url}));
            }
          } catch (e) {
            if (window.ReactNativeWebView) {
              window.ReactNativeWebView.postMessage(JSON.stringify({type:'capture_error', msg: String(e && e.message || e)}));
            }
          }
        };

        // Record the offscreen canvas for durationMs via MediaRecorder. The
        // encoder tops out on huge canvases, so the long side is capped at
        // 1920 while preserving aspect. u_time resets to 0 at record start so
        // the clip plays from the beginning of the animation.
        window.__captureVideo = function(durationMs){
          try {
            if (typeof MediaRecorder === 'undefined') {
              throw new Error('MediaRecorder not supported in this WebView');
            }
            var w = img.naturalWidth || img.width;
            var h = img.naturalHeight || img.height;
            if (!w || !h) throw new Error('Image not ready');
            var MAX_SIDE = 1920;
            var scale = Math.min(1, MAX_SIDE / Math.max(w, h));
            w = Math.max(2, Math.floor(w * scale));
            h = Math.max(2, Math.floor(h * scale));
            var s = setupOffscreen(w, h);

            var stream = s.canvas.captureStream(30);
            var candidates = [
              'video/mp4;codecs=avc1',
              'video/mp4',
              'video/webm;codecs=vp9',
              'video/webm;codecs=vp8',
              'video/webm'
            ];
            var mime = '';
            for (var i = 0; i < candidates.length; i++) {
              if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(candidates[i])) {
                mime = candidates[i]; break;
              }
            }
            if (!mime) throw new Error('No supported video MIME type');
            var rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6000000 });
            var chunks = [];
            rec.ondataavailable = function(e){ if (e.data && e.data.size) chunks.push(e.data); };
            rec.onerror = function(ev){
              if (window.ReactNativeWebView) {
                window.ReactNativeWebView.postMessage(JSON.stringify({type:'video_error', msg: String((ev && ev.error && ev.error.message) || 'recorder error')}));
              }
            };
            rec.onstop = function(){
              try {
                var blob = new Blob(chunks, { type: mime.split(';')[0] });
                var reader = new FileReader();
                reader.onloadend = function(){
                  var dataUrl = String(reader.result || '');
                  var base64 = dataUrl.split(',')[1] || '';
                  if (window.ReactNativeWebView) {
                    window.ReactNativeWebView.postMessage(JSON.stringify({type:'video', mime: mime.split(';')[0], data: base64}));
                  }
                };
                reader.onerror = function(){
                  if (window.ReactNativeWebView) {
                    window.ReactNativeWebView.postMessage(JSON.stringify({type:'video_error', msg: 'read failed'}));
                  }
                };
                reader.readAsDataURL(blob);
              } catch (e) {
                if (window.ReactNativeWebView) {
                  window.ReactNativeWebView.postMessage(JSON.stringify({type:'video_error', msg: String(e && e.message || e)}));
                }
              }
            };

            var recStart = performance.now();
            var raf = 0;
            function drawOff(){
              var now = performance.now();
              if (s.uTime) s.gl.uniform1f(s.uTime, (now - recStart) / 1000);
              if (s.uRes) s.gl.uniform2f(s.uRes, w, h);
              s.gl.viewport(0, 0, w, h);
              s.gl.drawArrays(s.gl.TRIANGLE_STRIP, 0, 4);
              if (now - recStart < durationMs) {
                raf = requestAnimationFrame(drawOff);
              } else {
                if (raf) cancelAnimationFrame(raf);
                try { rec.stop(); } catch (e) {}
              }
            }
            rec.start();
            raf = requestAnimationFrame(drawOff);
          } catch (e) {
            if (window.ReactNativeWebView) {
              window.ReactNativeWebView.postMessage(JSON.stringify({type:'video_error', msg: String(e && e.message || e)}));
            }
          }
        };

        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify({type:'ready'}));
        }
      } catch (e) {
        reportError(String(e && e.message || e));
      }
    };
    img.src = ${safeImg};
  } catch (e) {
    reportError(String(e && e.message || e));
  }
})();
</script></body></html>`;
}

export type ShaderWebViewHandle = {
  // Resolves with a `data:image/png;base64,...` URI of the currently-rendered
  // frame, or rejects if the WebView isn't ready or the canvas read fails.
  capture: () => Promise<string>;
  // Record the offscreen canvas for durationMs and resolve with the encoded
  // video as base64 plus its MIME type. On iOS WKWebView that's normally
  // `video/mp4`. Rejects if MediaRecorder isn't available.
  captureVideo: (durationMs: number) => Promise<{ data: string; mime: string }>;
};

type ShaderWebViewProps = {
  photoUri: string;
  shader: string;
  style?: ViewStyle;
  onError?: (msg: string) => void;
};

export const ShaderWebView = forwardRef<ShaderWebViewHandle, ShaderWebViewProps>(
  function ShaderWebView({ photoUri, shader, style, onError }, ref) {
    const [imageDataUri, setImageDataUri] = useState<string | null>(null);
    const [readErr, setReadErr] = useState<string | null>(null);
    const webRef = useRef<WebView | null>(null);
    const pendingCapture = useRef<{
      resolve: (v: string) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    } | null>(null);
    const pendingVideo = useRef<{
      resolve: (v: { data: string; mime: string }) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    } | null>(null);

    useEffect(() => {
      let cancelled = false;
      const path = photoUri.startsWith('file://') ? photoUri.slice(7) : photoUri;
      RNFS.readFile(path, 'base64')
        .then(b64 => {
          if (cancelled) return;
          const ext = path.toLowerCase().endsWith('.png') ? 'png' : 'jpeg';
          setImageDataUri(`data:image/${ext};base64,${b64}`);
        })
        .catch(e => {
          if (cancelled) return;
          const msg = e instanceof Error ? e.message : String(e);
          setReadErr(msg);
          onError?.(`Photo read: ${msg}`);
        });
      return () => {
        cancelled = true;
      };
    }, [photoUri, onError]);

    const html = useMemo(() => {
      if (!imageDataUri) return null;
      return htmlFor(shader, imageDataUri);
    }, [shader, imageDataUri]);

    useImperativeHandle(
      ref,
      () => ({
        capture: () =>
          new Promise<string>((resolve, reject) => {
            const wv = webRef.current;
            if (!wv) {
              reject(new Error('Shader view not mounted'));
              return;
            }
            if (pendingCapture.current) {
              pendingCapture.current.reject(new Error('Superseded by newer capture'));
              clearTimeout(pendingCapture.current.timer);
            }
            const timer = setTimeout(() => {
              if (pendingCapture.current) {
                const p = pendingCapture.current;
                pendingCapture.current = null;
                p.reject(new Error('Capture timed out'));
              }
            }, 4000);
            pendingCapture.current = { resolve, reject, timer };
            wv.injectJavaScript(
              'try{window.__captureFrame && window.__captureFrame();}catch(e){};true;',
            );
          }),
        captureVideo: (durationMs: number) =>
          new Promise<{ data: string; mime: string }>((resolve, reject) => {
            const wv = webRef.current;
            if (!wv) {
              reject(new Error('Shader view not mounted'));
              return;
            }
            if (pendingVideo.current) {
              pendingVideo.current.reject(new Error('Superseded by newer recording'));
              clearTimeout(pendingVideo.current.timer);
            }
            // Generous slack on top of durationMs for encoder finalize +
            // postMessage of a multi-MB base64 payload.
            const timer = setTimeout(() => {
              if (pendingVideo.current) {
                const p = pendingVideo.current;
                pendingVideo.current = null;
                p.reject(new Error('Video capture timed out'));
              }
            }, durationMs + 15000);
            pendingVideo.current = { resolve, reject, timer };
            const payload = JSON.stringify(durationMs);
            wv.injectJavaScript(
              `try{window.__captureVideo && window.__captureVideo(${payload});}catch(e){};true;`,
            );
          }),
      }),
      [],
    );

    if (readErr) {
      return <View style={[styles.fallback, style]} />;
    }
    if (!html) {
      return (
        <View style={[styles.fallback, style]}>
          <ActivityIndicator color="#9ba1a6" />
        </View>
      );
    }
    return (
      <WebView
        ref={webRef}
        source={{ html, baseUrl: '' }}
        style={[styles.webview, style]}
        originWhitelist={['*']}
        scrollEnabled={false}
        bounces={false}
        javaScriptEnabled
        allowFileAccess
        mixedContentMode="always"
        androidLayerType="hardware"
        opaque={false}
        pointerEvents="none"
        onMessage={ev => {
          try {
            const data = JSON.parse(ev.nativeEvent.data) as {
              type: string;
              msg?: string;
              data?: string;
              mime?: string;
            };
            if (data.type === 'error' && data.msg) onError?.(data.msg);
            if (data.type === 'capture' && data.data && pendingCapture.current) {
              const p = pendingCapture.current;
              pendingCapture.current = null;
              clearTimeout(p.timer);
              p.resolve(data.data);
            }
            if (data.type === 'capture_error' && pendingCapture.current) {
              const p = pendingCapture.current;
              pendingCapture.current = null;
              clearTimeout(p.timer);
              p.reject(new Error(data.msg || 'Capture failed'));
            }
            if (
              data.type === 'video' &&
              data.data &&
              data.mime &&
              pendingVideo.current
            ) {
              const p = pendingVideo.current;
              pendingVideo.current = null;
              clearTimeout(p.timer);
              p.resolve({ data: data.data, mime: data.mime });
            }
            if (data.type === 'video_error' && pendingVideo.current) {
              const p = pendingVideo.current;
              pendingVideo.current = null;
              clearTimeout(p.timer);
              p.reject(new Error(data.msg || 'Video capture failed'));
            }
          } catch {}
        }}
      />
    );
  },
);

const styles = StyleSheet.create({
  webview: { backgroundColor: 'transparent' },
  fallback: { backgroundColor: '#0f1114', alignItems: 'center', justifyContent: 'center' },
});
