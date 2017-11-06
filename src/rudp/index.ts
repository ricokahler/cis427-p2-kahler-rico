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

export interface SenderOptions {
  sendDataSegment: (segment: DataSegment) => Promise<void>,
  ackSegmentStream: Observable<AckSegment>,
  segmentSizeInBytes: number,
  windowSize: number,
  segmentTimeout: number,
}

export interface ReceiverOptions {
  sendAckSegment: (segment: AckSegment) => Promise<void>,
  dataSegmentStream: Observable<DataSegment>,
  segmentSizeInBytes: number,
}

export interface HandshakeSegment {
  handshake: 'syn' | 'syn-ack' | 'ack',
}

export interface AckSegment {
  messageId: string,
  ack: number,
}

export interface DataSegment {
  messageId: string,
  seq: number,
  data: Buffer,
  last?: true,
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

/**
 * converts a data segment to a JSON friendly format by encoding the buffer to base64
 * @param dataSegment 
 */
function dataSegmentToJsonable(dataSegment: DataSegment) {
  const { data, ...restOfSegment } = dataSegment;
  const dataBase64 = data.toString('base64');
  return { ...restOfSegment, dataBase64 };
}
// for dynamic typings
const _DataSegmentJsonable = false ? dataSegmentToJsonable({} as DataSegment) : undefined;
type DataSegmentJsonable = typeof _DataSegmentJsonable;

/**
 * Converts `DataSegment`s to strings to send over the wire.
 * Converts Buffers to base64 and serializes the whole thing to JSON
 * @param dataSegment segment to be converted
 */
export function serializeDataSegment(dataSegment: DataSegment) {
  return JSON.stringify(dataSegmentToJsonable(dataSegment));
}

/**
 * Parses data segments converted with `serializeDataSegment` back to segments
 * @param dataSegmentString the data segment string to parse
 */
export function parseDataSegment(dataSegmentString: string) {
  const dataSegmentJson = JSON.parse(dataSegmentString) as DataSegmentJsonable;
  if (!dataSegmentJson) {
    // should never happen
    throw new Error('dataSegmentJson was undefined');
  }
  const { dataBase64, ...restOfDataSegment } = dataSegmentJson;
  const data = new Buffer(dataBase64, 'base64');
  const segment: DataSegment = {
    data,
    ...restOfDataSegment
  };
  return segment;
}

/**
 * one-line function that applies `JSON.stringify` to an `AckSegment` to convert it to a string.
 * Unlike the `DataSegment`, the `AckSegment` is already JSON friendly. 
 */
export function serializeAckSegment(ackSegment: AckSegment) {
  return JSON.stringify(ackSegment);
}

/**
 * one-line function that applies `JSON.parse` and asserts the type to be an `AckSegment`
 */
export function parseAckSegment(ackSegmentString: string) {
  return JSON.parse(ackSegmentString) as AckSegment;
}

/**
 * one-line function that applies `JSON.stringify` to an `HandshakeSegment` to convert it to a
 * string. Unlike the `DataSegment`, the `HandshakeSegment` is already JSON friendly. 
 */
export function serializeHandshakeSegment(handshakeSegment: HandshakeSegment) {
  return JSON.stringify(handshakeSegment);
}

/**
 * one-line function that applies `JSON.parse` and asserts the type to be an `HandshakeSegment`
 */
export function parseHandshakeSegment(handshakeSegmentString: string) {
  return JSON.parse(handshakeSegmentString) as HandshakeSegment;
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
          sendDataSegment: async (segment: Segment) => new Promise<void>(async (resolve, reject) => {
            const segmentAsString = segmentToString(segment);
            // await wait(5000);
            await sendRawSegment(segmentAsString);
          }),
          ackSegmentStream: segmentStreamOfOneClient.map(s => stringToSegment(s.message.toString())),
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
        throw new Error(`Could not send segment because because it was ${segment}`);
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
    messageStream: createMessageStream({ dataSegmentStream, sendAckSegment, segmentSizeInBytes }),
    sendMessage: (message: string | Buffer) => sendMessageWithWindow(message, {
      segmentSizeInBytes,
      ackSegmentStream,
      sendDataSegment,
      segmentTimeout,
      windowSize,
    }),
    info: { address, family: 'IPv4', port }
  }

  return reliableUdpSocket;
}

export function createConnectionToClient(options: SenderOptions, info: Udp.AddressInfo) {

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

/**
 * consumes the `segmentStream` with sequence numbers and omits a stream of completed messages
 * sending acknowledgements
 * @param options 
 */
export function createMessageStream(options: ReceiverOptions) {
  const { segmentSizeInBytes, dataSegmentStream, sendAckSegment } = options;
  const messageStream: Observable<Buffer> = Observable.create((observer: Observer<Buffer>) => {
    (dataSegmentStream
      .filter(value => value.messageId !== undefined)
      .groupBy(value => value.messageId)
      .subscribe(segmentsByMessage => {
        let receivedLast = false;
        const receivedDataSegments = [] as (DataSegment | undefined)[];
        segmentsByMessage.subscribe(async segment => {
          receivedDataSegments[Math.floor(segment.seq / segmentSizeInBytes)] = segment;
          const nextExpectedSequenceNumber = findNextSequenceNumber(
            receivedDataSegments,
            segmentSizeInBytes
          );

          if (segment.last) {
            receivedLast = true;
          }
          const lastBuffer = receivedDataSegments[receivedDataSegments.length - 1];

          if (!lastBuffer) {
            throw new Error(`lastBuffer in 'createMessageStream' was undefined`);
          }

          if (
            // we got a segment that included the `"last": true` field
            receivedLast
            // and the next expected sequence number is equal to the last received segment's next
            // expected sequence number
            && nextExpectedSequenceNumber === lastBuffer.seq + segmentSizeInBytes
          ) {
            const combinedBuffer = Buffer.concat(receivedDataSegments.filter(x => x).map(buffer => {
              if (!buffer) {
                throw new Error(`Could not concatenate buffer because it was ${buffer}.`);
              }
              return buffer.data || new Buffer('');
            }));
            observer.next(combinedBuffer);
          }

          // ack
          await sendAckSegment({
            messageId: segment.messageId,
            ack: nextExpectedSequenceNumber,
          });
        })
      })
    );
  });
  return messageStream as Observable<Buffer>;
}

/**
 * Given an array of data segments, this function will find the next expected data segment
 * if a buffer is missing. runs in O(n) unfortunately.
 * @param dataSegments 
 * @param segmentSizeInBytes 
 */
export function findNextSequenceNumber(
  dataSegments: (DataSegment | undefined)[],
  segmentSizeInBytes: number
) {
  if (dataSegments.length === 0) {
    return segmentSizeInBytes;
  }
  let i = 0;
  for (let buffer of dataSegments) {
    if (!buffer) {
      return i * segmentSizeInBytes;
    }
    i += 1;
  }
  const lastBuffer = dataSegments[dataSegments.length - 1];
  if (!lastBuffer) {
    // should never happen
    throw new Error('last buffer was undefined');
  }
  return lastBuffer.seq + segmentSizeInBytes;
}

export function sendMessageWithWindow(message: string | Buffer, options: SenderOptions) {
  const {
    sendDataSegment,
    ackSegmentStream,
    windowSize,
    segmentSizeInBytes,
    segmentTimeout,
  } = options;
  const id = uuid();

  const segmentStreamForThisMessage = ackSegmentStream.filter(segment => segment.messageId === id);

  const ackCounts = [] as number[];

  const buffer = /*if*/ typeof message === 'string' ? Buffer.from(message) : message;
  const totalSegments = Math.ceil(buffer.byteLength / segmentSizeInBytes);

  const dataSegments = (range(totalSegments)
    .map(i => i * segmentSizeInBytes)
    .map(seq => ({
      seq,
      data: buffer.slice(seq, seq + segmentSizeInBytes),
    }))
    .map(({ seq, data }) => {
      const dataSegment: DataSegment = {
        data,
        seq,
        messageId: id,
      };
      return dataSegment;
    })
  );
  // push last empty segment
  dataSegments.push({
    messageId: id,
    seq: totalSegments * segmentSizeInBytes,
    last: true,
    data: new Buffer(''),
  });

  // console.log('SEGMENTS TO SEND', segments);

  // fast re-transmit
  segmentStreamForThisMessage.subscribe(async ackSegment => {
    ackCounts[ackSegment.ack] = (/*if*/ ackCounts[ackSegment.ack] === undefined
      ? 1
      : ackCounts[ackSegment.ack] + 1
    );

    if (ackCounts[ackSegment.ack] >= 3) {
      const segmentToRetransmit = dataSegments[Math.floor(ackSegment.ack / segmentSizeInBytes)];
      // throw new Error()
      if (segmentToRetransmit) {
        await sendDataSegment(segmentToRetransmit);
      }
    }
  });

  function sendDataSegmentAndWaitForAck(segment: DataSegment) {
    return new Promise<number>(async (resolve, reject) => {
      let gotAck = false;

      // resolve promise on ack
      (segmentStreamForThisMessage
        .filter(ackSegment => ackSegment.ack > segment.seq)
        .take(1)
        .toPromise()
        .then(ackSegment => {
          gotAck = true;
          resolve(ackSegment.ack);
        })
      );

      // reject on timeout
      setTimeout(() => {
        if (!gotAck) {
          reject(new Error('timeout occurred'));
        }
      }, segmentTimeout);

      await sendDataSegment(segment);
    });
  }

  let lastSegmentSent = 0;
  let greatestAck = 0;

  const finished = new DeferredPromise<void>();

  async function send(segment: DataSegment | undefined) {
    if (!segment) {
      // the segment will be undefined when the next segment index is greater than the number of
      // items. this occurs when all the previous items have been sent
      if (greatestAck > buffer.byteLength) {
        // when the greatest ack is larger than the bufferLength, we know we've sent every segment
        // got received acknowledgement.
        finished.resolve();
      }
      return;
    }
    try {
      if (segment.seq > lastSegmentSent) {
        lastSegmentSent = segment.seq;
      }
      const ack = await sendDataSegmentAndWaitForAck(segment);
      if (ack > greatestAck) {
        greatestAck = ack;
      }
      const nextSegmentIndex = Math.floor(lastSegmentSent / segmentSizeInBytes) + 1;
      const nextSegment = dataSegments[nextSegmentIndex];
      send(nextSegment);
    } catch {
      // re-send segment that timed out
      send(segment);
    }
  }

  // bootstrap the sending
  dataSegments.slice(0, windowSize).forEach(send);

  return finished;
}