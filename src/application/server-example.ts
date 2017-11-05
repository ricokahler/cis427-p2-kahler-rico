import { createReliableUdpServer } from '../rudp';

const rudpServer = createReliableUdpServer({
  port: 8090,
  maxSegmentSizeInBytes: 4,
  segmentTimeout: 2000,
  socketType: 'udp4',
  windowSize: 5
});

rudpServer.connectionStream.subscribe(async connection => {
  console.log('client connected! ', connection.info);

  connection.messageStream.subscribe(message => {
    console.log('from client: ', message.toString());
  })
  await connection.sendMessage('The quick brown fox jumps over the lazy dog.');
});

