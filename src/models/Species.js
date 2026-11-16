const mongoose = require('mongoose');

// null = unbounded on that side (e.g. turbidity has no lower limit).
const num = { type: Number, default: null };
const range = new mongoose.Schema(
  {
    warnLow: num, // below this -> DANGER
    safeLow: num, // below this -> WARNING
    safeHigh: num, // above this -> WARNING
    warnHigh: num, // above this -> DANGER
    warnMargin: { type: Number, default: 0, min: 0 }, // "approaching a limit" band inside the safe range
    source: { type: String, default: 'custom' },
  },
  { _id: false }
);

const speciesSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    scientific: { type: String, default: '', trim: true, maxlength: 80 },
    description: { type: String, default: '', trim: true, maxlength: 400 },
    imageUrl: { type: String, default: '', trim: true, maxlength: 500 },
    thresholds: {
      temperature: range,
      ph: range,
      turbidity: range,
      rain: range,
      conductivity: range,
    },
    builtIn: { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Species', speciesSchema);
