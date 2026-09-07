require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const connectDB = require('./config/db');
const roomRoutes = require('./routes/roomRoutes');
const setupChatSocket = require('./socket/chatSocket');

const app = express();
const server = http.createServer(app);

// Connect to MongoDB
connectDB();

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
}));
app.use(express.json());

// API Routes
app.use('/api/rooms', roomRoutes);

// Health check
app.get("/", (req, res) => {
  res.send("Chat Server is running");
})
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Socket.io initialization
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
});

setupChatSocket(io);

const PORT = process.env.PORT || 5000;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use by another process. Please close it or set another PORT in .env`);
  } else {
    console.error('Server error:', err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`🚀 Chat Server running on port ${PORT}`);
});
