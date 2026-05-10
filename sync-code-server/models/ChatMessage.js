const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema(
  {
    roomId: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false,
      index: true,
    },
    sender: {
      type: String,
      required: true,
      trim: true,
      default: 'Anonymous',
    },
    isAssistant: {
      type: Boolean,
      default: false,
      index: true,
    },
    message: {
      type: String,
      required: true,
      trim: true,
      maxlength: 10000,
    },
    messageType: {
      type: String,
      enum: ['text', 'code'],
      default: 'text',
      index: true,
    },
    codeSnippet: {
      language: {
        type: String,
        trim: true,
        default: '',
        maxlength: 32,
      },
      code: {
        type: String,
        default: '',
        maxlength: 10000,
      },
    },
    status: {
      type: String,
      enum: ['sent', 'delivered', 'seen'],
      default: 'sent',
      index: true,
    },
    deliveredBy: {
      type: [String],
      default: [],
    },
    seenBy: {
      type: [String],
      default: [],
    },
    deliveredAt: {
      type: Date,
      default: null,
    },
    seenAt: {
      type: Date,
      default: null,
    },
    attachment: {
      name: { type: String, default: '' },
      mimeType: { type: String, default: '' },
      size: { type: Number, default: 0 },
      url: { type: String, default: '' },
      isImage: { type: Boolean, default: false },
    },
    reactions: {
      type: [
        {
          emoji: { type: String, required: true },
          userIds: { type: [String], default: [] },
        },
      ],
      default: [],
    },
    editedAt: {
      type: Date,
      default: null,
    },
    isDeleted: {
      type: Boolean,
      default: false,
      index: true,
    },
    socketId: {
      type: String,
      required: false,
      trim: true,
      default: '',
    },
  },
  { timestamps: true }
);

chatMessageSchema.index({ roomId: 1, createdAt: 1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);