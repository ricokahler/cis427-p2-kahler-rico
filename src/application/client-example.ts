import { connectToReliableUdpServer } from '../rudp';

async function main() {
  try {
    const socket = await connectToReliableUdpServer({
      logger: console.log.bind(console),
      segmentSizeInBytes: 100, // 1kB
    });

    console.log('Connected to server! Downloading all of alice.txt...');
    const aliceTxt = await socket.messageStream.take(1).toPromise();

    console.log(aliceTxt.toString());

    socket.messageStream.subscribe(message => {
      console.log('MESSAGE FROM SERVER: ', message.toString());
    });

    socket.sendMessage('Hello server!'); // can send messages bi-directionally
  } catch (e) {
    console.error('======');
    console.error('ERROR: Could not connect to server. Ensure that it is running first.');
    console.error('======');
    console.error(e);
    process.exit(1);
  }

  // socket.sendMessage('this message is from the client');
}

main();

