// config.js - Configuration for Chunk File Transfer System

module.exports = {
    // Server Configuration
    PORT: process.env.PORT || 3000,
    NODE_ENV: process.env.NODE_ENV || 'development',
    
    // File Transfer Settings
    CHUNK_SIZE: 10 * 1024 * 1024, // 10MB chunks
    MAX_FILE_SIZE: 2 * 1024 * 1024 * 1024, // 2GB max file size
    MAX_BUFFER_SIZE: 100 * 1024 * 1024, // 100MB max buffer (for Socket.io)
    
    // Cleanup Settings
    CLEANUP_INTERVAL: 3600000, // 1 hour (in milliseconds)
    AUTO_CLEANUP: true,
    
    // CORS Configuration
    CORS_ORIGIN: process.env.CORS_ORIGIN || "*",
    
    // Directory Paths
    TEMP_DIR: process.env.TEMP_DIR || './temp',
    UPLOAD_DIR: process.env.UPLOAD_DIR || './uploads',
    LOG_DIR: process.env.LOG_DIR || './logs',
    
    // Socket.io Settings
    PING_TIMEOUT: 60000, // 60 seconds
    PING_INTERVAL: 25000, // 25 seconds
    
    // Rate Limiting (Future Enhancement)
    MAX_CONCURRENT_UPLOADS: 5,
    MAX_CHUNKS_PER_SECOND: 10,
    
    // Logging
    LOG_LEVEL: process.env.LOG_LEVEL || 'info',
    ENABLE_LOGGING: true,
    
    // Security (Future Enhancement)
    ENABLE_ENCRYPTION: false,
    MAX_TRANSFER_AGE: 86400000, // 24 hours
    
    // Feature Flags
    FEATURES: {
        CHUNK_MERGE: true,
        RESUME_SUPPORT: false, // Future feature
        COMPRESSION: false, // Future feature
        ENCRYPTION: false // Future feature
    }
};
