import * as Udp from 'dgram';
import * as Dns from 'dns';
import { Observable, Observer, Subject } from 'rxjs';
import * as uuid from 'uuid/v4';
import { range } from 'lodash';

import {
  isAckSegment, isDataSegmentJsonable, isHandshakeSegment, parseAckSegment, parseDataSegment,
  parseHandshakeSegment, resolveName, serializeAckSegment, serializeDataSegment,
  serializeHandshakeSegment, timer, TaskQueue
} from './util';

import { createReceiver } from './receiver';
import { createSender } from './sender';

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

Udp.createSocket('udp4').bind;

export interface ReliableUdpServer {
  connectionStream: Observable<ReliableUdpSocket>,
  rawSocket: Udp.Socket,
  close(callback?: () => void): void,
  bind(callback?: (port: number) => void): void,
}

export interface ReliableUdpServerOptions {
  port: number,
  segmentSizeInBytes: number,
  windowSize: number,
  segmentTimeout: number,
  logger?: (logMessage: string) => void,
}

export interface ReliableUdpClientOptions {
  hostname: string,
  port: number,
  segmentSizeInBytes: number,
  windowSize: number,
  segmentTimeout: number,
  connectionTimeout: number,
  logger?: (logMessage: string) => void,
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

interface RawSegment {
  info: Udp.AddressInfo,
  raw: Buffer,
}

export function createReliableUdpServer(rudpOptions?: Partial<ReliableUdpServerOptions>) {
  rudpOptions = rudpOptions || {};
  const port = rudpOptions.port || DEFAULT_PORT;
  const server = Udp.createSocket('udp4');
  const segmentSizeInBytes = rudpOptions.segmentSizeInBytes || DEFAULT_SEGMENT_SIZE;
  const windowSize = rudpOptions.windowSize || DEFAULT_WINDOW_SIZE;
  const segmentTimeout = rudpOptions.segmentTimeout || DEFAULT_SEGMENT_TIMEOUT;
  const log = rudpOptions.logger || ((logMessage: string) => {/* do nothing */ });

  const rawSegmentStream = Observable.create((observer: Observer<RawSegment>) => {
    server.on('message', (raw, info) => observer.next({ raw, info }));
  }) as Observable<RawSegment>;

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

            // message stream
            const dataSegmentStream = rawSegmentStream.filter(({ raw }) => {
              try { return isDataSegmentJsonable(JSON.parse(raw.toString())) }
              catch { return false; }
            }).map(({ raw }) => parseDataSegment(raw.toString()));
            async function sendAckSegment(ackSegment: AckSegment) {
              sendRawSegmentToClient(serializeAckSegment(ackSegment));
            }
            const messageStream = createReceiver({
              dataSegmentStream,
              sendAckSegment,
              segmentSizeInBytes,
              logger: log,
            });

            // send message with window
            const ackSegmentStream = (rawSegmentStream
              .filter(({ raw }) => {
                try { return isAckSegment(JSON.parse(raw.toString())) }
                catch { return false; }
              })
              .map(({ raw }) => parseAckSegment(raw.toString()))
            );
            async function sendDataSegment(dataSegment: DataSegment) {
              await sendRawSegmentToClient(serializeDataSegment(dataSegment));
            }
            const messageQueue = new TaskQueue<void>();
            async function sendMessage(message: string | Buffer) {
              const promise = messageQueue.add(async () => {
                const send = createSender({
                  ackSegmentStream,
                  sendDataSegment,
                  windowSize,
                  segmentTimeout,
                  segmentSizeInBytes,
                  logger: log,
                });
                await send(message);
              });
              messageQueue.execute();
              return promise;
            }

            const clientSocket: ReliableUdpSocket = {
              info,
              messageStream,
              sendMessage,
            }
            connectionObserver.next(clientSocket);
          }
        });
      });
    });
  });

  const reliableUdpServer: ReliableUdpServer = {
    connectionStream,
    rawSocket: server,
    close: server.close.bind(server),
    bind: (cb: (port: number) => void) => server.bind(port, () => cb(port)),
  };

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
  const log = rudpOptions.logger || ((logMessage: string) => {/* do nothing */ })

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
      try { return isHandshakeSegment(JSON.parse(raw.toString())); }
      catch { return false; }
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

  // create message stream
  const dataSegmentStream = (rawSegmentStreamFromServer
    .filter(({ raw }) => {
      try { return isDataSegmentJsonable(JSON.parse(raw.toString())) }
      catch { return false; }
    })
    .map(({ raw }) => parseDataSegment(raw.toString()))
  );
  async function sendAckSegment(ackSegment: AckSegment) {
    await sendRawSegmentToServer(serializeAckSegment(ackSegment));
  }
  const messageStream = createReceiver({
    dataSegmentStream,
    sendAckSegment,
    segmentSizeInBytes,
    logger: log,
  });

  // send message function
  const ackSegmentStream = (rawSegmentStreamFromServer
    .filter(({ raw }) => {
      try { return isAckSegment(JSON.parse(raw.toString())) }
      catch { return false; }
    })
    .map(({ raw }) => parseAckSegment(raw.toString()))
  );
  async function sendDataSegment(dataSegment: DataSegment) {
    await sendRawSegmentToServer(serializeDataSegment(dataSegment));
  }
  const messageQueue = new TaskQueue<void>();
  async function sendMessage(message: string | Buffer) {
    const promise = messageQueue.add(async () => {
      const send = createSender({
        ackSegmentStream,
        sendDataSegment,
        windowSize,
        segmentTimeout,
        segmentSizeInBytes,
        logger: log,
      });
      await send(message);
    });
    messageQueue.execute();
    return promise;
  }

  const reliableUdpSocket: ReliableUdpSocket = {
    messageStream,
    sendMessage,
    info: client.address(),
  }

  return reliableUdpSocket;
}