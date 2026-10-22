import mongoose from 'mongoose';

// One headline about one Nifty 50 stock (or the whole market when `symbol` is 'MARKET').
// Tags are computed once when the headline is first seen, so they never change under the user.
const newsItemSchema = new mongoose.Schema(
  {
    symbol: { type: String, required: true },
    hash: { type: String, required: true },
    title: { type: String, required: true },
    url: { type: String, required: true },
    source: String,
    publishedAt: { type: Date, required: true },
    sentiment: { type: Number, required: true }, // -3 .. +3
    label: { type: String, enum: ['BULLISH', 'BEARISH', 'NEUTRAL'], required: true },
    category: { type: String, required: true },
    reasons: [String],
  },
  { timestamps: true },
);

newsItemSchema.index({ symbol: 1, hash: 1 }, { unique: true });
newsItemSchema.index({ symbol: 1, publishedAt: -1 });

export const NewsItem = mongoose.model('NewsItem', newsItemSchema);
