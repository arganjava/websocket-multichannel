# WebSocket Multichannel System

This project implements a WebSocket server that allows clients to subscribe to specific channels and receive messages broadcasted on those channels. It uses Redis Pub/Sub to enable scaling across multiple server instances.

## Features

- Multiple channels: Clients can subscribe to one or more channels.
- Broadcasting: Messages can be broadcasted to all clients subscribed to a specific channel via Redis.
- Scalability: Designed for horizontal scaling using Redis Pub/Sub.
- Dockerized: The application can be easily containerized using Docker for deployment.
- JWT Authentication: Connections are authenticated using JWT.

## Getting Started

**Prerequisites:**
- Node.js (v18 or later recommended)
- npm
- A running Redis instance (e.g., connectable at `redis://localhost:6379`)

**Setup:**
1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd websocket-multichannel
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure environment variables (optional):
   Create a `.env` file in the project root (and ensure it's in `.gitignore`):
   ```
   PORT=8080
   JWT_SECRET=your-super-secret-key
   REDIS_HOST=localhost
   REDIS_PORT=6379
   ```
   - `PORT`: WebSocket server port (default: 8080)
   - `JWT_SECRET`: Secret key for JWT authentication (default: 'your-secret-key')
   - `REDIS_HOST`: Redis host (default: 'localhost')
   - `REDIS_PORT`: Redis port (default: 6379)

4. Start the server:
   ```bash
   npm start
   ```

## Usage

Clients connect to the WebSocket server using a URL like `ws://localhost:8080?token=YOUR_JWT_TOKEN`.
The `YOUR_JWT_TOKEN` should be a valid JSON Web Token containing a `userId` field (e.g., `{ "userId": "user123" }`), signed with the `JWT_SECRET`.

**Client → Server Events:**
Clients can optionally include an `"id": "<client-message-id>"` field in their messages. If provided, the server's `ack` or `error` response related to that specific message will include a `clientMessageId` field with the echoed ID.

- **`subscribe`**:
  ```json
  {
    "type": "subscribe",
    "channel": "news-updates",
    "id": "client-msg-1" // Optional
  }
  ```

- **`unsubscribe`**:
  ```json
  {
    "type": "unsubscribe",
    "channel": "news-updates",
    "id": "client-msg-2" // Optional
  }
  ```

- **`message`** (to broadcast to a channel):
  ```json
  {
    "type": "message",
    "channel": "news-updates",
    "payload": { "text": "Hello everyone!" },
    "id": "client-msg-3" // Optional
  }
  ```

**Server → Client Events:**

- **`message`** (broadcasted message from a channel):
  ```json
  {
    "type": "message",
    "channel": "news-updates",
    "payload": { "text": "Hello everyone!" },
    "sender": "userId_of_original_sender"
  }
  ```

- **`ack`** (acknowledgment of a client action):
  ```json
  {
    "type": "ack",
    "id": "<server-generated-uuid>", // Unique ID for this ack message
    "forAction": "<original_action>", // e.g., "connect", "subscribe", "unsubscribe", "message"
    "clientMessageId": "<client-msg-id>", // Optional: echoes client's message ID if provided
    "channel": "news-updates", // Optional: relevant channel for subscribe/unsubscribe/message acks
    "message": "Descriptive message" // e.g., "Successfully connected", "Subscribed to news-updates"
  }
  ```
  *Example connection ack:*
  ```json
  { "type": "ack", "id": "uuid-server-1", "forAction": "connect", "message": "Successfully connected" }
  ```
  *Example subscribe ack:*
  ```json
  { "type": "ack", "id": "uuid-server-2", "forAction": "subscribe", "clientMessageId": "client-msg-1", "channel": "news-updates", "message": "Subscribed to news-updates" }
  ```
  *Example message ack (confirming server received client's message for broadcast):*
  ```json
  { "type": "ack", "id": "uuid-server-3", "forAction": "message", "clientMessageId": "client-msg-3", "channel": "news-updates", "message": "Message received for processing" }
  ```

- **`error`**:
  ```json
  {
    "type": "error",
    "id": "<server-generated-uuid>", // Unique ID for this error message
    "forAction": "<original_action>", // Optional: e.g., "connect", "subscribe", "message_parse"
    "clientMessageId": "<client-msg-id>", // Optional: echoes client's message ID if provided
    "message": "Error description" // e.g., "Authentication token missing", "Invalid channel name format."
  }
  ```
  *Example connection error:*
  ```json
  { "type": "error", "id": "uuid-server-4", "forAction": "connect", "message": "Invalid or expired token" }
  ```
  *Example subscribe error:*
  ```json
  { "type": "error", "id": "uuid-server-5", "forAction": "subscribe", "clientMessageId": "client-msg-x", "message": "Channel not specified" }
  ```
  *Example server shutdown info (sent as an error type for simplicity as per current implementation):*
  ```json
  { "type": "error", "id": "uuid-server-6", "forAction": "disconnect", "message": "Server is shutting down." }
  ```

## Web Client Demo

A simple web-based client demo is available to interact with the WebSocket server.

**Accessing the Demo:**
1. Ensure the main application server is running (`npm start`). This starts both the WebSocket server (default `ws://localhost:8080`) and the HTTP server for the demo.
2. By default, the HTTP server for the demo runs on port 3000. Open your web browser and navigate to:
   `http://localhost:3000/`

**Using the Demo:**
1.  **Server URL:** Defaults to `ws://localhost:8080`. Change this if your WebSocket server is running on a different URL.
2.  **JWT Token:** You need to provide a valid JWT token that the server can verify.
    *   The token **must** contain a `userId` field in its payload, e.g., `{ "userId": "demoUser123" }`.
    *   This token must be signed with the same `JWT_SECRET` that the server is using. The default secret on the server is `your-secret-key`.
    *   **Generating a Token:** You can use a tool like [jwt.io](https://jwt.io/) to generate a token.
        *   Set the algorithm to `HS256`.
        *   Payload: `{"userId": "yourChosenId"}` (e.g., `{"userId": "demoUser"}`)
        *   Secret: The value of `JWT_SECRET` your server is using (e.g., `your-secret-key`).
    *   An example token, generated with `userId: "demoUser"` and secret `your-secret-key`, is:
        `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJkZW1vVXNlciJ9.j_E7w3g4sQx1Za7-3M5v_E5pWJzB3X2jD6V4-AS2Eto`
        The client demo will suggest this token if the JWT field is left empty, for convenience.
3.  **Connect/Disconnect:** Use these buttons to manage the WebSocket connection.
4.  **Channel Name:** Specify the channel for `subscribe`, `unsubscribe`, or `message` actions.
5.  **Message Payload (JSON):** For the `message` action, enter a valid JSON object.
6.  **Client Message ID (Optional):** You can provide a unique ID for your client messages. The server will echo this ID in its `ack` or `error` response related to your message, which can help in correlating requests and responses.
7.  **Actions:**
    *   **Subscribe/Unsubscribe:** Join or leave the specified channel.
    *   **Send Message:** Broadcasts the JSON payload to the specified channel.
8.  **Logs & Server Messages:** This area displays messages sent and received, as well as client-side logs.

## Testing

This project uses Jest for unit and integration testing.

**Running Tests:**

To run all tests, use the following command:
```bash
npm test
```

This will execute tests found in the `tests/unit` and `tests/integration` directories.

**Test Coverage:**

To generate a test coverage report, you can run:
```bash
npm test -- --coverage
```
Coverage reports will be generated in the `coverage/` directory.

**Unit Tests:**

Unit tests are located in `tests/unit`. They focus on testing individual components or functions in isolation. Currently, due to the integrated nature of `src/server.js`, some unit tests are more conceptual and highlight areas for future refactoring to improve testability.

**Integration Tests:**

Integration tests are located in `tests/integration`. These tests verify the interaction between different parts of the system, such as:
- WebSocket connection and authentication flows.
- Channel subscription and unsubscription logic.
- Message broadcasting through a mocked Redis Pub/Sub layer.

The integration tests start the server and simulate client interactions.