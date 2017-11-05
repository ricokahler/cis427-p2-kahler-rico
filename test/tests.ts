import 'mocha';
import { expect } from 'chai';

import * as uuid from 'uuid/v4';

import { Segment, findNextSequenceNumber, segmentToString, stringToSegment } from '../src/rudp';

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

