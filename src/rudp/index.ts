import * as Udp from 'dgram';
import * as Dns from 'dns';
import { Observable, Observer, Subject } from 'rxjs';
import * as uuid from 'uuid/v4';
import { range } from 'lodash';
const server = Udp.createSocket('udp4');
import TaskQueue, { DeferredPromise } from './task-queue';
const defaultSegmentSize = 4;
let a = 0;

export interface ReliableUdpSocket {
  info: Udp.AddressInfo,
  messageStream: Observable<Buffer>,
  sendMessage: (message: string | Buffer) => Promise<void>,
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve, reject) => {
    setTimeout(() => { resolve() }, milliseconds);
  })
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
  segmentTimeout: number,
}

export interface Segment {
  messageId: string,
  seqAck: number,
  data?: Buffer,
  last?: boolean,
  handshake?: 'syn' | 'syn-ack' | 'ack'
}

interface BufferWithInfo {
  message: Buffer,
  info: Udp.AddressInfo
}

/**
 * creates an identifer string by concatenating information in the `info`
 * @param info 
 */
function createSocketId(info: Udp.AddressInfo) {
  return info.address + '__' + info.family + '__' + info.port;
}

export function segmentToString(segment: Segment) {
  const { data, ...restOfSegment } = segment;
  const dataBase64 = data && data.toString('base64');
  const obj = { ...restOfSegment, dataBase64 }
  return JSON.stringify(obj);
}

export function stringToSegment(stringSegment: string) {
  const { dataBase64, ...restOfParsed } = JSON.parse(stringSegment) as {
    dataBase64: string | undefined;
    messageId: string;
    seqAck: number;
    last?: boolean | undefined;
    handshake?: "syn" | "syn-ack" | "ack" | undefined;
  };
  const data = dataBase64 !== undefined ? new Buffer(dataBase64, 'base64') : undefined;
  const newSegment = { ...restOfParsed } as Segment;
  if (data) {
    newSegment.data = data;
  }
  return newSegment;
}

export function createReliableUdpServer(rudpOptions: Partial<ReliableUdpServerOptions>) {
  const port = rudpOptions.port || 8090;
  const server = Udp.createSocket(rudpOptions.socketType || 'udp4');
  const maxSegmentSizeInBytes = rudpOptions.maxSegmentSizeInBytes || defaultSegmentSize;
  const windowSize = rudpOptions.windowSize || 5;
  const segmentTimeout = rudpOptions.segmentTimeout || 2000;

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

        function sendRawString(m: string) {
          return new Promise((resolve, reject) => {
            server.send(m, info.port, info.address, (error, bytes) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            })
          });
        }

        // connection established
        console.log('got ACK, connection established');

        connectionObserver.next(new ClientConnection({
          sendSegment: async (segment: Segment) => new Promise<void>(async (resolve, reject) => {
            const segmentAsString = segmentToString(segment);
            // await wait(3000);
            a += 1;
            if (a !== 2) {
              await sendRawString(segmentAsString);
            }
          }),
          segmentStream: segmentStreamOfOneClient.map(s => stringToSegment(s.message.toString())),
          clientInfo: info,
          segmentSizeInBytes: maxSegmentSizeInBytes,
          windowSize,
          segmentTimeout,
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
  segmentSizeInBytes: number,
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
  const segmentSizeInBytes = rudpOptions.segmentSizeInBytes || defaultSegmentSize;
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

  const rawSegmentStream = Observable.create((observer: Observer<BufferWithInfo>) => {
    client.addListener('message', (message, serverInfo) => {
      observer.next({ message, info: serverInfo });
    });
  }) as Observable<BufferWithInfo>;

  rawSegmentStream.subscribe(raw => console.log({ raw: raw.message.toString() }))

  // initiate the handshake
  console.log('sending SYNC...')
  await sendSegmentToServer('__HANDSHAKE__SYN');
  // wait for the SYN-ACK
  await rawSegmentStream.filter(({ message }) => message.toString() === '__HANDSHAKE__SYN-ACK').take(1).toPromise();
  console.log('got SYN-ACK. sending ACK...')
  // send the ACK
  await sendSegmentToServer('__HANDSHAKE__ACK');

  // connection established here
  const segmentStream = (rawSegmentStream
    .filter(({ info }) => info.address === address && info.port === port)
    .map(({ message }) => message.toString())
    .map(stringToSegment)
  );

  function sendSegment(segment: Segment) {
    return new Promise<void>((resolve, reject) => {
      const segmentAsString = segmentToString(segment);
      client.send(segmentAsString, port, address, (error, bytes) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      })
    });
  }

  const reliableUdpSocket: ReliableUdpSocket = {
    messageStream: createMessageStream(segmentStream, sendSegment, segmentSizeInBytes),
    sendMessage: async (message: string | Buffer) => { },
    info: client.address()
  }

  return reliableUdpSocket;
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
  messageStream: Observable<Buffer>;

  constructor(messageChannelOptions: MessageChannelOptions) {
    this.info = messageChannelOptions.clientInfo;
    this.messageChannelOptions = messageChannelOptions;
    this.messageQueue = new TaskQueue<void>();
    this.messageStream = new Subject<Buffer>();
    // this.messageStream = convertToMessageStream(
    //   messageChannelOptions.segmentStream,
    //   messageChannelOptions.sendSegment,
    //   messageChannelOptions.segmentSizeInBytes
    // );
  }

  sendMessage(message: string | Buffer) {
    const promise = this.messageQueue.add(() =>
      sendMessageWithWindow(message, this.messageChannelOptions)
    );
    this.messageQueue.execute();
    return promise;
  }
}

export function createMessageStream(
  segmentStream: Observable<Segment>,
  sendSegment: (segment: Segment) => Promise<void>,
  segmentSizeInBytes: number,
) {
  const messageStream: Observable<Buffer> = Observable.create((observer: Observer<Buffer>) => {
    (segmentStream
      .filter(value => value.messageId !== undefined)
      .groupBy(value => value.messageId)
      .subscribe(segmentsByMessage => {
        let receivedLast = false;
        const buffers = [] as (Segment | undefined)[];
        segmentsByMessage.subscribe(async segment => {
          buffers[Math.floor(segment.seqAck / segmentSizeInBytes)] = segment;
          const nextExpectedSequenceNumber = findNextSequenceNumber(buffers, segmentSizeInBytes);

          if (segment.last) {
            receivedLast = true;
          }
          const lastBuffer = buffers[buffers.length - 1];

          if (
            receivedLast
            && lastBuffer
            && nextExpectedSequenceNumber === lastBuffer.seqAck + segmentSizeInBytes
          ) {
            const combinedBuffer = Buffer.concat(buffers.filter(x => x).map(buffer => {
              if (!buffer) {
                throw new Error('should never happen');
              }
              return buffer.data || new Buffer('');
            }));
            observer.next(combinedBuffer);
          }

          // ack
          await sendSegment({
            messageId: segment.messageId,
            seqAck: nextExpectedSequenceNumber,
          });
        })
      })
    );
  });
  return messageStream as Observable<Buffer>;
}

export function findNextSequenceNumber(
  buffers: ({ seqAck: number } | undefined)[],
  segmentSizeInBytes: number
) {
  if (buffers.length === 0) {
    return segmentSizeInBytes;
  }
  let i = 0;
  for (let buffer of buffers) {
    if (!buffer) {
      return i * segmentSizeInBytes;
    }
    i += 1;
  }
  const lastBuffer = buffers[buffers.length - 1];
  if (!lastBuffer) {
    // should never happen
    throw new Error('last buffer was undefined');
  }
  return lastBuffer.seqAck + segmentSizeInBytes;
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

  segmentStream.subscribe(seg => {
    console.log({ seg })
  })

  const buffer = /*if*/ typeof message === 'string' ? Buffer.from(message) : message;
  const totalSegments = Math.ceil(buffer.byteLength / segmentSizeInBytes);

  const segments = (range(totalSegments)
    .map(i => i * segmentSizeInBytes)
    .map(seqAck => ({
      seqAck,
      data: buffer.slice(seqAck, seqAck + segmentSizeInBytes),
    }))
    .map(({ seqAck, data }) => ({
      data,
      seqAck,
      messageId: id,
      last: false,
    }) as Segment)
  );
  segments.push({
    messageId: id,
    data: new Buffer(''),
    seqAck: totalSegments * segmentSizeInBytes,
    last: true
  });

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
          console.log('===timeout occurred===')
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
        console.log('finished sending!')
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
      console.log(`failed to send segment: ${segment.seqAck}, retrying...`)
      send(segment);
    }
  }

  // bootstrap the sending
  segments.slice(0, windowSize).forEach(send);

  return finished;
}