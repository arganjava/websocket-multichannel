document.addEventListener('DOMContentLoaded', () => {
    const serverUrlInput = document.getElementById('serverUrl');
    const jwtTokenInput = document.getElementById('jwtToken');
    const connectButton = document.getElementById('connectButton');
    const disconnectButton = document.getElementById('disconnectButton');
    const actionsSection = document.getElementById('actionsSection');

    const channelNameInput = document.getElementById('channelName');
    const subscribeButton = document.getElementById('subscribeButton');
    const unsubscribeButton = document.getElementById('unsubscribeButton');
    const messagePayloadInput = document.getElementById('messagePayload');
    const clientMessageIdInput = document.getElementById('clientMessageId');
    const sendMessageButton = document.getElementById('sendMessageButton');
    const messagesArea = document.getElementById('messagesArea');

    let socket = null;

    function logMessage(message, type = 'info') {
        const div = document.createElement('div');
        div.classList.add('log-message', `log-${type}`);
        div.textContent = `[${new Date().toLocaleTimeString()}] ${type.toUpperCase()}: ${message}`;
        messagesArea.appendChild(div);
        messagesArea.scrollTop = messagesArea.scrollHeight; // Scroll to bottom
    }

    function updateUIForConnection(isConnected) {
        connectButton.disabled = isConnected;
        disconnectButton.disabled = !isConnected;
        serverUrlInput.disabled = isConnected;
        jwtTokenInput.disabled = isConnected;
        actionsSection.style.display = isConnected ? 'block' : 'none';
    }

    connectButton.addEventListener('click', () => {
        const url = serverUrlInput.value;
        const token = jwtTokenInput.value;

        if (!url) {
            logMessage('Server URL is required.', 'error');
            return;
        }
        if (!token) {
            logMessage('JWT Token is required. For demo, use a token like: {"userId":"demoUser"} signed with the server\'s JWT_SECRET.', 'error');
            // A simple, insecure example token if your server uses 'your-secret-key' and expects { userId: '...' }
            // This token is: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJkZW1vVXNlciJ9.j_E7w3g4sQx1Za7-3M5v_E5pWJzB3X2jD6V4-AS2Eto
            // You can generate one at jwt.io
            jwtTokenInput.value = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySWQiOiJkZW1vVXNlciJ9.j_E7w3g4sQx1Za7-3M5v_E5pWJzB3X2jD6V4-AS2Eto';
            logMessage('Example token (for userId: demoUser, secret: your-secret-key) has been populated. Please ensure this matches your server config.', 'info');
            return;
        }

        const fullUrl = `${url}?token=${encodeURIComponent(token)}`;
        logMessage(`Attempting to connect to ${fullUrl}`, 'client');

        try {
            socket = new WebSocket(fullUrl);
        } catch (error) {
            logMessage(`Connection error: ${error.message}`, 'error');
            updateUIForConnection(false);
            return;
        }


        socket.onopen = () => {
            logMessage('Connected to server.', 'server');
            updateUIForConnection(true);
        };

        socket.onmessage = (event) => {
            try {
                const serverMessage = JSON.parse(event.data);
                logMessage(`Received: ${JSON.stringify(serverMessage, null, 2)}`, 'server');
            } catch (e) {
                logMessage(`Received raw: ${event.data}`, 'server');
                logMessage(`Error parsing server message: ${e.message}`, 'error');
            }
        };

        socket.onerror = (error) => {
            logMessage(`WebSocket Error: ${error.message || 'An unknown error occurred.'}`, 'error');
            // The 'close' event will usually follow an error.
        };

        socket.onclose = (event) => {
            logMessage(`Disconnected from server. Code: ${event.code}, Reason: ${event.reason || 'N/A'}`, event.wasClean ? 'info' : 'error');
            updateUIForConnection(false);
            socket = null;
        };
    });

    disconnectButton.addEventListener('click', () => {
        if (socket) {
            logMessage('Disconnecting...', 'client');
            socket.close();
        }
    });

    function sendToServer(messageObject) {
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            logMessage('Not connected to server.', 'error');
            return;
        }
        try {
            const jsonMessage = JSON.stringify(messageObject);
            logMessage(`Sending: ${jsonMessage}`, 'client');
            socket.send(jsonMessage);
        } catch (e) {
            logMessage(`Error preparing message: ${e.message}`, 'error');
        }
    }
    
    function getClientMessageId() {
        const id = clientMessageIdInput.value.trim();
        return id ? id : undefined;
    }

    subscribeButton.addEventListener('click', () => {
        const channel = channelNameInput.value.trim();
        if (!channel) {
            logMessage('Channel name is required for subscribe.', 'error');
            return;
        }
        sendToServer({
            type: 'subscribe',
            channel: channel,
            id: getClientMessageId()
        });
    });

    unsubscribeButton.addEventListener('click', () => {
        const channel = channelNameInput.value.trim();
        if (!channel) {
            logMessage('Channel name is required for unsubscribe.', 'error');
            return;
        }
        sendToServer({
            type: 'unsubscribe',
            channel: channel,
            id: getClientMessageId()
        });
    });

    sendMessageButton.addEventListener('click', () => {
        const channel = channelNameInput.value.trim();
        const payloadString = messagePayloadInput.value.trim();

        if (!channel) {
            logMessage('Channel name is required for sending a message.', 'error');
            return;
        }
        if (!payloadString) {
            logMessage('Message payload is required.', 'error');
            return;
        }

        let payload;
        try {
            payload = JSON.parse(payloadString);
        } catch (e) {
            logMessage(`Invalid JSON in payload: ${e.message}`, 'error');
            return;
        }

        sendToServer({
            type: 'message',
            channel: channel,
            payload: payload,
            id: getClientMessageId()
        });
    });

    // Initial UI state
    updateUIForConnection(false);
});
