import * as Udp from 'dgram';
import * as Dns from 'dns';
import { Observable, Observer, Subject } from 'rxjs';
import * as uuid from 'uuid/v4';
import {range} from 'lodash';
const server = Udp.createSocket('udp4');
import TaskQueue, {DeferredPromise} from './task-queue';

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
  segmentSizeInBytes: number,
  windowSize: number,
  segmentTimeout: number,
}


class ClientConnection implements ReliableUdpSocket {
  info: Udp.AddressInfo;
  messageChannelOptions: MessageChannelOptions;

  messageQueue: TaskQueue<void>;

  constructor(messageChannelOptions: MessageChannelOptions) {
    this.info = messageChannelOptions.clientInfo;
    this.messageChannelOptions = messageChannelOptions;
    this.messageQueue = new TaskQueue<void>();
  }

  sendMessage(message: string | Buffer) {
    const promise = this.messageQueue.add(() =>
      sendMessageWithWindow(message, this.messageChannelOptions)
    );
    this.messageQueue.execute();
    return promise;
  }

  get messageStream() {
    return undefined as any as Observable<Buffer>;
  }
}

function sendMessageWithWindow(message: string | Buffer, options: MessageChannelOptions) {
  const {
    sendSegment: _sendSegment,
    segmentStream: _segmentStream,
    windowSize,
    clientInfo,
    segmentSizeInBytes,
    segmentTimeout,
  } = options;
  const id = uuid();
  
  const segmentStream = _segmentStream.filter(segment => segment.messageId === id);

  const buffer = /*if*/ typeof message === 'string' ? Buffer.from(message) : message;
  const totalSegments = Math.ceil(buffer.byteLength / segmentSizeInBytes);

  const segments = (range(totalSegments)
    .map(i => i * segmentSizeInBytes)
    .map(seqAck => ({
      seqAck,
      data: buffer.slice(seqAck, seqAck + segmentSizeInBytes),
    }))
    .map(({seqAck, data}) => ({
      data,
      seqAck,
      messageId: id,
    }) as Segment)
  );

  function sendSegment(segment: Segment) {
    return new Promise<number>(async (resolve, reject) => {
      let gotAck = false;

      // resolve promise on ack
      (segmentStream
        .filter(segmentIn => segmentIn.seqAck > segment.seqAck)
        .take(1)
        .toPromise()
        .then(segmentIn => {
          gotAck = true;
          resolve(segmentIn.seqAck);
        })
      );

      // reject on timeout
      setTimeout(() => {
        if (!gotAck) {
          reject(new Error('timeout occurred'));
        }
      }, segmentTimeout);

      await _sendSegment(segment);
    });
  }

  let lastSegmentSent = 0;
  let greatestAck = 0;

  const finished = new DeferredPromise<void>();

  async function send(segment: Segment | undefined) {
    if (!segment) {
      if (greatestAck > buffer.byteLength) {
        finished.resolve();
      }
      return;
    }
    try {
      if (segment.seqAck > lastSegmentSent) {
        lastSegmentSent = segment.seqAck;
      }
      const ack = await sendSegment(segment);
      if (ack > greatestAck) {
        greatestAck = ack;
      }
      const nextSegment = segments[Math.floor(lastSegmentSent / segmentSizeInBytes) + 1];
      send(nextSegment);
    } catch {
      // re-send segment that timed out
      send(segment);
    }
  }

  // bootstrap the sending
  segments.slice(0, windowSize).forEach(send);

  return finished;
}