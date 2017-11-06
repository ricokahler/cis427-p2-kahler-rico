import { Observable } from 'rxjs';
import { AckSegment, DataSegment } from './';

export interface ReceiverOptions {
  sendAckSegment: (segment: AckSegment) => Promise<void>,
  dataSegmentStream: Observable<DataSegment>,
  segmentSizeInBytes: number,
}

/**
 * Given an array of data segments, this function will find the next expected data segment
 * if a buffer is missing. runs in O(n) unfortunately.
 * @param dataSegments 
 * @param segmentSizeInBytes 
 */
export function findNextSequenceNumber(
  dataSegments: (DataSegment | undefined)[],
  segmentSizeInBytes: number,
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
        segmentsByMessage.subscribe(segment => {
          console.log('got segment')
        })
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
            ack: nextExpectedSequenceNumber,
            messageId: segment.messageId,
          });
        })
      })
    );
  });
  return messageStream as Observable<Buffer>;
}