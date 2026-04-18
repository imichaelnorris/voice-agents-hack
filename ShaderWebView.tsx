import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View, type ViewStyle } from 'react-native';
import { WebView } from 'react-native-webview';
import * as RNFS from '@dr.pogodin/react-native-fs';

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
  html, body { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
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

export function ShaderWebView({
  photoUri,
  shader,
  style,
  onError,
}: {
  photoUri: string;
  shader: string;
  style?: ViewStyle;
  onError?: (msg: string) => void;
}) {
  const [imageDataUri, setImageDataUri] = useState<string | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);

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
    return () => { cancelled = true; };
  }, [photoUri, onError]);

  const html = useMemo(() => {
    if (!imageDataUri) return null;
    return htmlFor(shader, imageDataUri);
  }, [shader, imageDataUri]);

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
      source={{ html, baseUrl: '' }}
      style={[styles.webview, style]}
      originWhitelist={['*']}
      scrollEnabled={false}
      bounces={false}
      javaScriptEnabled
      allowFileAccess
      mixedContentMode="always"
      androidLayerType="hardware"
      pointerEvents="none"
      onMessage={ev => {
        try {
          const data = JSON.parse(ev.nativeEvent.data) as { type: string; msg?: string };
          if (data.type === 'error' && data.msg) onError?.(data.msg);
        } catch {}
      }}
    />
  );
}

const styles = StyleSheet.create({
  webview: { backgroundColor: '#000' },
  fallback: { backgroundColor: '#0f1114', alignItems: 'center', justifyContent: 'center' },
});
