const http = require('http');
const fs = require('fs');
const path = require('path');
const { wss, PORT: WSPORT } = require('./server'); // Import wss and its configured port

// --- HTTP Server for Static Files ---
const HTTP_PORT = process.env.HTTP_PORT || 3000; // Port for the HTTP static server

const staticServer = http.createServer((req, res) => {
    let filePath = '.' + req.url;
    if (filePath === './') {
        filePath = './public/index.html';
    } else {
        filePath = './public' + req.url;
    }

    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
    };

    const contentType = mimeTypes[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code == 'ENOENT') {
                fs.readFile('./public/404.html', (err404, content404) => { // Optional: Serve a 404.html page
                    res.writeHead(404, { 'Content-Type': 'text/html' });
                    if (err404) {
                        res.end('404 Not Found', 'utf-8');
                    } else {
                        res.end(content404, 'utf-8');
                    }
                });
            } else {
                res.writeHead(500);
                res.end('Sorry, check with the site admin for error: ' + error.code + ' ..\n');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

staticServer.listen(HTTP_PORT, () => {
    console.log(`HTTP server for static files listening on port ${HTTP_PORT}`);
    console.log(`Web client demo available at http://localhost:${HTTP_PORT}/`);
});

// The WebSocket server (wss) is already started in server.js when it's imported.
// server.js logs its own port (WSPORT).
// Ensure WSPORT and HTTP_PORT are different if running on the same host.
if (WSPORT == HTTP_PORT) {
    console.warn(`Warning: WebSocket Port (${WSPORT}) and HTTP Port (${HTTP_PORT}) are the same. This might cause issues if the HTTP server doesn't handle WebSocket upgrade requests properly. Consider using different ports.`);
}

// Keep the process alive (though http.createServer and wss.Server usually do this)
// setInterval(() => {}, 1 << 30);
