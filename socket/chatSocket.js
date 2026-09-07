const Room = require('../models/Room');
const Message = require('../models/Message');

const setupChatSocket = (io) => {
  io.on('connection', (socket) => {
    // console.log(`[Socket Connected] ID: ${socket.id}`);

    // Join a room
    socket.on('join_room', async ({ roomCode, participantId, participantName }) => {
      try {
        if (!roomCode || !participantId || !participantName) return;

        const room = await Room.findOne({ code: roomCode });
        if (!room) {
          socket.emit('error_notification', { message: 'Room not found.' });
          return;
        }

        if (!room.isActive) {
          socket.emit('error_notification', { message: 'This room has already ended.' });
          return;
        }

        const roomChannel = `room_${roomCode}`;
        socket.join(roomChannel);
        socket.roomCode = roomCode;
        socket.participantId = participantId;

        const isHost = room.hostId === participantId;
        const existingParticipantIndex = room.participants.findIndex(
          (p) => p.participantId === participantId
        );

        let isNewParticipant = false;

        if (existingParticipantIndex !== -1) {
          // Update existing participant's socket ID and status
          room.participants[existingParticipantIndex].socketId = socket.id;
          room.participants[existingParticipantIndex].isOnline = true;
          room.participants[existingParticipantIndex].name = participantName;
          room.participants[existingParticipantIndex].isHost = isHost;
        } else {
          // Add new participant
          isNewParticipant = true;
          room.participants.push({
            participantId,
            name: participantName,
            socketId: socket.id,
            isHost,
            isMuted: false,
            isOnline: true,
          });
        }

        await room.save();

        // If new participant, broadcast system notification
        if (isNewParticipant && !isHost) {
          const joinMsg = new Message({
            roomCode,
            senderId: 'system',
            senderName: 'System',
            isHost: false,
            text: `${participantName} joined the room 👋`,
            isSystem: true,
          });
          await joinMsg.save();
          io.to(roomChannel).emit('new_message', joinMsg);
        }

        // Send updated participants list to everyone in room
        io.to(roomChannel).emit('update_participants', {
          participants: room.participants,
          hostId: room.hostId,
        });

        // console.log(`[User Joined] ${participantName} (${participantId}) in room ${roomCode}`);
      } catch (err) {
        console.error('Error on join_room:', err);
      }
    });

    // Send a message
    socket.on('send_message', async ({ roomCode, senderId, senderName, text }) => {
      try {
        if (!roomCode || !senderId || !text || !text.trim()) return;

        const room = await Room.findOne({ code: roomCode });
        if (!room || !room.isActive) {
          socket.emit('error_notification', { message: 'Room is inactive or not found.' });
          return;
        }

        const participant = room.participants.find((p) => p.participantId === senderId);
        if (participant && participant.isMuted) {
          socket.emit('error_notification', {
            message: 'You have been muted by the host and cannot send messages.',
          });
          return;
        }

        const isHost = room.hostId === senderId;

        const newMsg = new Message({
          roomCode,
          senderId,
          senderName: senderName || (participant ? participant.name : 'Anonymous'),
          isHost,
          text: text.trim(),
          isSystem: false,
        });

        await newMsg.save();

        // Broadcast to all sockets in the room
        io.to(`room_${roomCode}`).emit('new_message', newMsg);
      } catch (err) {
        console.error('Error on send_message:', err);
      }
    });

    // Typing indicators
    socket.on('typing', ({ roomCode, senderName }) => {
      socket.to(`room_${roomCode}`).emit('user_typing', { senderName });
    });

    socket.on('stop_typing', ({ roomCode, senderName }) => {
      socket.to(`room_${roomCode}`).emit('user_stop_typing', { senderName });
    });

    // Host Moderation: Mute / Unmute participant
    socket.on('mute_participant', async ({ roomCode, hostId, targetParticipantId, isMuted }) => {
      try {
        const room = await Room.findOne({ code: roomCode });
        if (!room) return;

        // Verify host permission
        if (room.hostId !== hostId) {
          socket.emit('error_notification', { message: 'Only the host can mute participants.' });
          return;
        }

        // Cannot mute host
        if (targetParticipantId === room.hostId) {
          socket.emit('error_notification', { message: 'The host cannot be muted.' });
          return;
        }

        const target = room.participants.find((p) => p.participantId === targetParticipantId);
        if (target) {
          target.isMuted = isMuted;
          await room.save();

          // System message announcement
          const actionText = isMuted ? 'muted' : 'unmuted';
          const sysMsg = new Message({
            roomCode,
            senderId: 'system',
            senderName: 'System',
            isHost: false,
            text: `🔇 ${target.name} was ${actionText} by the host.`,
            isSystem: true,
          });
          await sysMsg.save();

          io.to(`room_${roomCode}`).emit('new_message', sysMsg);
          io.to(`room_${roomCode}`).emit('update_participants', {
            participants: room.participants,
            hostId: room.hostId,
          });

          // Also alert the target directly
          io.to(`room_${roomCode}`).emit('participant_mute_status', {
            targetParticipantId,
            isMuted,
            message: isMuted
              ? 'You have been muted by the host.'
              : 'You have been unmuted by the host.',
          });
        }
      } catch (err) {
        console.error('Error on mute_participant:', err);
      }
    });

    // Host Moderation: Kick participant
    socket.on('kick_participant', async ({ roomCode, hostId, targetParticipantId }) => {
      try {
        const room = await Room.findOne({ code: roomCode });
        if (!room) return;

        // Verify host permission
        if (room.hostId !== hostId) {
          socket.emit('error_notification', { message: 'Only the host can kick participants.' });
          return;
        }

        // Cannot kick host
        if (targetParticipantId === room.hostId) {
          socket.emit('error_notification', { message: 'Host cannot be kicked.' });
          return;
        }

        const target = room.participants.find((p) => p.participantId === targetParticipantId);
        if (target) {
          const targetName = target.name;
          const targetSocketId = target.socketId;

          // Remove participant from room
          room.participants = room.participants.filter(
            (p) => p.participantId !== targetParticipantId
          );
          await room.save();

          // Emit kicked event to the room / target
          io.to(`room_${roomCode}`).emit('participant_kicked', {
            targetParticipantId,
            targetName,
          });

          if (targetSocketId && io.sockets.sockets.get(targetSocketId)) {
            io.sockets.sockets.get(targetSocketId).leave(`room_${roomCode}`);
          }

          // System message announcement
          const sysMsg = new Message({
            roomCode,
            senderId: 'system',
            senderName: 'System',
            isHost: false,
            text: `🚫 ${targetName} was removed from the room by the host.`,
            isSystem: true,
          });
          await sysMsg.save();

          io.to(`room_${roomCode}`).emit('new_message', sysMsg);
          io.to(`room_${roomCode}`).emit('update_participants', {
            participants: room.participants,
            hostId: room.hostId,
          });
        }
      } catch (err) {
        console.error('Error on kick_participant:', err);
      }
    });

    // Host Moderation: End Room
    socket.on('end_room', async ({ roomCode, hostId }) => {
      try {
        const room = await Room.findOne({ code: roomCode });
        if (!room) return;

        if (room.hostId !== hostId) {
          socket.emit('error_notification', { message: 'Only the host can end the room.' });
          return;
        }

        room.isActive = false;
        await room.save();

        const sysMsg = new Message({
          roomCode,
          senderId: 'system',
          senderName: 'System',
          isHost: false,
          text: `🚪 The host ended the room. All participants have been disconnected.`,
          isSystem: true,
        });
        await sysMsg.save();

        io.to(`room_${roomCode}`).emit('new_message', sysMsg);
        io.to(`room_${roomCode}`).emit('room_ended', {
          message: 'The host has closed this room.',
        });
      } catch (err) {
        console.error('Error on end_room:', err);
      }
    });

    // Host Moderation: Clear Chat
    socket.on('clear_chat', async ({ roomCode, hostId }) => {
      try {
        const room = await Room.findOne({ code: roomCode });
        if (!room || room.hostId !== hostId) return;

        await Message.deleteMany({ roomCode });

        const sysMsg = new Message({
          roomCode,
          senderId: 'system',
          senderName: 'System',
          isHost: false,
          text: `🧹 Chat history was cleared by the host.`,
          isSystem: true,
        });
        await sysMsg.save();

        io.to(`room_${roomCode}`).emit('chat_cleared', { systemMessage: sysMsg });
      } catch (err) {
        console.error('Error on clear_chat:', err);
      }
    });

    // Participant leaves voluntarily
    socket.on('leave_room', async ({ roomCode, participantId, participantName }) => {
      try {
        socket.leave(`room_${roomCode}`);
        const room = await Room.findOne({ code: roomCode });
        if (room) {
          const p = room.participants.find((p) => p.participantId === participantId);
          if (p) {
            p.isOnline = false;
            await room.save();

            const sysMsg = new Message({
              roomCode,
              senderId: 'system',
              senderName: 'System',
              isHost: false,
              text: `${participantName || 'A participant'} left the room.`,
              isSystem: true,
            });
            await sysMsg.save();

            io.to(`room_${roomCode}`).emit('new_message', sysMsg);
            io.to(`room_${roomCode}`).emit('update_participants', {
              participants: room.participants,
              hostId: room.hostId,
            });
          }
        }
      } catch (err) {
        console.error('Error on leave_room:', err);
      }
    });

    // Socket disconnection
    socket.on('disconnect', async () => {
      console.log(`[Socket Disconnected] ID: ${socket.id}`);
      if (socket.roomCode && socket.participantId) {
        try {
          const room = await Room.findOne({ code: socket.roomCode });
          if (room) {
            const p = room.participants.find((item) => item.participantId === socket.participantId);
            if (p) {
              p.isOnline = false;
              await room.save();
              io.to(`room_${socket.roomCode}`).emit('update_participants', {
                participants: room.participants,
                hostId: room.hostId,
              });
            }
          }
        } catch (err) {
          console.error('Error on socket disconnect cleanup:', err);
        }
      }
    });
  });
};

module.exports = setupChatSocket;
