import * as Udp from 'dgram';
import * as Dns from 'dns';
import { Observable, Observer, Subject } from 'rxjs';
import * as uuid from 'uuid/v4';
import {range} from 'lodash';
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
        // connectionObserver.next(new ClientConnection({
        //   sendSegment: (segment: string | Buffer) => new Promise<number>((resolve, reject) => {
        //     server.send(segment, info.port, info.address, (error, bytes) => {
        //       if (error) {
        //         reject(error);
        //       } else {
        //         resolve(bytes);
        //       }
        //     });
        //   }),
        //   info,
        //   maxSegmentSizeInBytes,
        //   windowSize,
        // }));
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
  messageId: string,
  seqAck: number,
  data: Buffer,
}

interface MessageChannelOptions {
  sendSegment: (segment: Segment) => Promise<void>,
  segmentStream: Observable<Segment>,
  clientInfo: Udp.AddressInfo,
  maxSegmentSizeInBytes: number,
  windowSize: number,
  segmentTimeout: number,
}

interface QueueItem<T> {
  task: () => Promise<T>,
  deferredPromise: DeferredPromise<T>
}

class AsyncQueue<Value> {
  protected _queue: (QueueItem<Value> | undefined)[];
  protected _queueIsRunning: boolean;

  constructor() {
    this._queue = [];
    this._queueIsRunning = false;
  }

  async executeQueue() {
    if (this._queueIsRunning) {
      return;
    }
    const top = this._queue[0];
    if (!top) {
      this._queueIsRunning = false;
      return;
    }
    const {task, deferredPromise} = top;
    try {
      const value = await task();
      deferredPromise.resolve(value);
    } catch (e) {
      deferredPromise.reject(e);
    }
    this.executeQueue();
  }

  addTask(task: () => Promise<Value>) {
    const deferredPromise = new DeferredPromise<Value>();
    this._queue.push({
      task,
      deferredPromise
    });
    this.executeQueue();
    return deferredPromise as Promise<Value>;
  }

}

class ClientConnection implements ReliableUdpSocket {
  info: Udp.AddressInfo;
  messageChannelOptions: MessageChannelOptions;

  messageQueue: ({message: (string | Buffer), deferredPromise: DeferredPromise<void>})[];
  queueIsRunning: boolean;

  constructor(messageChannelOptions: MessageChannelOptions) {
    this.info = messageChannelOptions.clientInfo;
    this.messageChannelOptions = messageChannelOptions;
  }

  async executeQueue() {
    if (this.queueIsRunning) {
      return;
    }
    const firstMessage = this.messageQueue[0];
    if (!firstMessage) {
      this.queueIsRunning = false;
      return;
    }
    
    try {
      await MessageChannel.send(firstMessage.message, this.messageChannelOptions);
      firstMessage.deferredPromise.resolve();
    } catch (e) {
      firstMessage.deferredPromise.reject(e);
    }

    // continue to executeQueue
    this.executeQueue();
  }

  sendMessage(message: string | Buffer) {
    const deferredPromise = new DeferredPromise<void>();
    this.messageQueue.push({message, deferredPromise});
    this.executeQueue();
    return deferredPromise;
  }

  get messageStream() {
    return undefined as any as Observable<Buffer>;
  }
}

class MessageChannel {
  segmentQueue: Segment[];


  constructor(options: MessageChannelOptions) {
    this.segmentQueue = [];
  }

  
}

function sendMessageWithWindow(message: string | Buffer, options: MessageChannelOptions) {
  const {
    sendSegment,
    segmentStream: rawSegmentStream,
    windowSize,
    clientInfo,
    maxSegmentSizeInBytes,
    segmentTimeout,
  } = options;
  const id = uuid();
  
  const segmentStreamForThisMessage = rawSegmentStream.filter(segment => segment.messageId === id);

  const buffer = /*if*/ typeof message === 'string' ? Buffer.from(message) : message;
  const totalSegments = Math.ceil(buffer.byteLength / maxSegmentSizeInBytes);

  const segments = (range(totalSegments)
    .map(i => i * maxSegmentSizeInBytes)
    .map(seqAck => ({
      seqAck,
      data: buffer.slice(seqAck, seqAck + maxSegmentSizeInBytes),
    }))
    .map(({seqAck, data}) => ({
      data,
      seqAck,
      messageId: id,
    }) as Segment)
  );

  

  const window = segments.slice(0, windowSize).map(segment => {
    const segmentPromise = new Promise<void>(async (resolve, reject) => {
      let gotAck = false;

      (segmentStreamForThisMessage
        .filter(s => s.seqAck >= segment.seqAck)
        .take(1)
        .toPromise()
        .then(() => {
          gotAck = true;
          resolve();
        })
      );

      setTimeout(() => {
        if (!gotAck) {
          reject('timeout occurred');
        }
      }, segmentTimeout);

      await sendSegment(segment);
    });

    return {segment, segmentPromise};
  }).map(async ({segment, segmentPromise}) => {
    try {
      // wait for the ACK
      await segmentPromise;
      // send the next 
    } catch {
      // resend the segment on timeout
      await sendSegment(segment);
    }
  });
}