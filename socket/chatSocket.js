const Room = require('../models/Room');
const Message = require('../models/Message');

const setupChatSocket = (io) => {
  // Grace period timeouts for host disconnection (e.g. quick browser reload)
  const hostDisconnectTimeouts = new Map();

  io.on('connection', (socket) => {
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

        // If host joins / reconnects, cancel any pending host disconnect timeout
        if (isHost && hostDisconnectTimeouts.has(roomCode)) {
          clearTimeout(hostDisconnectTimeouts.get(roomCode));
          hostDisconnectTimeouts.delete(roomCode);
        }

        const existingParticipantIndex = room.participants.findIndex(
          (p) => p.participantId === participantId
        );

        let isNewParticipant = false;

        if (existingParticipantIndex !== -1) {
          // Update existing participant's socket ID and online status
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

        // If new participant and not host, broadcast system notification
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

        // Send updated active participants list to everyone in room
        const activeParticipants = room.participants.filter((p) => p.isOnline !== false);
        io.to(roomChannel).emit('update_participants', {
          participants: activeParticipants,
          hostId: room.hostId,
        });
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

        // Ensure socket is joined in the room channel
        socket.join(`room_${roomCode}`);

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
          const activeParticipants = room.participants.filter((p) => p.isOnline !== false);
          io.to(`room_${roomCode}`).emit('update_participants', {
            participants: activeParticipants,
            hostId: room.hostId,
          });

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

          // Remove participant completely from room
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
          const activeParticipants = room.participants.filter((p) => p.isOnline !== false);
          io.to(`room_${roomCode}`).emit('update_participants', {
            participants: activeParticipants,
            hostId: room.hostId,
          });
        }
      } catch (err) {
        console.error('Error on kick_participant:', err);
      }
    });

    // Host Moderation: End Room (Room Disappears)
    socket.on('end_room', async ({ roomCode, hostId }) => {
      try {
        const room = await Room.findOne({ code: roomCode });
        if (!room) return;

        if (room.hostId !== hostId) {
          socket.emit('error_notification', { message: 'Only the host can end the room.' });
          return;
        }

        // Cancel any pending disconnect timeouts
        if (hostDisconnectTimeouts.has(roomCode)) {
          clearTimeout(hostDisconnectTimeouts.get(roomCode));
          hostDisconnectTimeouts.delete(roomCode);
        }

        // Permanently delete room and messages so it disappears completely
        await Room.deleteOne({ code: roomCode });
        await Message.deleteMany({ roomCode });

        // Notify all participants that room has ended
        io.to(`room_${roomCode}`).emit('room_ended', {
          message: 'The host has ended and closed this room.',
        });

        // Automatically eject all participants from socket channel
        io.in(`room_${roomCode}`).socketsLeave(`room_${roomCode}`);
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

    // User leaves voluntarily (Host or Participant)
    socket.on('leave_room', async ({ roomCode, participantId, participantName }) => {
      try {
        socket.leave(`room_${roomCode}`);
        const room = await Room.findOne({ code: roomCode });
        if (!room) return;

        // 1. IF THE HOST LEAVES -> Room disappears for everyone!
        if (room.hostId === participantId) {
          if (hostDisconnectTimeouts.has(roomCode)) {
            clearTimeout(hostDisconnectTimeouts.get(roomCode));
            hostDisconnectTimeouts.delete(roomCode);
          }

          // Delete room and its chat messages completely
          await Room.deleteOne({ code: roomCode });
          await Message.deleteMany({ roomCode });

          // Inform all remaining participants in the room
          io.to(`room_${roomCode}`).emit('room_ended', {
            message: 'The host has left the room. The room has been closed.',
          });

          // Kick all sockets out of the channel
          io.in(`room_${roomCode}`).socketsLeave(`room_${roomCode}`);
          return;
        }

        // 2. IF A PARTICIPANT LEAVES -> Remove their ID completely from the participant list!
        room.participants = room.participants.filter(
          (p) => p.participantId !== participantId
        );
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

        const activeParticipants = room.participants.filter((p) => p.isOnline !== false);
        io.to(`room_${roomCode}`).emit('update_participants', {
          participants: activeParticipants,
          hostId: room.hostId,
        });
      } catch (err) {
        console.error('Error on leave_room:', err);
      }
    });

    // Socket disconnection (tab closed, internet dropped, etc.)
    socket.on('disconnect', async () => {
      const { roomCode, participantId } = socket;
      if (!roomCode || !participantId) return;

      try {
        const room = await Room.findOne({ code: roomCode });
        if (!room) return;

        // 1. IF HOST DISCONNECTED:
        // Set a brief grace period (4 seconds) to differentiate between a quick page refresh vs tab close.
        if (room.hostId === participantId) {
          // Mark host as offline temporarily
          const hostEntry = room.participants.find((p) => p.participantId === participantId);
          if (hostEntry) {
            hostEntry.isOnline = false;
            await room.save();
          }

          // Start timer: if host does not reconnect in 4 seconds, destroy room completely
          const timer = setTimeout(async () => {
            hostDisconnectTimeouts.delete(roomCode);
            try {
              const currentRoom = await Room.findOne({ code: roomCode });
              if (currentRoom) {
                const hostOnline = currentRoom.participants.find(
                  (p) => p.participantId === currentRoom.hostId && p.isOnline
                );

                if (!hostOnline) {
                  // Host did not reconnect -> delete room
                  await Room.deleteOne({ code: roomCode });
                  await Message.deleteMany({ roomCode });

                  io.to(`room_${roomCode}`).emit('room_ended', {
                    message: 'The host disconnected and the room was closed.',
                  });

                  io.in(`room_${roomCode}`).socketsLeave(`room_${roomCode}`);
                }
              }
            } catch (cleanupErr) {
              console.error('Error cleaning up abandoned room after host disconnect:', cleanupErr);
            }
          }, 3000);

          hostDisconnectTimeouts.set(roomCode, timer);
          return;
        }

        // 2. IF PARTICIPANT DISCONNECTED:
        // Completely remove participant from the room so their ID no longer shows in participant list
        const leavingParticipant = room.participants.find((p) => p.participantId === participantId);
        room.participants = room.participants.filter((p) => p.participantId !== participantId);
        await room.save();

        if (leavingParticipant) {
          const sysMsg = new Message({
            roomCode,
            senderId: 'system',
            senderName: 'System',
            isHost: false,
            text: `${leavingParticipant.name} left the room.`,
            isSystem: true,
          });
          await sysMsg.save();
          io.to(`room_${roomCode}`).emit('new_message', sysMsg);
        }

        const activeParticipants = room.participants.filter((p) => p.isOnline !== false);
        io.to(`room_${roomCode}`).emit('update_participants', {
          participants: activeParticipants,
          hostId: room.hostId,
        });
      } catch (err) {
        console.error('Error on socket disconnect cleanup:', err);
      }
    });
  });
};

module.exports = setupChatSocket;
