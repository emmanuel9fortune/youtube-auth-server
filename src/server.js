import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { v2 as cloudinary } from 'cloudinary';
import { google } from 'googleapis';
import axios from 'axios';
import Media from './models/Media.js';
import Settings from './models/Settings.js';

const app = express();
const PORT = process.env.PORT || 4000;
const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';

app.use(cors({ origin: frontendUrl, credentials: false }));
app.use(express.json({ limit: '10gb' }));

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

function requirePassword(req, res, next) {
  const expected = process.env.APP_PASSWORD;
  if (!expected) return res.status(500).json({ error: 'APP_PASSWORD is not configured on the backend.' });
  const supplied = req.header('x-app-password') || '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'Incorrect dashboard password.' });
  }
  next();
}

function oauthClient() {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error('Google OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.');
  }
  return new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
}

async function getAuthorizedYoutube() {
  const setting = await Settings.findOne({ key: 'youtubeTokens' });
  if (!setting?.value?.refresh_token) throw new Error('YouTube is not connected. Click Connect YouTube first.');
  const auth = oauthClient();
  auth.setCredentials(setting.value);
  const youtube = google.youtube({ version: 'v3', auth });
  return { auth, youtube };
}

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'youtube-automation-studio' }));
app.post('/api/auth/check', requirePassword, (_req, res) => res.json({ ok: true }));

app.use('/api', (req, res, next) => {
  if (req.path === '/health' || req.path === '/auth/check' || req.path.startsWith('/youtube/callback')) return next();
  return requirePassword(req, res, next);
});

app.get('/api/config', (_req, res) => {
  res.json({ cloudinaryConfigured: Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) });
});

app.post('/api/cloudinary/signature', (req, res) => {
  try {
    if (!process.env.CLOUDINARY_API_SECRET || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_CLOUD_NAME) {
      return res.status(500).json({ error: 'Cloudinary is not configured.' });
    }
    const { resourceType = 'video', folder = 'youtube-automation-studio' } = req.body || {};
    if (!['image', 'video'].includes(resourceType)) return res.status(400).json({ error: 'resourceType must be image or video.' });
    const timestamp = Math.floor(Date.now() / 1000);
    const paramsToSign = { timestamp, folder };
    const signature = cloudinary.utils.api_sign_request(paramsToSign, process.env.CLOUDINARY_API_SECRET);
    res.json({ cloudName: process.env.CLOUDINARY_CLOUD_NAME, apiKey: process.env.CLOUDINARY_API_KEY, timestamp, folder, signature, resourceType });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Could not create upload signature.' });
  }
});

app.get('/api/media', async (_req, res) => {
  try {
    const items = await Media.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json(items);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/api/media', async (req, res) => {
  try {
    const { title, description = '', resourceType, cloudinaryPublicId, secureUrl, format = '', bytes = 0, duration = null } = req.body || {};
    if (!title?.trim() || !['image', 'video'].includes(resourceType) || !cloudinaryPublicId || !secureUrl) {
      return res.status(400).json({ error: 'title, resourceType, cloudinaryPublicId and secureUrl are required.' });
    }
    const item = await Media.create({ title: title.trim(), description, resourceType, cloudinaryPublicId, secureUrl, format, bytes: Number(bytes) || 0, duration: duration == null ? null : Number(duration) });
    res.status(201).json(item);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.patch('/api/media/:id', async (req, res) => {
  try {
    const allowed = {};
    if (typeof req.body.title === 'string' && req.body.title.trim()) allowed.title = req.body.title.trim().slice(0, 180);
    if (typeof req.body.description === 'string') allowed.description = req.body.description.slice(0, 5000);
    const item = await Media.findByIdAndUpdate(req.params.id, { $set: allowed }, { new: true, runValidators: true });
    if (!item) return res.status(404).json({ error: 'Media not found.' });
    res.json(item);
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.delete('/api/media/:id', async (req, res) => {
  try {
    const item = await Media.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Media not found.' });
    // Remove the cloud asset as well as the database record.
    await cloudinary.uploader.destroy(item.cloudinaryPublicId, { resource_type: item.resourceType === 'video' ? 'video' : 'image', invalidate: true });
    await item.deleteOne();
    res.json({ ok: true });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/youtube/status', async (_req, res) => {
  try {
    const setting = await Settings.findOne({ key: 'youtubeTokens' });
    if (!setting?.value?.refresh_token) return res.json({ connected: false });
    const { youtube } = await getAuthorizedYoutube();
    const response = await youtube.channels.list({ part: ['snippet'], mine: true });
    const channel = response.data.items?.[0];
    res.json({ connected: true, channelName: channel?.snippet?.title || 'Connected YouTube channel', channelId: channel?.id || '' });
  } catch (error) { res.json({ connected: false, error: error.message }); }
});

app.get('/api/youtube/connect', (req, res) => {
  try {
    const auth = oauthClient();
    const url = auth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'],
      state: 'personal-youtube-studio'
    });
    res.json({ url });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/youtube/callback', async (req, res) => {
  try {
    if (req.query.error) return res.redirect(`${frontendUrl}?youtube=denied`);
    if (!req.query.code) return res.redirect(`${frontendUrl}?youtube=missing_code`);
    const auth = oauthClient();
    const { tokens } = await auth.getToken(String(req.query.code));
    const existing = await Settings.findOne({ key: 'youtubeTokens' });
    // Google may omit refresh_token on subsequent authorizations; preserve the old one if so.
    const saved = { ...(existing?.value || {}), ...tokens };
    if (!saved.refresh_token) throw new Error('Google did not return a refresh token. Disconnect/revoke the app in Google Account permissions and reconnect with consent.');
    await Settings.findOneAndUpdate({ key: 'youtubeTokens' }, { $set: { value: saved } }, { upsert: true, new: true });
    res.redirect(`${frontendUrl}?youtube=connected`);
  } catch (error) {
    res.redirect(`${frontendUrl}?youtube=error&message=${encodeURIComponent(error.message).slice(0, 300)}`);
  }
});

app.post('/api/media/:id/schedule', async (req, res) => {
  try {
    const item = await Media.findById(req.params.id);
    if (!item) return res.status(404).json({ error: 'Media not found.' });
    if (item.resourceType !== 'video') return res.status(400).json({ error: 'Only video files can be scheduled on YouTube.' });
    if (item.youtubeVideoId) return res.status(400).json({ error: 'This media item has already been uploaded to YouTube.' });
    const publishAt = new Date(req.body.publishAt);
    if (!req.body.publishAt || Number.isNaN(publishAt.getTime())) return res.status(400).json({ error: 'Choose a valid publishing date and time.' });
    if (publishAt.getTime() < Date.now() + 15 * 60 * 1000) return res.status(400).json({ error: 'Choose a publishing time at least 15 minutes in the future.' });

    const { youtube } = await getAuthorizedYoutube();
    // Cloudinary returns a public HTTPS asset URL. Stream it to YouTube without buffering the whole file in RAM.
    const upstream = await axios.get(item.secureUrl, { responseType: 'stream', timeout: 120000, maxRedirects: 5 });
    const upload = await youtube.videos.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title: item.title, description: item.description || '', categoryId: '22' },
        status: { privacyStatus: 'private', publishAt: publishAt.toISOString(), selfDeclaredMadeForKids: false }
      },
      media: { body: upstream.data }
    });
    const videoId = upload.data.id;
    if (!videoId) throw new Error('YouTube did not return a video ID. The source file was kept so you can retry safely.');

    const youtubeUrl = `https://www.youtube.com/watch?v=${videoId}`;
    // Save the YouTube ID first. If cloud cleanup fails, the item remains in the library
    // but cannot accidentally be uploaded a second time.
    item.status = 'scheduled';
    item.scheduledAt = publishAt;
    item.youtubeVideoId = videoId;
    item.youtubeUrl = youtubeUrl;
    item.lastError = '';
    await item.save();

    // After YouTube confirms the upload, remove the source video from Cloudinary and
    // then remove its MongoDB record. If Cloudinary cleanup fails, retain the record
    // so the user can see the YouTube URL and retry cleanup instead of losing track.
    try {
      const deletion = await cloudinary.uploader.destroy(item.cloudinaryPublicId, {
        resource_type: item.resourceType === 'video' ? 'video' : 'image',
        invalidate: true
      });
      if (!['ok', 'not found'].includes(deletion?.result)) {
        throw new Error(`Cloudinary returned '${deletion?.result || 'unknown result'}'.`);
      }
      await item.deleteOne();
      return res.json({
        ok: true,
        cleanupComplete: true,
        youtubeUrl,
        message: 'Video uploaded and scheduled on YouTube. The source file was deleted from Cloudinary and its record was deleted from MongoDB.'
      });
    } catch (cleanupError) {
      const cleanupMessage = `YouTube upload succeeded, but source cleanup failed: ${cleanupError.message}`;
      item.lastError = cleanupMessage;
      await item.save().catch(() => {});
      return res.json({
        ok: true,
        cleanupComplete: false,
        youtubeUrl,
        item,
        message: `${cleanupMessage} The source remains in the library so you can retry cleanup. Do not upload it again.`
      });
    }
  } catch (error) {
    const message = error.response?.data?.error?.message || error.message || 'YouTube upload failed.';
    await Media.findByIdAndUpdate(req.params.id, { $set: { lastError: message, status: 'failed' } }).catch(() => {});
    res.status(500).json({ error: message });
  }
});

app.get('/api/youtube/videos', async (_req, res) => {
  try {
    const { youtube } = await getAuthorizedYoutube();
    const response = await youtube.search.list({ part: ['snippet'], forMine: true, type: ['video'], maxResults: 20, order: 'date' });
    res.json((response.data.items || []).map(v => ({ id: v.id?.videoId, title: v.snippet?.title, publishedAt: v.snippet?.publishedAt, url: `https://www.youtube.com/watch?v=${v.id?.videoId}` })));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Unexpected server error.' });
});

async function start() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is missing. Copy .env.example to .env and configure it.');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log('Connected to MongoDB');
  app.listen(PORT, () => console.log(`API listening on port ${PORT}`));
}

start().catch(error => { console.error('Startup failed:', error.message); process.exit(1); });
