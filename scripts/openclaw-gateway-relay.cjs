const net = require('node:net');

const [, , listenHost = '127.0.0.1', listenPortRaw = '18790', targetHost = '8.216.38.213', targetPortRaw = '18790'] = process.argv;
const listenPort = Number(listenPortRaw);
const targetPort = Number(targetPortRaw);

if (!Number.isInteger(listenPort) || !Number.isInteger(targetPort)) {
  console.error('Usage: node openclaw-gateway-relay.cjs [listenHost] [listenPort] [targetHost] [targetPort]');
  process.exit(1);
}

const server = net.createServer((client) => {
  const upstream = net.connect({ host: targetHost, port: targetPort });

  client.pipe(upstream);
  upstream.pipe(client);

  const closeBoth = () => {
    client.destroy();
    upstream.destroy();
  };

  client.on('error', closeBoth);
  upstream.on('error', closeBoth);
});

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.log(`[OpenClawRelay] ${listenHost}:${listenPort} already in use; assuming a relay is already running.`);
    process.exit(0);
  }
  console.error('[OpenClawRelay] failed:', error);
  process.exit(1);
});

server.listen(listenPort, listenHost, () => {
  console.log(`[OpenClawRelay] ${listenHost}:${listenPort} -> ${targetHost}:${targetPort}`);
});
