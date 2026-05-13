// TMB Phantom Reel Renderer v2 - Railway worker
// Polls Supabase phantom_reel_jobs WHERE status='manifest_ready' every 30s,
// builds 9:16 fair-use split-screen video, uploads 3 hook variants, marks completed.
// v2: audio_url is optional - falls back to trending clip's own audio track.

import { createClient } from '@supabase/supabase-js';
import ffmpeg from 'fluent-ffmpeg';
import { readFile, unlink, mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
  process.exit(1);
}
const sb = createClient(SUPABASE_URL, SERVICE_KEY);

const POLL_INTERVAL_MS = 30_000;
const TMP_DIR = join(tmpdir(), 'phantom-reels');
await mkdir(TMP_DIR, { recursive: true });

async function downloadFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download ${url} -> ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

// Build SRT from highlighted_terms + hook + main audio narration timeline.
// Simplified: each ~2-second window gets one short caption.
function buildSrt(hookText, narration, duration, highlights) {
  const lines = [hookText, ...narration.split(/(?<=[.!?])\s+/).slice(0, 18)];
  const perLine = Math.max(1.5, duration / lines.length);
  const fmtT = (s) => {
    const h = Math.floor(s / 3600).toString().padStart(2, '0');
    const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
    const sec = (s % 60).toFixed(3).padStart(6, '0').replace('.', ',');
    return `${h}:${m}:${sec}`;
  };
  return lines.map((line, i) => {
    let styled = line.toUpperCase().slice(0, 80);
    for (const term of highlights) {
      const re = new RegExp(`\\b${term}\\b`, 'gi');
      styled = styled.replace(re, `<font color="#FCD34D">${term}</font>`);
    }
    const start = fmtT(i * perLine);
    const end = fmtT(Math.min(duration, (i + 1) * perLine));
    return `${i + 1}\n${start} --> ${end}\n${styled}\n`;
  }).join('\n');
}

// Core FFmpeg pipeline. Produces ONE 9:16 mp4 per hook variant.
// Layout:
//   - Canvas 1080x1920 dark slate background
//   - TOP half (1080x960): scaled trending clip, looped to audio length
//   - Bottom-corner @username text overlay on top half
//   - BOTTOM half (1080x960): dark institutional background with hook text + animated subtitles
//   - Audio: Polly narration if audioPath given, otherwise trending clip's own audio track
function renderVariant({
  trendingClipPath, audioPath, srtPath, hookText, authorHandle, outputPath, duration,
}) {
  return new Promise((resolve, reject) => {
    const HOOK_DURATION_SEC = 3;
    const hasNarration = !!audioPath;
    const cmd = ffmpeg()
      .input(trendingClipPath).inputOptions(['-stream_loop -1']);
    if (hasNarration) cmd.input(audioPath);
    cmd
      .complexFilter([
        // Top half: scale + crop trending clip to 1080x960
        '[0:v]scale=1080:960:force_original_aspect_ratio=increase,crop=1080:960[top]',
        // Bottom half: dark slate background 1080x960
        'color=c=0x0B1220:s=1080x960:d=' + duration + '[bgbot]',
        // Subtle author handle overlay on TOP half (bottom-left corner)
        '[top]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text=\'' + (authorHandle || '@source').replace(/[\\\'":]/g, '') + '\':x=24:y=H-th-24:fontsize=28:fontcolor=white@0.85:box=1:boxcolor=black@0.55:boxborderw=8[topa]',
        // Bottom half: big bold hook text centered top (for first 3 seconds)
        '[bgbot]drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text=\'' + hookText.replace(/[\\\'":]/g, '').toUpperCase().slice(0, 120) + '\':x=(w-text_w)/2:y=60:fontsize=44:fontcolor=white:line_spacing=12:enable=\'lte(t,' + HOOK_DURATION_SEC + ')\'[bota]',
        // Subtitles burned in on bottom half (only after the hook window)
        '[bota]subtitles=' + srtPath.replace(/\\/g, '/').replace(/:/g, '\\:') + ':force_style=\'FontName=DejaVu Sans Bold,Alignment=2,PrimaryColour=&H00FFFFFF,BorderStyle=3,BackColour=&H80000000,Outline=2,Fontsize=36,MarginV=80\'[botb]',
        // Stack top over bottom
        '[topa][botb]vstack=inputs=2[v]',
      ], 'v')
      .outputOptions([
        '-map [v]',
        // Audio: prefer narration input if given, else use trending clip's audio (input 0)
        '-map ' + (hasNarration ? '1:a' : '0:a?'),
        '-t ' + duration,
        '-c:v libx264',
        '-pix_fmt yuv420p',
        '-preset veryfast',
        '-crf 23',
        '-c:a aac',
        '-b:a 128k',
        '-movflags +faststart',
        '-shortest',
      ])
      .output(outputPath)
      .on('start', (cmdLine) => console.log('[ffmpeg]', cmdLine.slice(0, 200) + '...'))
      .on('end', () => resolve(outputPath))
      .on('error', (err) => reject(err))
      .run();
  });
}

async function processJob(job) {
  const tmp = join(TMP_DIR, `job-${job.id}`);
  await mkdir(tmp, { recursive: true });

  const clip = (job.broll_clips || [])[0];
  if (!clip?.mp4_url) throw new Error('no trending clip mp4_url in job');

  const trendingPath = join(tmp, 'trending.mp4');
  let audioPath = null;
  console.log(`[job ${job.id}] downloading trending clip${job.audio_url ? ' + narration audio' : ' (using clip audio fallback)'}...`);
  await downloadFile(clip.mp4_url, trendingPath);
  if (job.audio_url) {
    audioPath = join(tmp, 'audio.mp3');
    await downloadFile(job.audio_url, audioPath);
  }

  const duration = job.audio_duration_sec || 60;
  const narration = job.hook_a_fear || '';
  const srtPath = join(tmp, 'subs.srt');

  const variants = [
    { key: 'a', hook: job.hook_a_fear, slot: 'hook-a.mp4' },
    { key: 'b', hook: job.hook_b_capital, slot: 'hook-b.mp4' },
    { key: 'c', hook: job.hook_c_contrarian, slot: 'hook-c.mp4' },
  ];

  const outputs = {};
  for (const v of variants) {
    if (!v.hook) continue;
    const outPath = join(tmp, v.slot);
    await writeFile(srtPath, buildSrt(v.hook, narration, duration, job.highlighted_terms || []));
    console.log(`[job ${job.id}] rendering variant ${v.key}...`);
    await renderVariant({
      trendingClipPath: trendingPath,
      audioPath,
      srtPath,
      hookText: v.hook,
      authorHandle: clip.author_handle || '',
      outputPath: outPath,
      duration,
    });

    const buf = await readFile(outPath);
    const storagePath = `${job.article_id}/${v.slot}`;
    const { error: upErr } = await sb.storage.from('phantom-reels').upload(storagePath, buf, {
      contentType: 'video/mp4',
      upsert: true,
    });
    if (upErr) throw new Error(`upload variant ${v.key}: ${upErr.message}`);
    const { data: pub } = sb.storage.from('phantom-reels').getPublicUrl(storagePath);
    outputs[`output_${v.key}_url`] = pub.publicUrl;
    await unlink(outPath).catch(() => {});
  }

  await unlink(trendingPath).catch(() => {});
  if (audioPath) await unlink(audioPath).catch(() => {});
  await unlink(srtPath).catch(() => {});

  const { error: dbErr } = await sb.from('phantom_reel_jobs').update({
    status: 'completed',
    ...outputs,
    render_service: 'railway-ffmpeg',
    completed_at: new Date().toISOString(),
  }).eq('id', job.id);
  if (dbErr) throw new Error(`db update: ${dbErr.message}`);

  console.log(`[job ${job.id}] DONE`, outputs);
}

async function poll() {
  try {
    const { data, error } = await sb.from('phantom_reel_jobs')
      .select('*').eq('status', 'manifest_ready')
      .order('created_at', { ascending: true }).limit(1);
    if (error) throw error;
    if (!data?.length) return;
    const job = data[0];
    console.log(`[poll] picked job ${job.id} article=${job.article_id}`);
    await sb.from('phantom_reel_jobs').update({ status: 'rendering' }).eq('id', job.id);
    try {
      await processJob(job);
    } catch (e) {
      console.error(`[job ${job.id}] FAILED:`, e.message);
      await sb.from('phantom_reel_jobs').update({ status: 'failed', error: e.message }).eq('id', job.id);
    }
  } catch (e) {
    console.error('[poll] error', e.message);
  }
}

console.log('[boot] Phantom Reel Renderer v2 started. Polling every', POLL_INTERVAL_MS / 1000, 's');
setInterval(poll, POLL_INTERVAL_MS);
poll();
