import * as Udp from 'dgram';
const server = Udp.createSocket('udp4');
import { Observable, Observer } from 'rxjs';

export interface ReliableUdpSocket {
  messageStream: Observable<string>,
  sendMessage: (message: string) => Promise<void>,
}

export interface ReliableUdpServer {
  connectionStream: Observable<ReliableUdpSocket>,
  close(): void
}

export interface ReliableUdpServerOptions {
  /** the port of the server. defaults to `8090` */
  port: number,
  maxSegmentSize: number,
  windowSize: number,
  socketType: Udp.SocketType,
}

interface Message {
  message: string,
  clientInfo: Udp.AddressInfo
}

type ConnectionState = undefined | 'initiated' | 'pending' | 'connected';

/**
 * creates an identifer string by concatenating information in the `clientInfo`
 * @param clientInfo 
 */
function createSocketId(clientInfo: Udp.AddressInfo) {
  return clientInfo.address + '__' + clientInfo.family + '__' + clientInfo.port;
}

export function createReliableUdpServer(rudpOptions: Partial<ReliableUdpServerOptions>) {
  const port = rudpOptions.port || 8090;
  const server = Udp.createSocket(rudpOptions.socketType || 'udp4');
  const connections = {} as { [socketId: string]: ConnectionState };

  function sendTo(clientInfo: Udp.AddressInfo, message) {
    return new Promise<number>((resolve, reject) => {
      server.send(message, clientInfo.port, clientInfo.address, (error, bytes) => {
        if (error) {
          reject(error);
        } else {
          resolve(bytes);
        }
      });
    });
  }

  server.on('listening', () => {
    console.log(`Reliable UDP Server running on port ${port}.`)
  });

  const messageStream = Observable.create((observer: Observer<Message>) => {
    server.on('message', (message, clientInfo) => observer.next({
      message: message.toString(),
      clientInfo
    }));
  }) as Observable<Message>;

  const handshakeStream = messageStream.filter(({ message }) => message.startsWith('__HANDSHAKE__'));
  handshakeStream.subscribe(async ({ clientInfo, message }) => {
    const socketId = createSocketId(clientInfo)
    if (connections[socketId] === undefined) {
      await sendTo(clientInfo, '__HANDSHAKE__SYN-ACK');
      connections[socketId] = 'pending';
    } else if (connections[socketId] === 'pending') {
      await sendTo(clientInfo, '__HANDSHAKE__ACK');
      connections[socketId] = 'connected';
    }
  });


}

export interface ReliableUdpClientOptions {
  host: string,
  port: number,
}

export function connectToReliableUdpServer(rudpOptions: ReliableUdpClientOptions) {

}
