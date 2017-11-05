import 'mocha';
import { expect } from 'chai';

import { Segment, findNextSequenceNumber } from '../src/rudp';

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

