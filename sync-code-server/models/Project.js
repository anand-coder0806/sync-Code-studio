const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
      default: 'Untitled Project',
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    shareId: {
      type: String,
      trim: true,
      index: true,
      default: '',
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Project', projectSchema);