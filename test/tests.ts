import 'mocha';
import { expect } from 'chai';

import * as uuid from 'uuid/v4';
import { range, shuffle } from 'lodash';
import { Observable, Observer, ReplaySubject } from 'rxjs';
import { oneLine } from 'common-tags';

import {
  DataSegment, AckSegment,
  DEFAULT_SEGMENT_SIZE as segmentSizeInBytes,
  DEFAULT_SEGMENT_TIMEOUT as segmentTimeout,
  DEFAULT_WINDOW_SIZE as windowSize,
} from '../src/rudp';

import { createSender } from '../src/rudp/sender';
import { createReceiver } from '../src/rudp/receiver';

import { AsyncBlockingQueue, DeferredPromise } from '../src/rudp/util';

const exampleMessage = 'The quick brown fox jumps over the lazy dog.';

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

      const ackQueue = new AsyncBlockingQueue<AckSegment>();

      async function sendAckSegment(ackSegment: AckSegment) {
        ackQueue.enqueue(ackSegment);
      }

      const dataSegmentStream = Observable.create(async (observer: Observer<DataSegment>) => {
        for (let dataSegment of dataSegmentsToSend) {
          observer.next(dataSegment);

          // WAITS FOR THE ACK
          const ackSegment = await ackQueue.dequeue();
          // CHECKS TO SEE IF THE ACK IS THE NEXT EXPECTED SEGMENT
          expect(ackSegment.ack).to.be.equal(dataSegment.seq + segmentSizeInBytes);
        }
      }) as Observable<DataSegment>;

      const messageStream = createReceiver({
        dataSegmentStream,
        segmentSizeInBytes,
        sendAckSegment,
        // =========================================================================================
        // logger: console.log.bind(console), // uncomment to enable logging
        // =========================================================================================
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
        // =========================================================================================
        // logger: console.log.bind(console), // uncomment to enable logging
        // =========================================================================================
      });

      const message = (await messageStream.take(1).toPromise()).toString();
      expect(message).to.be.equal(exampleMessage);
    }
  );
});

describe('Fast retransmit', function () {
  it(
    oneLine`
      The server needs to maintain a counter for duplicate acknowledgments. Once the counter
      reaches 3, only the first unacknowledged segment will be retransmitted.
    `,
    async function () {
      const seqQueue = new AsyncBlockingQueue<DataSegment>();

      const totalSegments = Math.ceil(
        new Buffer(exampleMessage).byteLength / segmentSizeInBytes
      ) + 2;

      const ackSegmentStream = new ReplaySubject<AckSegment>();
      const sentSegmentCount = [] as (number | undefined)[];

      async function sendDataSegment(dataSegment: DataSegment) {
        const count = sentSegmentCount[dataSegment.seq / segmentSizeInBytes];
        sentSegmentCount[dataSegment.seq / segmentSizeInBytes] = (/*if*/ count === undefined
          ? 1
          : count + 1
        );
        seqQueue.enqueue(dataSegment);
      }

      const send = createSender({
        ackSegmentStream,
        sendDataSegment,
        segmentTimeout,
        segmentSizeInBytes,
        windowSize,
        // =========================================================================================
        // logger: console.log.bind(console), // uncomment to enable logging
        // =========================================================================================
      });

      const finishedSending = new DeferredPromise<void>();
      send(exampleMessage).then(() => finishedSending.resolve());

      const offset = 3;

      let messageId = '';
      // send the first three ACKs in order
      for (let i of range(offset)) {
        const dataSegment = await seqQueue.dequeue();
        messageId = dataSegment.messageId;
        ackSegmentStream.next({
          ack: dataSegment.seq + segmentSizeInBytes,
          messageId: dataSegment.messageId
        });
      }

      // SEND THE TWO MORE ACKS (TOTALLING TO THREE)
      for (let i of range(2)) {
        ackSegmentStream.next({
          ack: offset * segmentSizeInBytes,
          messageId,
        });
      }

      // send the rest of the ACKs in order
      for (let i of range(offset, totalSegments)) {
        const dataSegment = await seqQueue.dequeue();
        ackSegmentStream.next({
          ack: dataSegment.seq + segmentSizeInBytes,
          messageId: dataSegment.messageId
        });
      }

      await finishedSending;
      expect(sentSegmentCount[offset]).to.be.greaterThan(1);
    }
  );
});

