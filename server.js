// server.js - Real-time Chunk File Transfer Backend
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fs = require('fs').promises;
const path = require('path');
const config = require('./config');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: config.CORS_ORIGIN,
        methods: ["GET", "POST"],
        credentials: true
    },
    maxHttpBufferSize: config.MAX_BUFFER_SIZE,
    pingTimeout: 60000,
    pingInterval: 25000
});

// Middleware
app.use(cors({
    origin: config.CORS_ORIGIN,
    credentials: true
}));
app.use(express.json());
app.use(express.static('public'));

const path = require('path');

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public')));

// Fallback: serve index.html for any route (SPA support)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// In-memory storage for active transfers
const transferSessions = new Map();
const activeConnections = new Map();

// Ensure required directories exist
async function ensureDirectories() {
    const dirs = [config.TEMP_DIR, config.UPLOAD_DIR, config.LOG_DIR];
    
    for (const dir of dirs) {
        try {
            await fs.mkdir(dir, { recursive: true });
            console.log(`✅ Directory ready: ${dir}`);
        } catch (error) {
            console.error(`❌ Error creating directory ${dir}:`, error);
        }
    }
}

// Initialize directories on startup
ensureDirectories();

// Socket.io connection handling
io.on('connection', (socket) => {
    console.log(`🔌 Client connected: ${socket.id}`);
    activeConnections.set(socket.id, { connectedAt: new Date(), role: null });

    // Create transfer session (Sender)
    socket.on('create-transfer', ({ transferId }) => {
        console.log(`📤 Transfer created: ${transferId} by ${socket.id}`);
        
        socket.join(transferId);
        
        const session = {
            transferId,
            sender: socket.id,
            receiver: null,
            chunks: [],
            fileInfo: null,
            startTime: Date.now(),
            status: 'waiting'
        };
        
        transferSessions.set(transferId, session);
        activeConnections.get(socket.id).role = 'sender';
        activeConnections.get(socket.id).transferId = transferId;

        socket.emit('transfer-created', { 
            transferId,
            message: 'Transfer session created successfully'
        });

        logActivity('CREATE', transferId, socket.id);
    });

    // Join transfer session (Receiver)
    socket.on('join-transfer', ({ transferId }) => {
        console.log(`📥 Receiver joining transfer: ${transferId}`);
        
        const session = transferSessions.get(transferId);
        
        if (!session) {
            socket.emit('error', { 
                message: 'Transfer session not found',
                code: 'SESSION_NOT_FOUND'
            });
            return;
        }

        if (session.receiver) {
            socket.emit('error', { 
                message: 'Transfer already has a receiver',
                code: 'RECEIVER_EXISTS'
            });
            return;
        }
        
        socket.join(transferId);
        session.receiver = socket.id;
        session.status = 'connected';
        
        activeConnections.get(socket.id).role = 'receiver';
        activeConnections.get(socket.id).transferId = transferId;
        
        // Notify sender that receiver connected
        io.to(session.sender).emit('receiver-connected', {
            transferId,
            receiverId: socket.id,
            message: 'Receiver connected successfully'
        });

        socket.emit('joined-transfer', { 
            transferId,
            message: 'Connected to transfer session'
        });

        logActivity('JOIN', transferId, socket.id);
    });

    // Upload chunk (Sender)
    socket.on('upload-chunk', async (data) => {
        const { transferId, chunk, chunkIndex, totalChunks, fileName, fileSize, fileType } = data;
        
        console.log(`⬆️ Chunk ${chunkIndex + 1}/${totalChunks} for ${fileName}`);
        
        const session = transferSessions.get(transferId);
        
        if (!session) {
            socket.emit('error', { 
                message: 'Transfer session not found',
                code: 'SESSION_NOT_FOUND'
            });
            return;
        }

        if (session.sender !== socket.id) {
            socket.emit('error', { 
                message: 'Unauthorized sender',
                code: 'UNAUTHORIZED'
            });
            return;
        }

        // Store file info on first chunk
        if (chunkIndex === 0) {
            session.fileInfo = { 
                fileName, 
                fileSize, 
                fileType, 
                totalChunks,
                uploadStartTime: Date.now()
            };
            session.status = 'uploading';
            
            console.log(`📁 File info stored: ${fileName} (${formatBytes(fileSize)})`);
        }

        // Save chunk to temporary storage
        const chunkPath = path.join(config.TEMP_DIR, `${transferId}_chunk_${chunkIndex}`);
        
        try {
            // Convert chunk to buffer and save
            const buffer = Buffer.from(chunk);
            await fs.writeFile(chunkPath, buffer);
            
            // Store chunk metadata
            session.chunks.push({
                index: chunkIndex,
                path: chunkPath,
                size: buffer.length,
                timestamp: Date.now()
            });

            // Broadcast chunk to receiver immediately
            if (session.receiver) {
                io.to(session.receiver).emit('receive-chunk', {
                    chunk: chunk,
                    chunkIndex: chunkIndex,
                    totalChunks: totalChunks,
                    fileName: fileName,
                    fileSize: fileSize,
                    fileType: fileType
                });
            }

            // Acknowledge chunk received
            socket.emit('chunk-uploaded', { 
                chunkIndex,
                message: `Chunk ${chunkIndex + 1}/${totalChunks} uploaded successfully`
            });
            
        } catch (error) {
            console.error(`❌ Error saving chunk ${chunkIndex}:`, error);
            socket.emit('error', { 
                message: 'Failed to save chunk',
                code: 'CHUNK_SAVE_ERROR',
                chunkIndex
            });
        }
    });

    // Upload complete (Sender)
    socket.on('upload-complete', async ({ transferId }) => {
        console.log(`✅ Upload complete for: ${transferId}`);
        
        const session = transferSessions.get(transferId);
        
        if (!session) {
            socket.emit('error', { 
                message: 'Transfer session not found',
                code: 'SESSION_NOT_FOUND'
            });
            return;
        }

        session.status = 'completed';
        session.completedAt = Date.now();
        
        // Notify receiver that transfer is complete
        if (session.receiver) {
            io.to(session.receiver).emit('transfer-complete', {
                transferId,
                fileInfo: session.fileInfo,
                message: 'File transfer completed successfully'
            });
        }

        logActivity('COMPLETE', transferId, socket.id);

        // Schedule cleanup after configured interval
        setTimeout(() => {
            cleanupTransfer(transferId);
        }, config.CLEANUP_INTERVAL);
    });

    // Get transfer status
    socket.on('get-status', ({ transferId }) => {
        const session = transferSessions.get(transferId);
        
        if (!session) {
            socket.emit('status-response', { 
                found: false,
                message: 'Transfer not found'
            });
            return;
        }

        socket.emit('status-response', {
            found: true,
            status: session.status,
            fileInfo: session.fileInfo,
            chunksReceived: session.chunks.length,
            totalChunks: session.fileInfo?.totalChunks || 0
        });
    });

    // Disconnect handling
    socket.on('disconnect', () => {
        console.log(`🔌 Client disconnected: ${socket.id}`);
        
        const connection = activeConnections.get(socket.id);
        
        if (connection && connection.transferId) {
            const session = transferSessions.get(connection.transferId);
            
            if (session) {
                const otherParty = session.sender === socket.id ? session.receiver : session.sender;
                
                if (otherParty) {
                    io.to(otherParty).emit('peer-disconnected', { 
                        transferId: connection.transferId,
                        role: connection.role,
                        message: `${connection.role} disconnected`
                    });
                }

                logActivity('DISCONNECT', connection.transferId, socket.id);
            }
        }
        
        activeConnections.delete(socket.id);
    });

    socket.on('error', (error) => {
        console.error(`❌ Socket error for ${socket.id}:`, error);
    });
});

// Cleanup transfer data
async function cleanupTransfer(transferId) {
    console.log(`🧹 Cleaning up transfer: ${transferId}`);
    
    const session = transferSessions.get(transferId);
    
    if (!session) return;
    
    try {
        for (const chunk of session.chunks) {
            try {
                await fs.unlink(chunk.path);
            } catch (error) {
                console.error(`❌ Error deleting chunk ${chunk.path}:`, error);
            }
        }
        
        transferSessions.delete(transferId);
        console.log(`✅ Transfer cleanup completed: ${transferId}`);
    } catch (error) {
        console.error(`❌ Error during cleanup:`, error);
    }
}

// Log activity
async function logActivity(action, transferId, socketId) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        action,
        transferId,
        socketId
    };
    
    const logFile = path.join(config.LOG_DIR, `${new Date().toISOString().split('T')[0]}.log`);
    
    try {
        await fs.appendFile(logFile, JSON.stringify(logEntry) + '\n');
    } catch (error) {
        console.error('❌ Error writing log:', error);
    }
}

// Utility function
function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(2) + ' ' + sizes[i];
}

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK',
        uptime: process.uptime(),
        activeSessions: transferSessions.size,
        activeConnections: activeConnections.size,
        timestamp: new Date().toISOString()
    });
});

// API endpoint
app.get('/api/transfer/:transferId', (req, res) => {
    const { transferId } = req.params;
    const session = transferSessions.get(transferId);
    
    if (!session) {
        return res.status(404).json({ 
            error: 'Transfer not found',
            code: 'SESSION_NOT_FOUND'
        });
    }
    
    res.json({
        transferId: session.transferId,
        status: session.status,
        fileInfo: session.fileInfo,
        chunksReceived: session.chunks.length,
        totalChunks: session.fileInfo?.totalChunks || 0,
        hasReceiver: !!session.receiver
    });
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('⚠️ SIGTERM received, cleaning up...');
    
    for (const transferId of transferSessions.keys()) {
        await cleanupTransfer(transferId);
    }
    
    server.close(() => {
        console.log('👋 Server closed');
        process.exit(0);
    });
});

process.on('SIGINT', async () => {
    console.log('⚠️ SIGINT received, cleaning up...');
    
    for (const transferId of transferSessions.keys()) {
        await cleanupTransfer(transferId);
    }
    
    server.close(() => {
        console.log('👋 Server closed');
        process.exit(0);
    });
});

// Start server
const PORT = config.PORT || 3000;
server.listen(PORT, () => {
    console.log('╔═══════════════════════════════════════════════════════╗');
    console.log('║   🚀 Chunk File Transfer Server Running             ║');
    console.log('╠═══════════════════════════════════════════════════════╣');
    console.log(`║   📍 Server URL: http://localhost:${PORT.toString().padEnd(23)}║`);
    console.log(`║   📁 Temp Directory: ${config.TEMP_DIR.padEnd(31)}║`);
    console.log(`║   💾 Upload Directory: ${config.UPLOAD_DIR.padEnd(29)}║`);
    console.log(`║   📊 Max File Size: ${formatBytes(config.MAX_FILE_SIZE).padEnd(32)}║`);
    console.log(`║   📦 Chunk Size: ${formatBytes(config.CHUNK_SIZE).padEnd(35)}║`);
    console.log('╚═══════════════════════════════════════════════════════╝');
});

module.exports = { app, server, io };
