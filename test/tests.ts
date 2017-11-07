import 'mocha';
import { expect } from 'chai';

import * as uuid from 'uuid/v4';
import { range, shuffle } from 'lodash';
import { Observable, Observer, ReplaySubject } from 'rxjs';
import { oneLine } from 'common-tags';

import { DataSegment, AckSegment } from '../src/rudp';

import { createSender } from '../src/rudp/sender';
import { createReceiver } from '../src/rudp/receiver';

import { AsyncBlockingQueue } from '../src/rudp/util';

const exampleMessage = 'The quick brown fox jumps over the lazy dog.';
const segmentSizeInBytes = 4;

describe('Cumulative acknowledgement', function () {
  it(
    oneLine`
      Upon receiving a segment from the server, the client will respond with a cumulative
      acknowledgment, which follows the standard protocol defined for TCP 
    `,
    async function () {
      const messageId = uuid();

      const buffer = new Buffer(exampleMessage);
      const dataSegmentsToSend = (range(buffer.byteLength / segmentSizeInBytes)
        .map(i => i * segmentSizeInBytes)
        .map(seq => {
          const dataSegment: DataSegment = {
            messageId,
            seq,
            data: buffer.slice(seq, seq + segmentSizeInBytes)
          };
          return dataSegment;
        })
      );
      dataSegmentsToSend.push({
        seq: dataSegmentsToSend.length * segmentSizeInBytes,
        messageId,
        last: true,
        data: new Buffer(''),
      })

      const ackStream = new AsyncBlockingQueue<AckSegment>();

      async function sendAckSegment(ackSegment: AckSegment) {
        ackStream.enqueue(ackSegment);
      }

      const dataSegmentStream = Observable.create(async (observer: Observer<DataSegment>) => {
        for (let dataSegment of dataSegmentsToSend) {
          observer.next(dataSegment);

          // WAITS FOR THE ACK
          const ackSegment = await ackStream.dequeue();
          // CHECKS TO SEE IF THE ACK IS THE NEXT EXPECTED SEGMENT
          expect(ackSegment.ack).to.be.equal(dataSegment.seq + segmentSizeInBytes);
        }
      }) as Observable<DataSegment>;

      const messageStream = createReceiver({
        dataSegmentStream,
        segmentSizeInBytes,
        sendAckSegment,
        // logger: console.log.bind(console), // uncomment to enable logging
      });

      const message = (await messageStream.take(1).toPromise()).toString();

      expect(message).to.be.equal(exampleMessage);
    }
  );
});

describe('Out-of-order and duplicate and in-order segments', function () {
  it(
    oneLine`
      Upon receiving a segment, if the client detects a gap (out of order), buffer it; if it is
      duplication or corruption, just discard it; otherwise (in order) print out the content as
      shown before.
    `,
    async function () {

      const messageId = uuid();

      const buffer = new Buffer(exampleMessage);
      let dataSegmentsToSend = (range(buffer.byteLength / segmentSizeInBytes)
        .map(i => i * segmentSizeInBytes)
        .map(seq => {
          const dataSegment: DataSegment = {
            messageId,
            seq,
            data: buffer.slice(seq, seq + segmentSizeInBytes)
          };
          return dataSegment;
        })
      );
      dataSegmentsToSend.push({
        seq: dataSegmentsToSend.length * segmentSizeInBytes,
        messageId,
        last: true,
        data: new Buffer(''),
      });

      dataSegmentsToSend = shuffle(dataSegmentsToSend); // out of order

      async function sendAckSegment(ackSegment: AckSegment) {
        // nothing to do
      }

      const dataSegmentStream = Observable.of(...dataSegmentsToSend);

      const messageStream = createReceiver({
        dataSegmentStream,
        segmentSizeInBytes,
        sendAckSegment,
        // logger: console.log.bind(console), // uncomment to enable logging
      });

      const message = (await messageStream.take(1).toPromise()).toString();
      expect(message).to.be.equal(exampleMessage);
    }
  );
});

describe('Fast retransmit', function () {
  it(
    ``
  );
});

