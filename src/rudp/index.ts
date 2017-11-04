import * as Udp from 'dgram';
import * as Dns from 'dns';
import { Observable, Observer, Subject } from 'rxjs';
const server = Udp.createSocket('udp4');

export interface ReliableUdpSocket {
  info: Udp.AddressInfo,
  messageStream: Observable<Buffer>,
  sendMessage: (message: string | Buffer) => Promise<void>,
}

export interface ReliableUdpServer {
  connectionStream: Observable<ReliableUdpSocket>,
  close(): void
}

export interface ReliableUdpServerOptions {
  /** the port of the server. defaults to `8090` */
  port: number,
  maxSegmentSizeInBytes: number,
  windowSize: number,
  socketType: Udp.SocketType,
}

interface BufferWithInfo {
  message: Buffer,
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
  const maxSegmentSizeInBytes = rudpOptions.maxSegmentSizeInBytes || 1000;
  const windowSize = rudpOptions.windowSize || 5;

  function sendSegmentTo(info: Udp.AddressInfo, message: string) {
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

  const segmentStream = Observable.create((observer: Observer<BufferWithInfo>) => {
    server.on('message', (message, info) => observer.next({ message, info }));
  }) as Observable<BufferWithInfo>;

  const connectionStream = Observable.create((connectionObserver: Observer<ReliableUdpSocket>) => {
    // group each segment by their socket info
    const segmentsGroupedByClient = segmentStream.groupBy(({ info }) => createSocketId(info));
    segmentsGroupedByClient.subscribe(segmentStreamOfOneClient => {
      // a stream of segments that are the message of `__HANDSHAKE__SYN`
      const synStream = segmentStreamOfOneClient.filter(({ message }) =>
        message.toString() === '__HANDSHAKE__SYN'
      );
      synStream.subscribe(async ({ message, info }) => {
        console.log('got SYN, sending SYN-ACK...');
        await sendSegmentTo(info, '__HANDSHAKE__SYN-ACK');
      });

      // a stream of message that are `__HANDSHAKE__ACK`
      const ackStream = segmentStreamOfOneClient.filter(({ message }) =>
        message.toString() === '__HANDSHAKE__ACK'
      );
      // when the `__HANDSHAKE__ACK` message comes, we can push a new connection.
      ackStream.subscribe(async ({ message, info }) => {
        // connection established
        console.log('got ACK, connection established');
        connectionObserver.next(new ClientConnection({
          sendSegment: (segment: string | Buffer) => new Promise<number>((resolve, reject) => {
            server.send(segment, info.port, info.address, (error, bytes) => {
              if (error) {
                reject(error);
              } else {
                resolve(bytes);
              }
            });
          }),
          info,
          maxSegmentSizeInBytes,
          windowSize,
        }));
      });
    });
  });


  const reliableUdpServer: ReliableUdpServer = {
    connectionStream,
    close: () => server.close(),
  };

  server.bind(port); // start server

  return reliableUdpServer;
}

export interface ReliableUdpClientOptions {
  hostname: string,
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
  const address = (await resolveName(rudpOptions.hostname || 'localhost'))[0];
  const port = rudpOptions.port || 8090;
  if (!address) {
    throw new Error(`Could not resolve hostname: "${rudpOptions.hostname}"`)
  }

  function sendSegmentToServer(message: Buffer | string) {
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

  const segmentStream = Observable.create((observer: Observer<BufferWithInfo>) => {
    client.addListener('message', (message, serverInfo) => {
      observer.next({ message, info: serverInfo });
    });
  }) as Observable<BufferWithInfo>;

  // initiate the handshake
  console.log('sending SYNC...')
  await sendSegmentToServer('__HANDSHAKE__SYN');
  // wait for the SYN-ACK
  await segmentStream.filter(({ message }) => message.toString() === '__HANDSHAKE__SYN-ACK').take(1).toPromise();
  console.log('got SYN-ACK. sending ACK...')
  // send the ACK
  await sendSegmentToServer('__HANDSHAKE__ACK');

  // connection established here
  const messageStream = (segmentStream
    .filter(({ info }) => info.address === address && info.port === port)
    .map(({ message }) => message)
  );

  const reliableUdpSocket: ReliableUdpSocket = {
    messageStream,
    sendMessage: async (message: Buffer) => { await sendSegmentToServer(message); },
    info: client.address()
  }

  return reliableUdpSocket;
}

interface Segment {
  seqAck: number,
  data: Buffer,
}

/**
 * 
 * @param sendMessage 
 * @param options 
 */
async function sendMessageWithWindow(sendSegment: (message: string) => Promise<number>, options: {
  windowSize: number,
  maxSegmentSizeInBytes: number,
}) {
  const { windowSize, maxSegmentSizeInBytes } = options;
  let usableWindow = windowSize;

  return function sendMessage(fullMessage: string) {
    const messageLength = Buffer.byteLength(fullMessage);
    const totalSegments = Math.ceil(messageLength / maxSegmentSizeInBytes);

    const buffer = new Buffer(fullMessage);

    (Observable
      .range(0, windowSize)
      .map(index => index * maxSegmentSizeInBytes)
      .map(seqNumber => buffer.slice(seqNumber, seqNumber + maxSegmentSizeInBytes))
    );
  }
}

class DeferredPromise<T> implements Promise<T> {
  private _promise: Promise<T>
  resolve: (t?: T) => void;
  reject: (error?: any) => void;
  then: <TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ) => Promise<TResult1 | TResult2>;
  catch: <TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null
  ) => Promise<T | TResult>;

  constructor() {
    this._promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    this.then = this._promise.then.bind(this._promise);
    this.catch = this._promise.catch.bind(this._promise);
  }

  [Symbol.toStringTag] = 'Promise' as 'Promise';
}

interface ClientConnectionOptions {
  sendSegment: (segment: Buffer) => Promise<number>,
  segmentStream: Observable<string>,
  clientInfo: Udp.AddressInfo,
  maxSegmentSizeInBytes: number,
  windowSize: number,
}

class ClientConnection implements ReliableUdpSocket {
  info: Udp.AddressInfo;

  sendSegment: (segment: Buffer) => Promise<number>;
  segmentStream: Observable<string>;

  messageQueue: ({message: (string | Buffer), resolve: () => void} | undefined)[];
  queueIsRunning: boolean;

  constructor(options: ClientConnectionOptions) {
    this.info = options.clientInfo;
    this.sendSegment = options.sendSegment;
    this.segmentStream = options.segmentStream;
    this.messageQueue = [];
    this.queueIsRunning = false;
  }

  executeQueue() {
    const firstMessage = this.messageQueue[0];
    if (!firstMessage) {
      return;
    }
    if (this.queueIsRunning) {
      return;
    }
    
  }

  sendMessage(message: string | Buffer) {
    const deferred = new DeferredPromise<void>();
    this.messageQueue.push({message, resolve: deferred.resolve});
    if (!this.queueIsRunning) {
      this.executeQueue();
    }
    return deferred;
  }

  get messageStream() {
    return undefined as any as Observable<Buffer>;
  }
}



class MessageChannel {
  constructor() {

  }
}