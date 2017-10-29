import { connectToReliableUdpServer } from '../rudp';

async function main() {
  const socket = await connectToReliableUdpServer({
    hostname: 'localhost',
    port: 8090,
  });

  socket.messageStream.subscribe(message => {
    console.log('message from server: ', message);
  });

  socket.sendMessage('this message is from the client');
}

main();

