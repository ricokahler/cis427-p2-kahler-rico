import * as Udp from 'dgram';
import * as Dns from 'dns';
import { Observable, Observer, Subject } from 'rxjs';
import * as uuid from 'uuid/v4';
import { range } from 'lodash';
import TaskQueue, { DeferredPromise } from './task-queue';

const DEFAULT_SEGMENT_SIZE = 4;
const DEFAULT_SEGMENT_TIMEOUT = 1000;
const DEFAULT_PORT = 8090;
const DEFAULT_HOST = 'localhost';
const DEFAULT_WINDOW_SIZE = 5;
const DEFAULT_CONNECTION_TIMEOUT = 3000;

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
  connectionTimeout: number,
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
  clientId: string,
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

export interface RawSegment {
  info: Udp.AddressInfo,
  raw: Buffer,
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

function isDataSegmentJsonable(maybe: any): maybe is DataSegmentJsonable {
  if (!maybe) { return false; }
  if (typeof maybe !== 'object') { return false; }
  const maybeAsDataSegmentJsonable = (maybe as DataSegmentJsonable);
  if (!maybeAsDataSegmentJsonable) { return false; }
  if (maybeAsDataSegmentJsonable.dataBase64 === undefined) { return false; }
  if (maybeAsDataSegmentJsonable.messageId === undefined) { return false; }
  if (maybeAsDataSegmentJsonable.seq === undefined) { return false; }
  return true;
}

/**
 * Converts `DataSegment`s to strings to send over the wire.
 * Converts Buffers to base64 and serializes the whole thing to JSON
 * @param dataSegment segment to be converted
 */
function serializeDataSegment(dataSegment: DataSegment) {
  return JSON.stringify(dataSegmentToJsonable(dataSegment));
}

/**
 * Parses data segments converted with `serializeDataSegment` back to segments
 * @param dataSegmentString the data segment string to parse
 */
function parseDataSegment(dataSegmentString: string) {
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
function serializeAckSegment(ackSegment: AckSegment) {
  return JSON.stringify(ackSegment);
}

/**
 * one-line function that applies `JSON.parse` and asserts the type to be an `AckSegment`
 */
function parseAckSegment(ackSegmentString: string) {
  return JSON.parse(ackSegmentString) as AckSegment;
}

function isAckSegment(maybe: any): maybe is AckSegment {
  const maybeAsAckSegment = maybe as AckSegment;
  if (!maybeAsAckSegment) { return false; }
  if (maybeAsAckSegment.ack === undefined) { return false; }
  if (maybeAsAckSegment.messageId === undefined) { return false; }
  return true;
}

/**
 * one-line function that applies `JSON.stringify` to an `HandshakeSegment` to convert it to a
 * string. Unlike the `DataSegment`, the `HandshakeSegment` is already JSON friendly. 
 */
function serializeHandshakeSegment(handshakeSegment: HandshakeSegment) {
  return JSON.stringify(handshakeSegment);
}

/**
 * one-line function that applies `JSON.parse` and asserts the type to be an `HandshakeSegment`
 */
function parseHandshakeSegment(handshakeSegmentString: string) {
  return JSON.parse(handshakeSegmentString) as HandshakeSegment;
}

function isHandshakeSegment(maybe: any): maybe is HandshakeSegment {
  const maybeAsHandshakeSegment = maybe as HandshakeSegment;
  if (!maybeAsHandshakeSegment) { return false }
  if (maybeAsHandshakeSegment.clientId === undefined) { return false; }
  if (maybeAsHandshakeSegment.handshake === undefined) { return false; }
  return true;
}

function timer(milliseconds: number) {
  return new Promise<'timer'>(resolve => setTimeout(() => resolve('timer'), milliseconds));
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

  server.on('listening', () => {
    console.log(`Reliable UDP Server running on port ${port}.`)
  });

  const rawSegmentStream = Observable.create((observer: Observer<RawSegment>) => {
    server.on('message', (raw, info) => observer.next({ raw, info }));
  }) as Observable<RawSegment>;

  // rawSegmentStream.subscribe(({ message }) => {
  //   console.log('RAW MESSAGE:', message.toString());
  // })

  const connectionStream = Observable.create((connectionObserver: Observer<ReliableUdpSocket>) => {
    // group each segment by their socket info
    const segmentsGroupedByClient = rawSegmentStream.groupBy(({ info }) => JSON.stringify({ ...info }));
    segmentsGroupedByClient.subscribe(rawSegmentStreamOfOneClient => {

      const info = JSON.parse(rawSegmentStreamOfOneClient.key) as Udp.AddressInfo;

      /**
       * sends a raw segment over UDP
       */
      function sendRawSegmentToClient(segment: string | Buffer) {
        return new Promise<number>((resolve, reject) => {
          server.send(segment, info.port, info.address, (error, bytes) => {
            if (error) {
              reject(error);
            } else {
              resolve(bytes);
            }
          });
        })
      }

      const handshakeSegmentStreamPerClient = (rawSegmentStreamOfOneClient
        .filter(({ raw }) => {
          try {
            return isHandshakeSegment(JSON.parse(raw.toString()))
          } catch {
            return false;
          }
        })
        .map(({ raw }) => parseHandshakeSegment(raw.toString()))
        .groupBy(({ clientId }) => clientId)
      );

      handshakeSegmentStreamPerClient.subscribe(handshakeSegmentStreamOfOneClient => {
        const clientId = handshakeSegmentStreamOfOneClient.key;
        handshakeSegmentStreamOfOneClient.subscribe(handshakeSegment => {
          if (handshakeSegment.handshake === 'syn') {
            sendRawSegmentToClient(serializeHandshakeSegment({
              clientId: handshakeSegment.clientId,
              handshake: 'syn-ack',
            }));
          } else if (handshakeSegment.handshake === 'ack') {
            connectionObserver.next(createConnectionToClient({
              sendDataSegment: async (dataSegment: DataSegment) => {
                await sendRawSegmentToClient(serializeDataSegment(dataSegment))
              },
              ackSegmentStream: (rawSegmentStreamOfOneClient
                .filter(({ raw }) => {
                  try {
                    return isAckSegment(JSON.parse(raw.toString()))
                  } catch {
                    return false;
                  }
                })
                .map(({ raw }) => parseAckSegment(raw.toString()))
              ),
              segmentSizeInBytes: maxSegmentSizeInBytes,
              windowSize,
              segmentTimeout,
            }, info));
          }
        });
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
  const segmentTimeout = rudpOptions.segmentTimeout || DEFAULT_SEGMENT_TIMEOUT;
  const connectionTimeout = rudpOptions.connectionTimeout || DEFAULT_CONNECTION_TIMEOUT;

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

  const clientId = uuid();
  const rawSegmentStream = Observable.create((observer: Observer<RawSegment>) => {
    client.addListener('message', (raw, info) => {
      observer.next({ raw, info });
    });
  }) as Observable<RawSegment>;
  const rawSegmentStreamFromServer = rawSegmentStream.filter(({ info }) => {
    return info.address === address && info.port === port
  });
  const handshakeStreamForThisClient = (rawSegmentStreamFromServer
    .filter(({ raw }) => {
      try {
        return isHandshakeSegment(JSON.parse(raw.toString()));
      } catch {
        return false;
      }
    })
    .map(({ raw }) => parseHandshakeSegment(raw.toString()))
    .filter(handshakeSegment => handshakeSegment.clientId === clientId)
  );

  await sendRawSegmentToServer(serializeHandshakeSegment({ clientId, handshake: 'syn' }));

  const synAck = (handshakeStreamForThisClient
    .filter(({ handshake }) => handshake === 'syn-ack')
    .take(1)
    .toPromise()
  );

  const synAckOrTimer = await Promise.race([
    synAck,
    timer(connectionTimeout)
  ]);

  if (synAckOrTimer === 'timer') {
    throw new Error('connection to server timed out');
  }

  await sendRawSegmentToServer(serializeHandshakeSegment({ clientId, handshake: 'ack' }));

  const dataSegmentStream = (rawSegmentStreamFromServer
    .filter(({ raw }) => {
      try { return isDataSegmentJsonable(JSON.parse(raw.toString())) }
      catch { return false; }
    })
    .map(({ raw }) => parseDataSegment(raw.toString()))
  );

  const ackSegmentStream = (rawSegmentStreamFromServer
    .filter(({ raw }) => {
      try { return isAckSegment(JSON.parse(raw.toString())) }
      catch { return false; }
    })
    .map(({ raw }) => parseAckSegment(raw.toString()))
  );

  async function sendAckSegment(ackSegment: AckSegment) {
    await sendRawSegmentToServer(serializeAckSegment(ackSegment));
  }

  async function sendDataSegment(dataSegment: DataSegment) {
    await sendRawSegmentToServer(serializeDataSegment(dataSegment));
  }

  const reliableUdpSocket: ReliableUdpSocket = {
    messageStream: createMessageStream({
      dataSegmentStream,
      sendAckSegment,
      segmentSizeInBytes
    }),
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