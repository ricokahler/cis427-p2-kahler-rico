import { createReliableUdpServer } from '../rudp';
import * as fs from 'fs';
import * as path from 'path';
import { oneLine } from 'common-tags';

const aliceTxt = fs.readFileSync(path.resolve(__dirname, './alice.txt'));

const rudpServer = createReliableUdpServer({
  segmentSizeInBytes: 100, // bytes of data per segment
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

rudpServer.bind(port => console.log(
  oneLine`Reliable UDP server running on port: ${port}.
  Run the command 'npm run client' in another terminal to start the download.`
));