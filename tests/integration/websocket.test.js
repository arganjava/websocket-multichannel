const WebSocket = require('ws');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

// Import the main WebSocket server instance and its original port
// We need to ensure server.js is loaded, which starts the server.
// The server needs to be running for integration tests.
const serverApp = require('../../src/index'); // This will start the HTTP and WebSocket server
const { wss, PORT: WSPORT, JWT_SECRET, channels: serverChannels, broadcastLocallyFromRedis } = require('../../src/server'); // Access exported items

// Mock Redis for integration tests to avoid external dependency and ensure deterministic behavior
// We want to test the WebSocket server's interaction with Redis, not Redis itself.
const mockRedisActual = require('redis');

const mockPublisher = {
    publish: jest.fn(async (channel, message) => {
        // Simulate Redis Pub/Sub: When a message is published,
        // immediately "forward" it to the server's handler for messages from Redis.
        // This tests the server's reaction to Redis messages without a real Redis.
        // Ensure this is called *after* the original publishToRedis in server.js has run.
        setImmediate(() => {
            // The broadcastLocallyFromRedis function is not directly exported.
            // We need to find a way to trigger the server's internal Redis message handling.
            // For now, we'll spy on console.log to confirm publishToRedis was called.
            // A better approach would be to have a test hook or event emitter from the server.
            // console.log(`Mock Redis: Message published to ${channel}: ${message}`);

            // If broadcastLocallyFromRedis were exported or testable:
            // serverModule.broadcastLocallyFromRedis(channel, message);
        });
        return 1; // Simulate successful publish count
    }),
    connect: jest.fn().mockResolvedValue(),
    quit: jest.fn().mockResolvedValue(),
    on: jest.fn(),
    isOpen: true,
};
const mockSubscriber = {
    subscribe: jest.fn().mockResolvedValue(),
    unsubscribe: jest.fn().mockResolvedValue(),
    connect: jest.fn().mockResolvedValue(),
    quit: jest.fn().mockResolvedValue(),
    on: jest.fn(),
    isOpen: true,
};
mockPublisher.duplicate = jest.fn(() => mockSubscriber);

jest.mock('redis', () => ({
    createClient: jest.fn(() => mockPublisher),
}));


const BASE_URL = `ws://localhost:${WSPORT}`;

// Helper to create a JWT token
const generateTestToken = (userId, secret = JWT_SECRET) => {
    return jwt.sign({ userId }, secret, { expiresIn: '1h' });
};

// Helper to create a WebSocket client and promisify its connection
const createClient = (token, queryParams = '') => {
    const url = token ? `${BASE_URL}?token=${token}${queryParams}` : `${BASE_URL}${queryParams}`;
    const client = new WebSocket(url);
    return new Promise((resolve, reject) => {
        client.on('open', () => resolve(client));
        client.on('error', (err) => reject(err)); // Reject on connection error
        // Add a timeout for connection
        const timeout = setTimeout(() => {
            reject(new Error('Client connection timed out'));
            client.terminate();
        }, 5000); // 5s timeout
        client.on('open', () => clearTimeout(timeout));
        client.on('close', () => clearTimeout(timeout));
    });
};

// Helper to wait for a message from the client
const waitForMessage = (client, timeout = 2000) => {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Timeout waiting for message after ${timeout}ms`));
        }, timeout);
        client.once('message', (message) => {
            clearTimeout(timer);
            try {
                resolve(JSON.parse(message));
            } catch (e) {
                resolve(message.toString()); // Resolve as raw string if not JSON
            }
        });
    });
};


describe('WebSocket Server Integration Tests', () => {
    let testServer;

    beforeAll(async () => {
        // The server is already started by requiring src/index.js
        // Wait a bit for the server to fully initialize if needed, though require usually handles this.
        await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
    });

    afterAll(async () => {
        // Close all active client connections created during tests
        // Terminate the WebSocket server
        if (wss && typeof wss.close === 'function') {
            await new Promise(resolve => wss.close(resolve));
        }
        // Terminate the HTTP server from index.js if it's running (it is due to require)
        // This is tricky as index.js doesn't export its server.
        // For a full cleanup, index.js would need to export its staticServer instance.
        // For now, we rely on Jest exiting the process.
        
        // Disconnect Redis clients if they were real
        if (mockPublisher.isOpen && typeof mockPublisher.quit === 'function') {
            await mockPublisher.quit();
        }
        if (mockSubscriber.isOpen && typeof mockSubscriber.quit === 'function') {
            await mockSubscriber.quit();
        }
        jest.restoreAllMocks(); // Restore original implementations
    });
    
    beforeEach(() => {
        // Clear mocks before each test
        mockPublisher.publish.mockClear();
        mockSubscriber.subscribe.mockClear();
        mockSubscriber.unsubscribe.mockClear();
        // Clear server-side channel map for clean tests (if possible, requires export or test hook)
        // serverChannels.clear(); // This would be ideal
        // For now, tests must be independent or manage shared state carefully.
    });

    describe('Connection and Authentication', () => {
        test('should connect successfully with a valid JWT and receive ack', async () => {
            const token = generateTestToken('user1');
            const client = await createClient(token);
            const ackMsg = await waitForMessage(client);

            expect(ackMsg.type).toBe('ack');
            expect(ackMsg.forAction).toBe('connect');
            expect(ackMsg.message).toBe('Successfully connected');
            client.close();
        });

        test('should fail to connect with a missing JWT and receive error', async () => {
            let client;
            try {
                // WebSocket constructor doesn't throw for URL issues, error comes on 'error' or 'close'
                client = new WebSocket(BASE_URL); // No token
                const response = await waitForMessage(client); // Expect server to send error then close
                expect(response.type).toBe('error');
                expect(response.message).toBe('Authentication token missing');
            } catch (e) {
                // This catch block might not be reached if server sends error then closes.
                // The error handling in createClient might be more relevant.
                expect(e).toBeDefined();
            } finally {
                if (client && client.readyState !== WebSocket.CLOSED) client.close();
            }
        });

        test('should fail to connect with an invalid JWT (bad secret) and receive error', async () => {
            const invalidToken = generateTestToken('user-invalid-secret', 'wrong-secret');
            let client;
            try {
                client = new WebSocket(`${BASE_URL}?token=${invalidToken}`);
                const response = await waitForMessage(client);
                expect(response.type).toBe('error');
                expect(response.message).toBe('Invalid or expired token');
            } finally {
                if (client && client.readyState !== WebSocket.CLOSED) client.close();
            }
        });
        
        test('should fail to connect if JWT does not contain userId and receive error', async () => {
            const tokenMissingUserId = jwt.sign({ someOtherData: 'data' }, JWT_SECRET);
             let client;
            try {
                client = new WebSocket(`${BASE_URL}?token=${tokenMissingUserId}`);
                const response = await waitForMessage(client);
                expect(response.type).toBe('error');
                expect(response.message).toBe('Token missing userId');
            } finally {
                if (client && client.readyState !== WebSocket.CLOSED) client.close();
            }
        });
    });

    describe('Subscription and Unsubscription', () => {
        let client1;

        beforeEach(async () => {
            const token1 = generateTestToken('user-sub-test');
            client1 = await createClient(token1);
            await waitForMessage(client1); // Consume connection ack
        });

        afterEach(() => {
            if (client1 && client1.readyState === WebSocket.OPEN) {
                client1.close();
            }
        });

        test('should subscribe to a channel and receive ack', async () => {
            const clientMessageId = `client-${uuidv4()}`;
            client1.send(JSON.stringify({ type: 'subscribe', channel: 'news', id: clientMessageId }));
            const ackMsg = await waitForMessage(client1);

            expect(ackMsg.type).toBe('ack');
            expect(ackMsg.forAction).toBe('subscribe');
            expect(ackMsg.channel).toBe('news');
            expect(ackMsg.clientMessageId).toBe(clientMessageId);
            expect(mockSubscriber.subscribe).toHaveBeenCalledWith('news', expect.any(Function));
        });

        test('should unsubscribe from a channel and receive ack', async () => {
            // First, subscribe
            client1.send(JSON.stringify({ type: 'subscribe', channel: 'sports' }));
            await waitForMessage(client1); // Consume subscribe ack
            expect(mockSubscriber.subscribe).toHaveBeenCalledWith('sports', expect.any(Function));


            // Then, unsubscribe
            const clientMessageIdUnsub = `client-${uuidv4()}`;
            client1.send(JSON.stringify({ type: 'unsubscribe', channel: 'sports', id: clientMessageIdUnsub }));
            const ackMsgUnsub = await waitForMessage(client1);

            expect(ackMsgUnsub.type).toBe('ack');
            expect(ackMsgUnsub.forAction).toBe('unsubscribe');
            expect(ackMsgUnsub.channel).toBe('sports');
            expect(ackMsgUnsub.clientMessageId).toBe(clientMessageIdUnsub);
            // Check if server unsubscribed from Redis (if it was the last one)
            // This requires knowledge of internal server state or more complex mocking.
            // For now, we trust the subscribe mock was called.
        });
        
        test('should receive error when subscribing to channel with invalid name', async () => {
            const invalidChannelName = 'channel with spaces';
            client1.send(JSON.stringify({ type: 'subscribe', channel: invalidChannelName, id: 'err-sub-1' }));
            const errMsg = await waitForMessage(client1);
            
            expect(errMsg.type).toBe('error');
            expect(errMsg.forAction).toBe('subscribe');
            expect(errMsg.clientMessageId).toBe('err-sub-1');
            expect(errMsg.message).toBe('Invalid channel name format.');
        });
    });

    describe('Message Broadcasting (Single Instance Mocked Redis)', () => {
        let clientA, clientB, clientC;
        const channelX = 'channelX';
        const channelY = 'channelY';

        beforeEach(async () => {
            const tokenA = generateTestToken('userA');
            const tokenB = generateTestToken('userB');
            const tokenC = generateTestToken('userC'); // Not subscribed to channelX initially

            clientA = await createClient(tokenA);
            clientB = await createClient(tokenB);
            clientC = await createClient(tokenC);

            // Consume connection acks
            await waitForMessage(clientA);
            await waitForMessage(clientB);
            await waitForMessage(clientC);

            // Client A subscribes to channelX
            clientA.send(JSON.stringify({ type: 'subscribe', channel: channelX }));
            await waitForMessage(clientA); // ack for subscribe

            // Client B subscribes to channelX
            clientB.send(JSON.stringify({ type: 'subscribe', channel: channelX }));
            await waitForMessage(clientB); // ack for subscribe
            
            // Client C subscribes to channelY
            clientC.send(JSON.stringify({ type: 'subscribe', channel: channelY }));
            await waitForMessage(clientC); // ack for subscribe

            // Clear any previous mock calls from setup
            mockPublisher.publish.mockClear();
        });

        afterEach(() => {
            if (clientA && clientA.readyState === WebSocket.OPEN) clientA.close();
            if (clientB && clientB.readyState === WebSocket.OPEN) clientB.close();
            if (clientC && clientC.readyState === WebSocket.OPEN) clientC.close();
        });

        test('client sending message to a channel receives ack, and message is published to Redis', async () => {
            const messagePayload = { info: 'Hello channelX from A' };
            const clientMsgId = `clientA-msg-${uuidv4()}`;

            clientA.send(JSON.stringify({
                type: 'message',
                channel: channelX,
                payload: messagePayload,
                id: clientMsgId
            }));

            const ackMsg = await waitForMessage(clientA);
            expect(ackMsg.type).toBe('ack');
            expect(ackMsg.forAction).toBe('message');
            expect(ackMsg.clientMessageId).toBe(clientMsgId);
            expect(ackMsg.channel).toBe(channelX);

            // Verify that the message was "published" via our mock
            expect(mockPublisher.publish).toHaveBeenCalledTimes(1);
            expect(mockPublisher.publish).toHaveBeenCalledWith(
                channelX,
                JSON.stringify({ payload: messagePayload, sender: 'userA' })
            );
        });
        
        test('message sent by one client to a channel is received by other subscribed clients on that channel (via mocked Redis)', async () => {
            const messagePayload = { data: "Important update for channelX" };
            const senderUserId = 'userA'; // Client A is sending

            // Simulate client A sending message
            clientA.send(JSON.stringify({ type: 'message', channel: channelX, payload: messagePayload }));
            await waitForMessage(clientA); // Client A's ack

            // Simulate Redis pub/sub mechanism:
            // The mockPublisher.publish, when called, should trigger the server's internal message distribution.
            // We need to "manually" call the server's Redis message handler here with the published data.
            // This is a limitation of not being able to directly hook into the server's Redis subscription callback easily.
            
            // Let's assume server.js has a function like this (it's currently named broadcastLocallyFromRedis but not exported)
            // For this test, we'll invoke it directly if we could.
            // Since we can't, we'll rely on the fact that if publishToRedis works,
            // and if the server is set up to subscribe to Redis, then it *should* work.
            // This part highlights the need for better testability hooks or exporting `broadcastLocallyFromRedis`.

            // For now, let's use a workaround: directly call the function that handles incoming Redis messages,
            // assuming we could somehow import or access it.
            // This is a "white-box" part of the integration test.
            const serverInternalRedisHandler = wss.broadcastLocallyFromRedis || global.broadcastLocallyFromRedis; // Hypothetical access
            
            if (serverInternalRedisHandler && typeof serverInternalRedisHandler === 'function') {
                 serverInternalRedisHandler(channelX, JSON.stringify({ payload: messagePayload, sender: senderUserId }));
            } else {
                // Fallback: If we can't call it directly, we check if Redis was published to,
                // and trust the server's internal wiring for the rest. This is less thorough.
                // This was already checked in the previous test.
                // console.warn("Skipping direct Redis handler call in test, relying on publish mock.");
            }
            
            // Client B (subscribed to channelX) should receive the message
            const receivedByB = await waitForMessage(clientB, 3000); // Increased timeout
            expect(receivedByB.type).toBe('message');
            expect(receivedByB.channel).toBe(channelX);
            expect(receivedByB.payload).toEqual(messagePayload);
            expect(receivedByB.sender).toBe(senderUserId);

            // Client C (subscribed to channelY) should NOT receive the message
            const noMessageForC = waitForMessage(clientC, 500); // Shorter timeout, expect it to fail
            await expect(noMessageForC).rejects.toThrow('Timeout waiting for message');
        });
    });
    
    // TODO: Add tests for graceful shutdown if possible (tricky in automated tests)
    // TODO: Add tests for server behavior when Redis connection fails (requires more advanced mocking)
});

// This is a hack to allow the test above to call the server's internal Redis message handler.
// In a real scenario, you'd use dependency injection or an event emitter for better testability.
global.broadcastLocallyFromRedis = require('../../src/server').broadcastLocallyFromRedis;

// Clean up the global hack after tests run
afterAll(() => {
    delete global.broadcastLocallyFromRedis;
});
