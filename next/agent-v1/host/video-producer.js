import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const FFMPEG = 'C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe';
export const VIDEO_LIMITS = Object.freeze({ scenes: 12, durationSeconds: 60, sceneSeconds: 10, sceneText: 300, timeoutMs: 60000 });
const FONTS = ['C:\\Windows\\Fonts\\msyh.ttc', 'C:\\Windows\\Fonts\\arial.ttf'];
const error = code => Object.assign(new Error(code), { code });
const demand = (ok, code = 'VIDEO_INVALID_PLAN') => { if (!ok) throw error(code); };
function plain(value, keys) {
  demand(value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
  demand(Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key) && 'value' in Object.getOwnPropertyDescriptor(value, key)));
}
function text(value, max, empty = false) { demand(typeof value === 'string' && value.length <= max && (empty || value.trim().length) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\uD800-\uDFFF]/u.test(value)); }
function stamp(seconds) {
  const ms = Math.round(seconds * 1000); return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}
function wrap(value) {
  const chars = [...new Intl.Segmenter('zh', { granularity: 'grapheme' }).segment(value)].map(item => item.segment);
  const lines = []; for (let offset = 0; offset < chars.length; offset += 32) lines.push(chars.slice(offset, offset + 32).join(''));
  return lines.join('\n');
}
function run(args, cwd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...args], { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let finished = false; let stderrBytes = 0; let fatal;
    const timer = setTimeout(() => { if (!finished) { fatal = error('VIDEO_TIMEOUT'); child.kill('SIGKILL'); } }, timeoutMs);
    function finish(failure) { if (finished) return; finished = true; clearTimeout(timer); failure ? reject(failure) : resolve(); }
    child.stderr.on('data', data => { stderrBytes += data.length; if (stderrBytes > 32768) { fatal = error('VIDEO_OUTPUT_LIMIT'); child.kill('SIGKILL'); } });
    child.on('error', () => finish(error('VIDEO_EXECUTABLE_UNAVAILABLE')));
    child.on('close', code => finish(fatal ?? (code === 0 ? null : error('VIDEO_RENDER_FAILED'))));
  });
}

/** Deterministic local renderer fed by an explicit injected plan provider, not an AI model itself. */
export class VideoProducer {
  constructor(registry, { planProvider, timeoutMs = VIDEO_LIMITS.timeoutMs } = {}) {
    demand(registry && typeof registry.register === 'function' && typeof registry.createWorkArea === 'function', 'VIDEO_REGISTRY_REQUIRED');
    demand(planProvider === undefined || typeof planProvider === 'function', 'VIDEO_PROVIDER_REQUIRED');
    demand(Number.isSafeInteger(timeoutMs) && timeoutMs >= 1000 && timeoutMs <= VIDEO_LIMITS.timeoutMs);
    this.registry = registry; this.planProvider = planProvider; this.timeoutMs = timeoutMs;
  }
  async produce(work) {
    demand(typeof this.planProvider === 'function', 'NOT_CONFIGURED');
    demand(work && work.action === 'bili.video' && typeof work.script === 'string' && work.script.trim().length > 0 && work.script.length <= 16000, 'VIDEO_SCRIPT_REQUIRED');
    demand(existsSync(FFMPEG), 'VIDEO_EXECUTABLE_UNAVAILABLE');
    const deadline = Date.now() + this.timeoutMs; const controller = new AbortController(); let planTimer;
    let plan;
    try {
      plan = await Promise.race([
        Promise.resolve().then(() => this.planProvider(structuredClone(work), { signal: controller.signal })),
        new Promise((_, reject) => { planTimer = setTimeout(() => { controller.abort(); reject(error('VIDEO_TIMEOUT')); }, this.timeoutMs); }),
      ]);
    } catch (failure) { throw failure?.code === 'VIDEO_TIMEOUT' ? error('VIDEO_TIMEOUT') : error('VIDEO_PLAN_FAILED'); }
    finally { clearTimeout(planTimer); }
    plain(plan, ['title', 'description', 'tags', 'scenes']); text(plan.title, 256); text(plan.description, 8000, true);
    demand(Array.isArray(plan.tags) && plan.tags.length <= 32); for (const tag of plan.tags) text(tag, 64);
    demand(Array.isArray(plan.scenes) && plan.scenes.length > 0 && plan.scenes.length <= VIDEO_LIMITS.scenes);
    let duration = 0;
    for (const scene of plan.scenes) {
      plain(scene, ['text', 'duration', 'imageRef']); text(scene.text, VIDEO_LIMITS.sceneText);
      demand(Number.isFinite(scene.duration) && scene.duration >= 0.5 && scene.duration <= VIDEO_LIMITS.sceneSeconds);
      duration += scene.duration;
      if (scene.imageRef !== undefined) demand(typeof scene.imageRef === 'string' && /^asset_[a-f0-9]{48}$/u.test(scene.imageRef));
    }
    demand(duration <= VIDEO_LIMITS.durationSeconds);
    plan = structuredClone(plan);
    const font = FONTS.find(existsSync); demand(font, 'VIDEO_FONT_UNAVAILABLE');
    const directory = this.registry.createWorkArea();
    const execute = args => { this.registry.checkWorkArea(directory); const remaining = deadline - Date.now(); demand(remaining > 0, 'VIDEO_TIMEOUT'); return run(args, directory, remaining); };
    try {
      copyFileSync(font, path.join(directory, 'font.ttf'));
      let subtitle = 'WEBVTT\n\n'; let start = 0;
      for (let index = 0; index < plan.scenes.length; index++) {
        this.registry.checkWorkArea(directory); const scene = plan.scenes[index];
        writeFileSync(path.join(directory, `scene-${index}.txt`), wrap(scene.text), { flag: 'wx', mode: 0o600 });
        const inputs = [];
        if (scene.imageRef !== undefined) {
          const asset = this.registry.resolve(scene.imageRef); demand(asset?.kind === 'image', 'VIDEO_IMAGE_REQUIRED');
          const media = this.registry.read(asset.previewRef); demand(['image/png', 'image/jpeg'].includes(media.mime), 'VIDEO_IMAGE_REQUIRED');
          const name = `image-${index}.${media.mime === 'image/png' ? 'png' : 'jpg'}`;
          writeFileSync(path.join(directory, name), media.bytes, { flag: 'wx', mode: 0o600 });
          inputs.push('-protocol_whitelist', 'file,pipe', '-loop', '1', '-c:v', media.mime === 'image/png' ? 'png' : 'mjpeg', '-i', name);
        } else inputs.push('-f', 'lavfi', '-i', `color=c=0x141e30:s=640x360:r=24:d=${scene.duration}`);
        await execute([...inputs, '-t', String(scene.duration), '-vf', `scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2,drawtext=fontfile=font.ttf:textfile=scene-${index}.txt:expansion=none:fontcolor=white:fontsize=24:line_spacing=6:x=24:y=24`,
          '-an', '-r', '24', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-threads', '1', '-fs', '30000000', `scene-${index}.mp4`]);
        subtitle += `${index + 1}\n${stamp(start)} --> ${stamp(start + scene.duration)}\n${scene.text.replace(/-->/gu, '→')}\n\n`; start += scene.duration;
      }
      writeFileSync(path.join(directory, 'concat.txt'), plan.scenes.map((_, index) => `file 'scene-${index}.mp4'`).join('\n'), { flag: 'wx' });
      await execute(['-protocol_whitelist', 'file,pipe', '-f', 'concat', '-safe', '1', '-i', 'concat.txt', '-c', 'copy', '-fs', '30000000', 'joined.mp4']);
      await execute(['-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', String(duration), '-c:a', 'pcm_s16le', '-fs', '30000000', 'audio.wav']);
      await execute(['-protocol_whitelist', 'file,pipe', '-i', 'joined.mp4', '-i', 'audio.wav', '-c:v', 'copy', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', '-fs', '30000000', 'final.mp4']);
      await execute(['-protocol_whitelist', 'file,pipe', '-i', 'final.mp4', '-frames:v', '1', '-update', '1', '-threads', '1', 'cover.png']);
      writeFileSync(path.join(directory, 'subtitles.vtt'), subtitle, { flag: 'wx', mode: 0o600 });
      const register = (filename, kind, mime) => {
        const asset = this.registry.register(this.registry.readWorkFile(directory, filename), { kind, mime });
        return { ref: asset.ref, previewRef: asset.previewRef, sha256: asset.sha256 };
      };
      const video = register('final.mp4', 'video', 'video/mp4'); const audio = register('audio.wav', 'audio', 'audio/wav');
      const cover = register('cover.png', 'image', 'image/png'); const subtitles = register('subtitles.vtt', 'subtitles', 'text/vtt');
      const publication=work.workflow?.publication??{title:plan.title,description:plan.description,tags:plan.tags,text:''};
      return { accountId: work.accountId, target: structuredClone(work.target), ...structuredClone(publication),
        video, audio: [audio], subtitles: [subtitles], cover, attachments: [] };
    } catch (failure) {
      if (typeof failure?.code === 'string' && /^(?:VIDEO_|ASSET_|NOT_CONFIGURED)/u.test(failure.code)) throw failure;
      throw error('VIDEO_PRODUCTION_FAILED');
    } finally { this.registry.removeWorkArea(directory); }
  }
}
