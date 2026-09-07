const mongoose = require('mongoose');

const participantSchema = new mongoose.Schema({
  participantId: {
    type: String,
    required: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  socketId: {
    type: String,
    default: '',
  },
  isHost: {
    type: Boolean,
    default: false,
  },
  isMuted: {
    type: Boolean,
    default: false,
  },
  isOnline: {
    type: Boolean,
    default: true,
  },
  joinedAt: {
    type: Date,
    default: Date.now,
  },
});

const roomSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  code: {
    type: String,
    required: true,
    unique: true,
    length: 6,
    index: true,
  },
  hostId: {
    type: String,
    required: true,
  },
  hostName: {
    type: String,
    required: true,
    trim: true,
  },
  isActive: {
    type: Boolean,
    default: true,
  },
  participants: [participantSchema],
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Static helper to generate a unique 6-digit code
roomSchema.statics.generateUniqueCode = async function () {
  let unique = false;
  let code = '';
  while (!unique) {
    // Generate 6-digit random number string (100000 - 999999)
    code = Math.floor(100000 + Math.random() * 900000).toString();
    const existing = await this.findOne({ code });
    if (!existing) {
      unique = true;
    }
  }
  return code;
};

module.exports = mongoose.model('Room', roomSchema);
