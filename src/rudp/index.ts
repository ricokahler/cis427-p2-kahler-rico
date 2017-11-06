import * as Udp from 'dgram';
import * as Dns from 'dns';
import { Observable, Observer, Subject } from 'rxjs';
import * as uuid from 'uuid/v4';
import { range } from 'lodash';
import TaskQueue, { DeferredPromise } from './task-queue';

const DEFAULT_SEGMENT_SIZE = 4;
const DEFAULT_SEGMENT_TIMEOUT = 10000;
const DEFAULT_PORT = 8090;
const DEFAULT_HOST = 'localhost';
const DEFAULT_WINDOW_SIZE = 5;

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
  port: number,
  maxSegmentSizeInBytes: number,
  windowSize: number,
  segmentTimeout: number,
}

export interface ReliableUdpClientOptions {
  hostname: string,
  port: number,
  segmentSizeInBytes: number,
  windowSize: number,
  segmentTimeout: number,
}

export interface WindowOptions {
  sendSegment: (segment: Segment) => Promise<void>,
  segmentStream: Observable<Segment>,
  segmentSizeInBytes: number,
  windowSize: number,
  segmentTimeout: number,
}

export interface MessageStreamOptions {
  sendSegment: (segment: Segment) => Promise<void>,
  segmentStream: Observable<Segment>,
  segmentSizeInBytes: number,
}

export interface Segment {
  messageId: string,
  seqAck: number,
  data?: Buffer,
  last?: boolean,
  handshake?: 'SYN' | 'SYN-ACK' | 'ACK'
}

export interface BufferWithInfo {
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
  if (!segment) {
    throw new Error (`Could not convert segment to string because it was ${segment}`)
  }
  const { data, ...restOfSegment } = segment;
  const dataBase64 = data && data.toString('base64');
  const obj = { ...restOfSegment, dataBase64 }
  return JSON.stringify(obj);
}

export function stringToSegment(stringSegment: string) {
  if (!stringSegment) {
    throw new Error(`Could not convert string to segment because string was ${stringSegment}`);
  }
  const { dataBase64, ...restOfParsed } = JSON.parse(stringSegment) as {
    dataBase64: string | undefined;
    messageId: string;
    seqAck: number;
    last?: boolean | undefined;
    handshake?: 'SYN' | 'SYN-ACK' | 'ACK';
  };
  const data = dataBase64 !== undefined ? new Buffer(dataBase64, 'base64') : undefined;
  const newSegment = { ...restOfParsed } as Segment;
  if (data) {
    newSegment.data = data;
  }
  return newSegment;
}

function wait(milliseconds: number) {
  return new Promise(resolve => setTimeout(() => resolve(), milliseconds));
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

export function createReliableUdpServer(rudpOptions?: Partial<ReliableUdpServerOptions>) {
  rudpOptions = rudpOptions || {};
  const port = rudpOptions.port || DEFAULT_PORT;
  const server = Udp.createSocket('udp4');
  const maxSegmentSizeInBytes = rudpOptions.maxSegmentSizeInBytes || DEFAULT_SEGMENT_SIZE;
  const windowSize = rudpOptions.windowSize || DEFAULT_WINDOW_SIZE;
  const segmentTimeout = rudpOptions.segmentTimeout || DEFAULT_SEGMENT_TIMEOUT;

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

  const rawSegmentStream = Observable.create((observer: Observer<BufferWithInfo>) => {
    server.on('message', (message, info) => observer.next({ message, info }));
  }) as Observable<BufferWithInfo>;

  // rawSegmentStream.subscribe(({ message }) => {
  //   console.log('RAW MESSAGE:', message.toString());
  // })

  const connectionStream = Observable.create((connectionObserver: Observer<ReliableUdpSocket>) => {
    // group each segment by their socket info
    const segmentsGroupedByClient = rawSegmentStream.groupBy(({ info }) => createSocketId(info));
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

        function sendRawSegment(m: string) {
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

        connectionObserver.next(createConnectionToClient({
          sendSegment: async (segment: Segment) => new Promise<void>(async (resolve, reject) => {
            const segmentAsString = segmentToString(segment);
            // await wait(5000);
            await sendRawSegment(segmentAsString);
          }),
          segmentStream: segmentStreamOfOneClient.map(s => stringToSegment(s.message.toString())),
          segmentSizeInBytes: maxSegmentSizeInBytes,
          windowSize,
          segmentTimeout,
        }, info));
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

export async function connectToReliableUdpServer(rudpOptions?: Partial<ReliableUdpClientOptions>) {
  const client = Udp.createSocket('udp4');
  rudpOptions = rudpOptions || {};
  const address = (await resolveName(rudpOptions.hostname || DEFAULT_HOST))[0];
  const port = rudpOptions.port || DEFAULT_PORT;
  const segmentSizeInBytes = rudpOptions.segmentSizeInBytes || DEFAULT_SEGMENT_SIZE;
  const windowSize = rudpOptions.windowSize || DEFAULT_WINDOW_SIZE;
  const segmentTimeout = rudpOptions.segmentTimeout || DEFAULT_SEGMENT_TIMEOUT

  if (!address) {
    throw new Error(`Could not resolve hostname: "${rudpOptions.hostname}"`)
  }

  function sendRawSegmentToServer(message: Buffer | string) {
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

  // rawSegmentStream.subscribe(rawSegment => console.log('RAW MESSAGE: ', rawSegment.message.toString()));

  // initiate the handshake
  console.log('sending SYNC...')
  await sendRawSegmentToServer('__HANDSHAKE__SYN');
  // wait for the SYN-ACK
  await rawSegmentStream.filter(({ message }) => message.toString() === '__HANDSHAKE__SYN-ACK').take(1).toPromise();
  console.log('got SYN-ACK. sending ACK...')
  // send the ACK
  await sendRawSegmentToServer('__HANDSHAKE__ACK');

  // connection established here
  const segmentStream = (rawSegmentStream
    .filter(({ info }) => info.address === address && info.port === port)
    .map(({ message }) => message.toString())
    .map(stringToSegment)
  );

  function sendSegment(segment: Segment) {
    return new Promise<void>((resolve, reject) => {
      if (!segment) {
        throw new Error (`Could not send segment because because it was ${segment}`);
      }
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
    messageStream: createMessageStream({ segmentStream, sendSegment, segmentSizeInBytes }),
    sendMessage: (message: string | Buffer) => sendMessageWithWindow(message, {
      segmentSizeInBytes,
      segmentStream,
      sendSegment,
      segmentTimeout,
      windowSize,
    }),
    info: { address, family: 'IPv4', port }
  }

  return reliableUdpSocket;
}

export function createConnectionToClient(options: WindowOptions, info: Udp.AddressInfo) {

  function sendMessage(message: string | Buffer) {
    return sendMessageWithWindow(message, options);
  }

  const socket: ReliableUdpSocket = {
    info,
    messageStream: Observable.never(),//createMessageStream(options),
    sendMessage
  };

  return socket;
}

export function createMessageStream(options: MessageStreamOptions) {
  const { segmentSizeInBytes, segmentStream, sendSegment } = options;
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
                throw new Error(`Could not concatenate buffer because it was ${buffer}.`);
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

export function sendMessageWithWindow(message: string | Buffer, options: WindowOptions) {
  const {
    sendSegment,
    segmentStream,
    windowSize,
    segmentSizeInBytes,
    segmentTimeout,
  } = options;
  const id = uuid();

  const segmentStreamForThisMessage = segmentStream.filter(segment => segment.messageId === id);

  const ackCounts = [] as number[];

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
    }) as Segment)
  );
  segments.push({
    messageId: id,
    seqAck: totalSegments * segmentSizeInBytes,
    last: true
  });

  // console.log('SEGMENTS TO SEND', segments);

  // fast re-transmit
  segmentStreamForThisMessage.subscribe(async segment => {
    ackCounts[segment.seqAck] = (/*if*/ ackCounts[segment.seqAck] === undefined
      ? 1
      : ackCounts[segment.seqAck] + 1
    );

    if (ackCounts[segment.seqAck] >= 3) {
      const segmentToRetransmit = segments[Math.floor(segment.seqAck / segmentSizeInBytes)];
      // throw new Error()
      if (segmentToRetransmit) {
        await sendSegment(segmentToRetransmit);
      }
    }
  });

  function sendSegmentAndGetAck(segment: Segment) {
    return new Promise<number>(async (resolve, reject) => {
      let gotAck = false;

      // resolve promise on ack
      (segmentStreamForThisMessage
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

      await sendSegment(segment);
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
      const ack = await sendSegmentAndGetAck(segment);
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