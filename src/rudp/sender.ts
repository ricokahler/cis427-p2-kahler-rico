import * as uuid from 'uuid/v4';
import { Observable } from 'rxjs';
import { range } from 'lodash';
import { DeferredPromise } from './util';
import { DataSegment, AckSegment } from './';

const LOGGER_PREFIX = '[SENDER]: '

export interface SenderOptions {
  sendDataSegment: (segment: DataSegment) => Promise<void>,
  ackSegmentStream: Observable<AckSegment>,
  segmentSizeInBytes: number,
  windowSize: number,
  segmentTimeout: number,
  logger?: (logMessage: string) => void,
}

export function createSender(message: string | Buffer, options: SenderOptions) {
  const {
    sendDataSegment,
    ackSegmentStream,
    windowSize,
    segmentSizeInBytes,
    segmentTimeout,
  } = options;
  const log = options.logger || ((logMessage: string) => { /* do nothing */ });

  log(`${LOGGER_PREFIX}sending message: "${message}".`)

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
    seq: totalSegments * segmentSizeInBytes,
    messageId: id,
    last: true,
    data: new Buffer(''),
  });

  log(`${LOGGER_PREFIX}SEGMENTS TO SEND:\n${dataSegments.map(segment => `    ${JSON.stringify(segment)}`).join('\n')}`);

  // fast re-transmit
  segmentStreamForThisMessage.subscribe(async ackSegment => {
    ackCounts[ackSegment.ack] = (/*if*/ ackCounts[ackSegment.ack] === undefined
      ? 1
      : ackCounts[ackSegment.ack] + 1
    );

    if (ackCounts[ackSegment.ack] >= 3) {
      log(`${LOGGER_PREFIX}FAST RE-TRANSMIT: got more than three ACKs for segment ${ackSegment.ack}`);
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
        log(`${LOGGER_PREFIX}finished sending message: "${message}"!`);
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