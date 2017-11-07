import { createReliableUdpServer } from '../rudp';
import * as fs from 'fs';
import * as path from 'path';

const aliceTxt = fs.readFileSync(path.resolve(__dirname, './alice.txt'));

const rudpServer = createReliableUdpServer({
  segmentSizeInBytes: 100, // 1kB for segment size
  logger: console.log.bind(console),
});

rudpServer.connectionStream.subscribe(async connection => {
  console.log('Client connected! ', connection.info);

  connection.messageStream.subscribe(message => {
    console.log('MESSAGE FROM CLIENT: ', message.toString());
  })

  console.log('Sending alice.txt...');
  await connection.sendMessage(aliceTxt);
});

rudpServer.bind(port => console.log(`Reliable UDP server running on port: ${port}`));