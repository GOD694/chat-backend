const express = require('express');
const router = express.Router();
const Room = require('../models/Room');
const Message = require('../models/Message');

// @route   POST /api/rooms/create
// @desc    Create a new chat room and assign creator as Host
router.post('/create', async (req, res) => {
  try {
    const { roomName, hostName, participantId } = req.body;

    if (!roomName || !hostName || !participantId) {
      return res.status(400).json({
        success: false,
        message: 'Room name, host name, and participant ID are required.',
      });
    }

    const code = await Room.generateUniqueCode();

    const newRoom = new Room({
      name: roomName.trim(),
      code,
      hostId: participantId,
      hostName: hostName.trim(),
      participants: [
        {
          participantId,
          name: hostName.trim(),
          isHost: true,
          isMuted: false,
          isOnline: true,
        },
      ],
    });

    await newRoom.save();

    // Create a welcoming system message
    const welcomeMsg = new Message({
      roomCode: code,
      senderId: 'system',
      senderName: 'System',
      isHost: false,
      text: `Room "${roomName}" created by Host ${hostName}. Share code ${code} to invite others!`,
      isSystem: true,
    });
    await welcomeMsg.save();

    return res.status(201).json({
      success: true,
      room: {
        code: newRoom.code,
        name: newRoom.name,
        hostId: newRoom.hostId,
        hostName: newRoom.hostName,
        isHost: true,
        participants: newRoom.participants,
      },
    });
  } catch (error) {
    console.error('Error creating room:', error);
    return res.status(500).json({ success: false, message: 'Server error creating room.' });
  }
});

// @route   POST /api/rooms/verify
// @desc    Verify 6-digit room referral code and check if room exists/active
router.post('/verify', async (req, res) => {
  try {
    const { roomCode, participantName, participantId } = req.body;

    if (!roomCode) {
      return res.status(400).json({ success: false, message: 'Room code is required.' });
    }

    const room = await Room.findOne({ code: roomCode.trim() });
    if (!room) {
      return res.status(404).json({ success: false, message: 'Room not found. Please check your 6-digit code.' });
    }

    if (!room.isActive) {
      return res.status(403).json({ success: false, message: 'This room has been closed by the host.' });
    }

    const isHost = room.hostId === participantId;

    return res.json({
      success: true,
      room: {
        code: room.code,
        name: room.name,
        hostId: room.hostId,
        hostName: room.hostName,
        isHost,
        participants: room.participants,
      },
    });
  } catch (error) {
    console.error('Error verifying room:', error);
    return res.status(500).json({ success: false, message: 'Server error verifying room.' });
  }
});

// @route   GET /api/rooms/:code
// @desc    Get room info and message history
router.get('/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const room = await Room.findOne({ code });

    if (!room || !room.isActive) {
      return res.status(404).json({ success: false, message: 'Room not found or has been closed by the host.' });
    }

    const messages = await Message.find({ roomCode: code }).sort({ createdAt: 1 });

    return res.json({
      success: true,
      room: {
        code: room.code,
        name: room.name,
        hostId: room.hostId,
        hostName: room.hostName,
        isActive: room.isActive,
        participants: room.participants.filter((p) => p.isOnline !== false),
      },
      messages,
    });
  } catch (error) {
    console.error('Error fetching room info:', error);
    return res.status(500).json({ success: false, message: 'Server error fetching room details.' });
  }
});

module.exports = router;
