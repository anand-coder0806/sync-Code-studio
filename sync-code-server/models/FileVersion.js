const mongoose = require('mongoose');

const fileVersionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },
    fileId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'File',
      required: true,
      index: true,
    },
    versionNumber: {
      type: Number,
      required: true,
      min: 1,
    },
    content: {
      type: String,
      required: false,
      default: '',
    },
    language: {
      type: String,
      required: true,
      default: 'javascript',
    },
    contentHash: {
      type: String,
      required: true,
      index: true,
    },
    source: {
      type: String,
      enum: ['manual', 'autosave', 'restore'],
      default: 'manual',
      index: true,
    },
  },
  { timestamps: true }
);

fileVersionSchema.index({ userId: 1, fileId: 1, versionNumber: -1 }, { unique: true });
fileVersionSchema.index({ userId: 1, projectId: 1, fileId: 1, createdAt: -1 });

module.exports = mongoose.model('FileVersion', fileVersionSchema);
