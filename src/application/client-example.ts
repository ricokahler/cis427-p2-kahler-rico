import { connectToReliableUdpServer } from '../rudp';

async function main() {
  const socket = await connectToReliableUdpServer();

  socket.messageStream.subscribe(message => {
    console.log('message from server: ', message.toString());
  });

  socket.sendMessage('this message is from the client');
}

main();

