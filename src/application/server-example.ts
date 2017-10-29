import { createReliableUdpServer } from '../rudp';

const rudpServer = createReliableUdpServer({
  port: 8090,
});

rudpServer.connectionStream.subscribe(async connection => {
  console.log('client connected! ', connection.info);

  connection.messageStream.subscribe(message => {
    console.log('from client: ', message.toString());
  })
  await connection.sendMessage('test message');
});

