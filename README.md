# Phantom Reel Renderer

Railway-hosted FFmpeg worker that polls Supabase phantom_reel_jobs WHERE status='manifest_ready', renders 9:16 fair-use split-screen videos with Polly narration + Sovereign Subtitles, uploads to phantom-reels storage bucket, flips job to completed.

Deploy: connect Railway to this repo, set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY env vars, deploy. Nixpacks bakes Node 20 + FFmpeg automatically.
