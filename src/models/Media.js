import mongoose from 'mongoose';

const mediaSchema = new mongoose.Schema({
  title: { type: String, required: true, trim: true, maxlength: 180 },
  description: { type: String, default: '', maxlength: 5000 },
  resourceType: { type: String, enum: ['image', 'video'], required: true },
  cloudinaryPublicId: { type: String, required: true },
  secureUrl: { type: String, required: true },
  format: { type: String, default: '' },
  bytes: { type: Number, default: 0 },
  duration: { type: Number, default: null },
  status: { type: String, enum: ['stored', 'scheduled', 'uploaded', 'published', 'failed'], default: 'stored' },
  scheduledAt: { type: Date, default: null },
  youtubeVideoId: { type: String, default: '' },
  youtubeUrl: { type: String, default: '' },
  lastError: { type: String, default: '' }
}, { timestamps: true });

export default mongoose.model('Media', mediaSchema);
