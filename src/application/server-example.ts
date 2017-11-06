import { createReliableUdpServer } from '../rudp';

const rudpServer = createReliableUdpServer();

rudpServer.connectionStream.subscribe(async connection => {
  console.log('client connected! ', connection.info);

  connection.messageStream.subscribe(message => {
    console.log('from client: ', message.toString());
  })
  await connection.sendMessage('The quick brown fox jumps over the lazy dog.');
  await connection.sendMessage('message two');
});

