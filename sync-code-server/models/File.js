const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema(
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
    name: {
      type: String,
      required: true,
      trim: true,
    },
    itemType: {
      type: String,
      enum: ['file', 'folder'],
      default: 'file',
      index: true,
    },
    parentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'File',
      default: null,
      index: true,
    },
    sortOrder: {
      type: Number,
      default: 0,
      index: true,
    },
    language: {
      type: String,
      required: true,
      trim: true,
      default: 'javascript',
    },
    content: {
      type: String,
      required: false,
      default: '',
    },
  },
  { timestamps: true }
);

fileSchema.index({ userId: 1, projectId: 1, name: 1 }, { unique: false });
fileSchema.index({ userId: 1, projectId: 1, parentId: 1, sortOrder: 1 });

module.exports = mongoose.model('File', fileSchema);