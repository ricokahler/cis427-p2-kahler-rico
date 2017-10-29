import * as Udp from 'dgram';
import * as Dns from 'dns';
import { Observable, Observer } from 'rxjs';
const server = Udp.createSocket('udp4');

export interface ReliableUdpSocket {
  info: Udp.AddressInfo,
  messageStream: Observable<string>,
  sendMessage: (message: string) => Promise<number>,
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

interface MessageWithInfo {
  message: string,
  info: Udp.AddressInfo
}

type ConnectionState = undefined | 'initiated' | 'pending' | 'connected';

/**
 * creates an identifer string by concatenating information in the `info`
 * @param info 
 */
function createSocketId(info: Udp.AddressInfo) {
  return info.address + '__' + info.family + '__' + info.port;
}

export function createReliableUdpServer(rudpOptions: Partial<ReliableUdpServerOptions>) {
  const port = rudpOptions.port || 8090;
  const server = Udp.createSocket(rudpOptions.socketType || 'udp4');

  function sendTo(info: Udp.AddressInfo, message: string) {
    return new Promise<number>((resolve, reject) => {
      server.send(message, info.port, info.address, (error, bytes) => {
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

  const messageStream = Observable.create((observer: Observer<MessageWithInfo>) => {
    server.on('message', (message, info) => observer.next({
      message: message.toString(),
      info
    }));
  }) as Observable<MessageWithInfo>;

  const connectionStream = Observable.create((connectionObserver: Observer<ReliableUdpSocket>) => {
    // handle connections
    (messageStream
      .groupBy(({ info }) => createSocketId(info))
      .subscribe(messageStreamOfOneClient => {

        (messageStreamOfOneClient
          .filter(({ message }) => message === '__HANDSHAKE__SYN')
          .subscribe(async ({ message, info }) => {
            console.log('got SYN, sending SYN-ACK...');
            await sendTo(info, '__HANDSHAKE__SYN-ACK');
          })
        );

        (messageStreamOfOneClient
          .filter(({ message }) => message === '__HANDSHAKE__ACK')
          .subscribe(async ({ message, info }) => {
            console.log('got ACK, connection established');
            // connection established
            const newConnection = {
              info,
              messageStream: messageStreamOfOneClient.map(({ message }) => message),
              sendMessage: (message: string) => {
                return new Promise<number>((resolve, reject) => {
                  server.send(message, info.port, info.address, (error, bytes) => {
                    if (error) {
                      reject(error);
                    } else {
                      resolve(bytes);
                    }
                  })
                });
              }
            };
            connectionObserver.next(newConnection);
          })
        );
      })
    );
  });


  const reliableUdpServer: ReliableUdpServer = {
    connectionStream,
    close: () => server.close(),
  };

  server.bind(port); // start server

  return reliableUdpServer;
}

export interface ReliableUdpClientOptions {
  host: string,
  port: number,
}

function resolveName(hostname: string) {
  return new Promise<string[]>((resolve, reject) => {
    Dns.resolve4(hostname, (error, addresses) => {
      if (error) {
        reject(error);
      } else {
        resolve(addresses);
      }
    });
  })
}

export async function connectToReliableUdpServer(rudpOptions: Partial<ReliableUdpClientOptions>) {
  const client = Udp.createSocket('udp4');
  const address = (await resolveName(rudpOptions.host || 'localhost'))[0];
  const port = rudpOptions.port || 8090;
  if (!address) {
    throw new Error(`Could not resolve hostname: "${rudpOptions.host}"`)
  }

  function sendToServer(message: string) {
    return new Promise<number>((resolve, reject) => {
      client.send(message, port, address, (error, bytes) => {
        if (error) {
          reject(error);
        } else {
          resolve(bytes);
        }
      });
    });
  }

  const rawMessageStream = Observable.create((observer: Observer<MessageWithInfo>) => {
    client.addListener('message', (message, serverInfo) => {
      observer.next({ message: message.toString(), info: serverInfo });
    });
  }) as Observable<MessageWithInfo>;

  // initiate the handshake
  console.log('sending SYNC...')
  await sendToServer('__HANDSHAKE__SYN');
  // wait for the SYN-ACK
  await rawMessageStream.filter(({ message }) => message === '__HANDSHAKE__SYN-ACK').take(1).toPromise();
  console.log('got SYN-ACK. sending ACK...')
  // send the ACK
  await sendToServer('__HANDSHAKE__ACK');

  // connection established here
  const messageStream = (rawMessageStream
    .do(({ info }) => console.log({ info }))
    .filter(({ info }) => info.address === address && info.port === rudpOptions.port)
    .map(({ message }) => message)
  );

  const reliableUdpSocket: ReliableUdpSocket = {
    messageStream,
    sendMessage: sendToServer,
    info: client.address()
  }

  return reliableUdpSocket;
}
