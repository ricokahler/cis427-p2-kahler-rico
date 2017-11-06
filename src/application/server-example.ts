import { createReliableUdpServer } from '../rudp';

const rudpServer = createReliableUdpServer({ logger: console.log.bind(console) });

rudpServer.connectionStream.subscribe(async connection => {
  console.log('client connected! ', connection.info);

  connection.messageStream.subscribe(message => {
    console.log('from client: ', message.toString());
  })
  await connection.sendMessage('The quick brown fox jumps over the lazy dog.');
  await connection.sendMessage('message two');
});

rudpServer.bind(port => console.log(`Reliable UDP server running on port: ${port}`));