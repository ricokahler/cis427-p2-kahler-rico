import 'mocha';
import { expect } from 'chai';

import * as uuid from 'uuid/v4';
import { range } from 'lodash';
import { Observable, Observer, ReplaySubject } from 'rxjs';

import {
  Segment, findNextSequenceNumber, segmentToString, stringToSegment, createMessageStream,
  sendMessageWithWindow
} from '../src/rudp';

describe('findNextSequenceNumber', function () {
  it('finds the next sequence number from the middle', function () {
    const buffers = [
      { seqAck: 0 },
      undefined, // { seqAck: 100 }, // this one is missing
      { seqAck: 200 },
      undefined, // { seqAck: 300 }, // this one is also missing
      { seqAck: 400 },
      { seqAck: 500 },
    ];

    expect(findNextSequenceNumber(buffers, 100)).to.be.equal(100);
  });

  it('finds the next sequence number from the start', function () {
    const buffers = [
      undefined,
      { seqAck: 100 },
      { seqAck: 200 },
      undefined, // { seqAck: 300 }, // this one is missing
      { seqAck: 400 },
      { seqAck: 500 },
    ];

    expect(findNextSequenceNumber(buffers, 100)).to.be.equal(0);
  });

  it('finds the next sequence number at the end', function () {
    const buffers = [
      { seqAck: 0 },
      { seqAck: 100 },
      { seqAck: 200 },
      { seqAck: 300 }, // this one is missing
      { seqAck: 400 },
      { seqAck: 500 },
    ];

    expect(findNextSequenceNumber(buffers, 100)).to.be.equal(600);
  });
})

describe('stringToSegment, segmentToString', function () {
  it('converts to and from strings', function () {
    const segment: Segment = {
      messageId: uuid(),
      seqAck: Math.floor(Math.random() * 5) * 100,
      data: new Buffer(uuid()),
      last: Math.random() > 0.5,
      handshake: 'syn',
    };

    expect(stringToSegment(segmentToString(segment))).to.be.deep.equal(segment);
  });

  it('leaves out keys when undefined', function () {
    const segment: Segment = {
      messageId: uuid(),
      seqAck: Math.floor(Math.random() * 5) * 100,
      // data: new Buffer(uuid()), // leave this out
      // last: Math.random() > 0.5
    };

    expect(stringToSegment(segmentToString(segment))).to.be.deep.equal(segment);
  })
});

describe('createMessageStream', function () {
  it('receives segments, sends acknowledgements, and pushes complete buffers', async function () {
    const messageId = uuid();

    const message = 'The quick brown fox jumps over the lazy dog.';
    const segmentSize = 4;
    const bufferFromMessage = new Buffer(message);
    const buffers = (range(Math.ceil(bufferFromMessage.byteLength / segmentSize))
      .map(i => segmentSize * i)
      .map(sequenceNumber => ({
        sequenceNumber,
        buffer: bufferFromMessage.slice(sequenceNumber, sequenceNumber + segmentSize)
      }))
    );

    const segmentStream = Observable.create((observer: Observer<Segment>) => {
      for (let { sequenceNumber, buffer } of buffers) {
        observer.next({ messageId, seqAck: sequenceNumber, data: buffer });
      }
      observer.next({ messageId, seqAck: buffers.length * segmentSize, last: true });
      // observer.complete();
    }) as Observable<Segment>;

    const acks = [] as number[];

    const sendSegment = (segment: Segment) => {
      acks.push(segment.seqAck);
      return Promise.resolve();
    }

    const messageStream = await createMessageStream(segmentStream, sendSegment, segmentSize);
    const finalBuffer = await messageStream.take(1).toPromise();
    expect(finalBuffer.toString()).to.be.equal(message);
    expect(acks).to.be.deep.equal(range(buffers.length + 1).map(i => i + 1).map(i => i * segmentSize))
  });

  it('push message when a segment is out of order', async function () {
    const messageId = uuid();

    const message = 'The quick brown fox jumps over the lazy dog.';
    const segmentSize = 4;
    const bufferFromMessage = new Buffer(message);
    const totalBuffers = Math.ceil(bufferFromMessage.byteLength / segmentSize);
    const indexToSkip = Math.floor(totalBuffers / 2);
    const buffers = (range(totalBuffers)
      .filter(i => i !== indexToSkip)
      .map(i => segmentSize * i)
      .map(sequenceNumber => ({
        sequenceNumber,
        buffer: bufferFromMessage.slice(sequenceNumber, sequenceNumber + segmentSize)
      }))
    );

    const segmentStream = new ReplaySubject<Segment>();
    // segmentStream.subscribe(seq => console.log('sending seq: ', seq.seqAck));
    for (let { sequenceNumber, buffer } of buffers) {
      segmentStream.next({ messageId, seqAck: sequenceNumber, data: buffer });
    }
    segmentStream.next({ messageId, seqAck: (buffers.length + 1) * segmentSize, last: true });

    const acks = [] as number[];
    const cumulativeAcks = [] as number[];

    const sendSegment = (segment: Segment) => {
      // console.log('ack', segment.seqAck);
      acks.push(segment.seqAck);
      cumulativeAcks[segment.seqAck] = (/*if*/ cumulativeAcks[segment.seqAck] === undefined
        ? 1
        : cumulativeAcks[segment.seqAck] + 1
      );
      if (cumulativeAcks[segment.seqAck] >= 3) {
        // send the missing one
        segmentStream.next({
          messageId,
          seqAck: indexToSkip * segmentSize,
          data: bufferFromMessage.slice(indexToSkip * segmentSize, (indexToSkip + 1) * segmentSize),
        });
      }
      return Promise.resolve();
    }


    const messageStream = await createMessageStream(segmentStream, sendSegment, segmentSize);
    const finalBuffer = await messageStream.take(1).toPromise();
    expect(finalBuffer.toString()).to.be.equal(message);
    // expect(acks).to.be.deep.equal(range(buffers.length + 1).map(i => i + 1).map(i => i * segmentSize))
  });
});

describe('sendMessageWithWindow', function () {
  it('sends a message using a sliding window', async function () {
    const message = 'The quick brown fox jumps over the lazy dog.';
    const segmentSize = 4;
    const windowSize = 3;
    const segmentTimeout = 2000;
    let messageId: string;

    const segmentsSent = [] as Segment[];
    const segmentStream = new ReplaySubject<Segment>();

    const sendSegment = async (segment: Segment) => {
      messageId = segment.messageId;
      segmentStream.next({ messageId, seqAck: segment.seqAck + segmentSize });
      return Promise.resolve();
    }

    await sendMessageWithWindow(message, {
      sendSegment,
      segmentStream,
      segmentSizeInBytes: segmentSize,
      windowSize,
      segmentTimeout,
    });
  });
});
