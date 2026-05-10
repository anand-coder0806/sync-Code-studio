const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const clientRoot = path.resolve(__dirname, '..');
const buildDir = path.join(clientRoot, 'build');
const configuredPort = process.env.PORT ? Number(process.env.PORT) : 3000;
const maxPortAttempts = 10;

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const buildExists = fs.existsSync(path.join(buildDir, 'index.html'));

if (!buildExists) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const buildResult = spawnSync(npmCommand, ['run', 'build'], {
    cwd: clientRoot,
    stdio: 'inherit',
    shell: false,
  });

  if (buildResult.status !== 0) {
    process.exit(buildResult.status || 1);
  }
}

const sendFile = (res, filePath) => {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.statusCode = 500;
      res.end('Internal Server Error');
      return;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    res.end(data);
  });
};

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  const safePath = pathname.replace(/^\/+/, '');
  const candidatePath = path.join(buildDir, safePath);

  if (safePath && fs.existsSync(candidatePath) && fs.statSync(candidatePath).isFile()) {
    sendFile(res, candidatePath);
    return;
  }

  sendFile(res, path.join(buildDir, 'index.html'));
});

let activePort = configuredPort;
let portAttempts = 0;

const listenOnPort = (port) => {
  activePort = port;
  server.listen(port, () => {
    console.log(`Serving the React frontend from build/ on port ${port}`);
  });
};

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    // Respect explicit PORT values to avoid silently changing expected deployment ports.
    if (process.env.PORT) {
      console.error(`Port ${activePort} is already in use. Set a different PORT and retry.`);
      process.exit(1);
    }

    portAttempts += 1;
    if (portAttempts >= maxPortAttempts) {
      console.error(`Unable to find an open port after ${maxPortAttempts} attempts starting at ${configuredPort}.`);
      process.exit(1);
    }

    const nextPort = activePort + 1;
    console.warn(`Port ${activePort} is in use. Retrying on port ${nextPort}...`);
    listenOnPort(nextPort);
    return;
  }

  console.error('Failed to start static server:', error.message);
  process.exit(1);
});

listenOnPort(configuredPort);

const shutdown = () => {
  server.close(() => process.exit(0));
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
