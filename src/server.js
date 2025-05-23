const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');
const redis = require('redis');
const { v4: uuidv4 } = require('uuid'); // For generating unique IDs

const PORT = process.env.PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key'; // Use environment variable or default
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = process.env.REDIS_PORT || 6379;

const channels = new Map(); // Map<channelName, Set<WebSocket>>

// Create Redis clients for publishing and subscribing
const publisher = redis.createClient({
    socket: {
        host: REDIS_HOST,
        port: REDIS_PORT,
    }
});
const subscriber = publisher.duplicate();

publisher.on('error', (err) => console.error('Redis Publisher Error:', err));
subscriber.on('error', (err) => console.error('Redis Subscriber Error:', err));

const wss = new WebSocket.Server({ port: PORT });

console.log(`WebSocket server started on port ${PORT}`);
console.log(`Attempting to connect to Redis on ${REDIS_HOST}:${REDIS_PORT}`);

async function connectRedis() {
    try {
        await publisher.connect();
        console.log('Redis Publisher connected.');
        await subscriber.connect();
        console.log('Redis Subscriber connected.');

        // Subscribe to a pattern or specific channels if known beforehand
        // For dynamic channels based on client subscriptions, this will be handled in handleSubscribe
    } catch (err) {
        console.error('Failed to connect to Redis:', err);
        // Handle reconnection or exit if Redis is critical
    }
}

connectRedis();

wss.on('connection', (ws, req) => {
    const { query } = url.parse(req.url, true);
    const token = query.token;

    if (!token) {
        // PRD: Send error in new format
        ws.send(JSON.stringify({ type: 'error', message: 'Authentication token missing', forAction: 'connect' }));
        ws.terminate();
        return;
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        // PRD: Ensure userId is extracted. Standard JWT often uses 'sub' or 'id' for user ID.
        // Assuming 'userId' is in the token as per previous implementation.
        if (!decoded.userId) {
            ws.send(JSON.stringify({ type: 'error', message: 'Token missing userId', forAction: 'connect' }));
            ws.terminate();
            return;
        }
        ws.userId = decoded.userId;
        console.log(`Client connected: ${ws.userId}`);
        // PRD: Send ack in new format
        ws.send(JSON.stringify({ type: 'ack', id: uuidv4(), forAction: 'connect', message: 'Successfully connected' }));
    } catch (err) {
        // PRD: Send error in new format
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired token', forAction: 'connect' }));
        ws.terminate();
        return;
    }

    ws.subscribedChannels = new Set(); // Keep track of channels this WS is subscribed to

    ws.on('message', (message) => {
        try {
            const parsedMessage = JSON.parse(message);
            console.log(`Received message from ${ws.userId}:`, parsedMessage);

            // PRD: Client to Server message types
            switch (parsedMessage.type) {
                case 'subscribe':
                    // PRD: Already aligned with { "type": "subscribe", "channel": "..." }
                    handleSubscribe(ws, parsedMessage.channel, parsedMessage.id); // Pass messageId for ack
                    break;
                case 'unsubscribe':
                    // PRD: Already aligned with { "type": "unsubscribe", "channel": "..." }
                    handleUnsubscribe(ws, parsedMessage.channel, false, parsedMessage.id); // Pass messageId for ack
                    break;
                case 'message': // PRD: Changed from 'broadcast' to 'message'
                    // PRD: Expects { "type": "message", "channel": "...", "payload": {...} }
                    if (!parsedMessage.payload) {
                        ws.send(JSON.stringify({ type: 'error', id: uuidv4(), forAction: 'message', message: 'Payload missing in message' }));
                        return;
                    }
                    publishToRedis(parsedMessage.channel, parsedMessage.payload, ws.userId);
                    // PRD: Send ack for message receipt
                    ws.send(JSON.stringify({ type: 'ack', id: uuidv4(), forAction: 'message', channel: parsedMessage.channel, message: 'Message received for processing' }));
                    break;
                default:
                    // PRD: Send error in new format
                    ws.send(JSON.stringify({ type: 'error', id: uuidv4(), forAction: 'unknown', message: `Unknown message type: ${parsedMessage.type}` }));
            }
        } catch (e) {
            // PRD: Send error in new format for parsing errors
            ws.send(JSON.stringify({ type: 'error', id: uuidv4(), forAction: 'message_parse', message: 'Invalid JSON message format' }));
            console.error(`Failed to parse message or handle event from ${ws.userId}: ${e.message}. Message: ${message}`);
        }
    });

    ws.on('close', () => {
        console.log(`Client disconnected: ${ws.userId}`);
        // Remove client from all subscribed channels and unsubscribe from Redis if necessary
        // When client disconnects, unsubscribe them from all their channels.
        // The 'isDisconnecting = true' flag in handleUnsubscribe will prevent sending ack/error back to the closed socket.
        ws.subscribedChannels.forEach(channel => {
            handleUnsubscribe(ws, channel, true, null); // isDisconnecting = true, no client messageId
        });
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error for client ${ws.userId}:`, error);
        // Termination and cleanup is handled by 'close' event
    });
});

// Keep track of Redis channels this server instance is subscribed to
const subscribedRedisChannels = new Set(); // Tracks Redis channels this server INSTANCE is subscribed to.

// Handles client 'subscribe' requests
async function handleSubscribe(ws, channel, clientMessageId) {
    const action = 'subscribe';
    if (!channel) {
        // PRD: Send error in new format
        ws.send(JSON.stringify({ type: 'error', id: uuidv4(), forAction: action, clientMessageId, message: 'Channel not specified' }));
        return;
    }
    // Basic channel name validation (optional, can be expanded)
    if (!/^[a-zA-Z0-9_-]+$/.test(channel)) {
        ws.send(JSON.stringify({ type: 'error', id: uuidv4(), forAction: action, clientMessageId, message: 'Invalid channel name format.' }));
        return;
    }

    // Create channel if it doesn't exist locally
    if (!channels.has(channel)) {
        channels.set(channel, new Set());
    }

    // Add client to the local set for this channel
    if (channels.get(channel).has(ws)) {
        // Client is already subscribed to this channel
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ack', id: uuidv4(), forAction: action, clientMessageId, channel, message: `Already subscribed to ${channel}` }));
        }
        return; // Avoid re-subscribing to Redis if already done
    }
    channels.get(channel).add(ws);
    ws.subscribedChannels.add(channel); // Track for this specific ws connection for easy unsubscribe on disconnect

    // If this server instance is not yet subscribed to this channel in Redis, subscribe now
    // This is an optimization to prevent multiple Redis subscriptions for the same channel by the same server instance.
    if (!subscribedRedisChannels.has(channel)) {
        try {
            // The callback for subscriber.subscribe handles messages from Redis.
            await subscriber.subscribe(channel, (messagePayload, redisChannel) => {
                // Ensure message is processed for the correct channel.
                // (redisChannel parameter in callback confirms this)
                broadcastLocallyFromRedis(redisChannel, messagePayload);
            });
            subscribedRedisChannels.add(channel);
            console.log(`Server instance ${process.pid} subscribed to Redis channel: ${channel}`);
        } catch (err) {
            console.error(`Server instance ${process.pid} failed to subscribe to Redis channel ${channel}:`, err);
            // Remove client from local set as backend subscription failed
            channels.get(channel).delete(ws);
            ws.subscribedChannels.delete(channel);
            if (channels.get(channel).size === 0) {
                channels.delete(channel);
            }
            if (ws.readyState === WebSocket.OPEN) {
                 // PRD: Send error in new format
                ws.send(JSON.stringify({ type: 'error', id: uuidv4(), forAction: action, clientMessageId, channel, message: `Failed to subscribe to backend channel processing for ${channel}` }));
            }
            return;
        }
    }

    // PRD: Send ack in new format
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ack', id: uuidv4(), forAction: action, clientMessageId, channel, message: `Subscribed to ${channel}` }));
    }
    console.log(`Client ${ws.userId} subscribed to ${channel}. Local subscribers on this instance: ${channels.get(channel).size}. Total Redis subscribed channels on this instance: ${subscribedRedisChannels.size}`);
}

// Handles client 'unsubscribe' requests
async function handleUnsubscribe(ws, channel, isDisconnecting = false, clientMessageId) {
    const action = 'unsubscribe';
    if (!channel) {
        if (!isDisconnecting && ws.readyState === WebSocket.OPEN) {
            // PRD: Send error in new format
            ws.send(JSON.stringify({ type: 'error', id: uuidv4(), forAction: action, clientMessageId, message: 'Channel not specified' }));
        }
        return;
    }

    ws.subscribedChannels.delete(channel); // Remove from ws specific tracking, regardless of local channel existence

    if (channels.has(channel)) {
        const clientSet = channels.get(channel);
        if (clientSet.has(ws)) {
            clientSet.delete(ws); // Remove client from local channel set
            console.log(`Client ${ws.userId} unsubscribed from ${channel}. Remaining local subscribers on this instance: ${clientSet.size}`);

            if (!isDisconnecting && ws.readyState === WebSocket.OPEN) {
                // PRD: Send ack in new format
                ws.send(JSON.stringify({ type: 'ack', id: uuidv4(), forAction: action, clientMessageId, channel, message: `Unsubscribed from ${channel}` }));
            }

            // If no local clients are subscribed to this channel on this server instance,
            // then this server instance can unsubscribe from the Redis channel.
            if (clientSet.size === 0) {
                channels.delete(channel); // Remove the channel itself from local map
                if (subscribedRedisChannels.has(channel)) {
                    try {
                        await subscriber.unsubscribe(channel);
                        subscribedRedisChannels.delete(channel);
                        console.log(`Server instance ${process.pid} unsubscribed from Redis channel: ${channel}. Total Redis subscribed channels on this instance: ${subscribedRedisChannels.size}`);
                    } catch (err) {
                        console.error(`Server instance ${process.pid} failed to unsubscribe from Redis channel ${channel}:`, err);
                        // Log error, but don't send error to client as they already got ack for their action or are disconnecting
                    }
                }
            }
        } else {
            // Client was not in the local set for this channel
            if (!isDisconnecting && ws.readyState === WebSocket.OPEN) {
                 // PRD: Send error in new format (client tried to unsubscribe from a channel they weren't subscribed to)
                ws.send(JSON.stringify({ type: 'error', id: uuidv4(), forAction: action, clientMessageId, channel, message: `Not subscribed to ${channel}` }));
            }
        }
    } else {
        // Channel doesn't exist locally (implies client wasn't subscribed, or was already removed)
        if (!isDisconnecting && ws.readyState === WebSocket.OPEN) {
            // PRD: Send error in new format
            ws.send(JSON.stringify({ type: 'error', id: uuidv4(), forAction: action, clientMessageId, channel, message: `Channel ${channel} does not exist or you are not subscribed` }));
        }
    }
}

// Publishes a message (received from a client) to a Redis channel
// PRD: 'message' from client contains 'payload'
async function publishToRedis(channel, payload, senderId) {
    if (!channel || payload === undefined) {
        console.error(`Attempted to publish to Redis with invalid channel or payload. Channel: ${channel}, Sender: ${senderId}`);
        // Optionally, inform the sender if ws object is available here, though ack is sent earlier.
        return;
    }
    try {
        // PRD: The message broadcast to other clients should be: { "channel": "...", "payload": {...}, "sender": "userId" }
        // So, the Redis message itself should contain payload and sender. Channel is the Redis channel name.
        const redisMessage = JSON.stringify({ payload, sender: senderId });
        await publisher.publish(channel, redisMessage);
        console.log(`User ${senderId} published message to Redis channel '${channel}'. Payload: ${JSON.stringify(payload)}`);
    } catch (err) {
        console.error(`Failed to publish message to Redis channel ${channel} for sender ${senderId}:`, err);
        // Consider how to inform the original sender if this fails. The current design sends ack upon receiving from client.
        // This failure means other clients won't get the message.
    }
}

// This function is called by the Redis subscriber callback when a message arrives on a Redis channel
// It then broadcasts this message to all locally connected WebSocket clients subscribed to that channel.
// PRD: Server to Client message format: { "channel": "...", "payload": {...}, "sender": "userId" }
function broadcastLocallyFromRedis(redisChannel, messagePayload) {
    const localSubscribers = channels.get(redisChannel); // 'redisChannel' is the channel name
    if (localSubscribers) {
        try {
            // The messagePayload from Redis is expected to be a JSON string containing { payload, sender }
            const parsedMessage = JSON.parse(messagePayload);
            const { payload, sender } = parsedMessage;

            if (payload === undefined || sender === undefined) {
                console.error(`Invalid message structure from Redis on channel ${redisChannel}. Payload: ${messagePayload}`);
                return;
            }

            // PRD: Construct the message for the client
            const clientMessage = JSON.stringify({
                type: 'message', // This is the event type for the client
                channel: redisChannel,
                payload: payload,
                sender: sender
            });

            localSubscribers.forEach(client => {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(clientMessage);
                }
            });
            console.log(`Message from Redis (originally from ${sender}, channel ${redisChannel}) broadcasted to ${localSubscribers.size} local clients on instance ${process.pid}.`);
        } catch (e) {
            console.error(`Failed to parse message from Redis or broadcast locally on instance ${process.pid}: ${e.message}. Channel: ${redisChannel}, Payload: ${messagePayload}`);
        }
    }
}

// Graceful shutdown
async function gracefulShutdown() { // Renamed for clarity
    console.log('Shutting down server...');
    // Stop new connections
    wss.close(() => {
        console.log(`WebSocket server on instance ${process.pid} closed to new connections.`);
    });

    // Send shutdown message to existing clients
    console.log(`Terminating ${wss.clients.size} connected clients on instance ${process.pid}...`);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            // PRD: Send info message in new format (though 'info' isn't strictly in PRD, it's good practice)
            // For strict PRD, might omit this or define an 'info' type if allowed.
            // Using 'error' type for shutdown message as a generic notification.
            client.send(JSON.stringify({ type: 'error', id: uuidv4(), forAction: 'disconnect', message: 'Server is shutting down.' }));
        }
        client.terminate();
    });
    console.log(`All WebSocket clients on instance ${process.pid} terminated.`);

    try {
        if (subscriber.isOpen) {
            const channelsToUnsubscribe = Array.from(subscribedRedisChannels);
            if (channelsToUnsubscribe.length > 0) {
                 await subscriber.unsubscribe(channelsToUnsubscribe);
                 console.log(`Redis Subscriber on instance ${process.pid} unsubscribed from all channels:`, channelsToUnsubscribe.join(', '));
            }
            await subscriber.quit();
            console.log(`Redis Subscriber on instance ${process.pid} disconnected.`);
        } else {
            console.log(`Redis Subscriber on instance ${process.pid} was not open.`);
        }
    } catch (err) {
        console.error(`Error during Redis Subscriber quit on instance ${process.pid}:`, err);
    }

    try {
        if (publisher.isOpen) {
            await publisher.quit();
            console.log(`Redis Publisher on instance ${process.pid} disconnected.`);
        } else {
            console.log(`Redis Publisher on instance ${process.pid} was not open.`);
        }
    } catch (err) {
        console.error(`Error during Redis Publisher quit on instance ${process.pid}:`, err);
    }
    
    console.log(`Graceful shutdown complete for instance ${process.pid}.`);
    // In a real multi-process scenario, ensure the primary process handles exit, or use a process manager.
    // For a single Node process, process.exit() is fine.
    process.exit(0); 
}

// Listen for termination signals
process.on('SIGINT', gracefulShutdown); // Ctrl+C
process.on('SIGTERM', gracefulShutdown); // kill command

module.exports = {
    wss, // WebSocket server instance
    channels, // Local channel subscriptions
    // No need to export broadcastLocallyFromRedis, publishToRedis, etc. as they are internal.
};
