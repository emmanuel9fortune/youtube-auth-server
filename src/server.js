
import 'dotenv/config';
import mongoose from 'mongoose';
import app from './app.js';

const PORT = process.env.PORT || 4000;

async function start() {
  if (!process.env.MONGODB_URI) {
    throw new Error('MONGODB_URI is missing.');
  }

  await mongoose.connect(process.env.MONGODB_URI);

  console.log('Connected to MongoDB');

  app.listen(PORT, () => {
    console.log(`API listening on port ${PORT}`);
  });
}

start().catch(error => {
  console.error('Startup failed:', error.message);
  process.exit(1);
});
      item.lastError =
        `YouTube upload succeeded, but Cloudinary cleanup failed: ${cleanupError.message}`;

      await item.save();

      return res.json({
        ok: true,
        cleanupComplete: false,
        message: item.lastError,
        youtubeUrl,
        item
      });
    }

  } catch (error) {
    const message =
      error.response?.data?.error?.message ||
      error.message ||
      'YouTube upload failed.';

    await Media.findByIdAndUpdate(req.params.id, {
      $set: { lastError: message }
    }).catch(() => {});

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


