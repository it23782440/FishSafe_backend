const mongoose = require('mongoose');

/*
 * One document = one alert event (a sensor entered WARNING or DANGER).
 * Alerts are generated server-side with de-duplication so the same ongoing
 * condition is not logged on every single reading (see alertService.js).
 */
const alertSchema = new mongoose.Schema(
  {
    deviceId:  { type: String, required: true, index: true, trim: true },
    sensor:    { type: String, required: true }, // e.g. "ph"
    severity:  { type: String, enum: ['INFO', 'WARNING', 'DANGER'], required: true, index: true },
    // threshold | sensor_missing | device_offline | device_online | species_changed
    kind:      { type: String, default: 'threshold', index: true },
    title:     { type: String, default: '' },

    value:     { type: Number, default: null },   // reading that triggered it
    previousValue: { type: Number, default: null },// prior reading (context)
    threshold: { type: String, default: '' },      // human-readable safe range

    species:   { type: String, default: null },   // species thresholds in force
    speciesName: { type: String, default: '' },
    direction: { type: String, default: null },    // 'high' | 'low' for threshold alerts
    reason:    { type: String, default: '' },      // exact explanation shown to the user
    recommendation: { type: String, default: '' }, // suggested corrective action
    message:   { type: String, default: '' },
    read:      { type: Boolean, default: false, index: true }, // acknowledged by a user
    readAt:    { type: Date, default: null },
    active:    { type: Boolean, default: true, index: true }, // cleared when SAFE again
    resolvedAt:{ type: Date, default: null },

    createdAt: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false }
);

alertSchema.index({ deviceId: 1, createdAt: -1 });

module.exports = mongoose.model('Alert', alertSchema);
