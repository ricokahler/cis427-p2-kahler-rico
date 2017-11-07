import * as Udp from 'dgram';
import * as Dns from 'dns';
import { DataSegment, AckSegment, HandshakeSegment } from './';

/**
 * converts a data segment to a JSON friendly format by encoding the buffer to base64
 * @param dataSegment 
 */
export function dataSegmentToJsonable(dataSegment: DataSegment) {
  const { data, ...restOfSegment } = dataSegment;
  const dataBase64 = data.toString('base64');
  return { ...restOfSegment, dataBase64 };
}
// for dynamic typings
const _DataSegmentJsonable = false ? dataSegmentToJsonable({} as DataSegment) : undefined;
type DataSegmentJsonable = typeof _DataSegmentJsonable;

export function isDataSegmentJsonable(maybe: any): maybe is DataSegmentJsonable {
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

export function isAckSegment(maybe: any): maybe is AckSegment {
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
export function serializeHandshakeSegment(handshakeSegment: HandshakeSegment) {
  return JSON.stringify(handshakeSegment);
}

/**
 * one-line function that applies `JSON.parse` and asserts the type to be an `HandshakeSegment`
 */
export function parseHandshakeSegment(handshakeSegmentString: string) {
  return JSON.parse(handshakeSegmentString) as HandshakeSegment;
}

export function isHandshakeSegment(maybe: any): maybe is HandshakeSegment {
  const maybeAsHandshakeSegment = maybe as HandshakeSegment;
  if (!maybeAsHandshakeSegment) { return false }
  if (maybeAsHandshakeSegment.clientId === undefined) { return false; }
  if (maybeAsHandshakeSegment.handshake === undefined) { return false; }
  return true;
}

export function timer(milliseconds: number) {
  return new Promise<'timer'>(resolve => setTimeout(() => resolve('timer'), milliseconds));
}

export function resolveName(hostname: string) {
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

export class DeferredPromise<T> implements Promise<T> {
  private _promise: Promise<T>
  resolve: (t?: T) => void;
  reject: (error?: any) => void;
  then: <TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | undefined | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | undefined | null
  ) => Promise<TResult1 | TResult2>;
  catch: <TResult = never>(
    onrejected?: ((reason: any) => TResult | PromiseLike<TResult>) | undefined | null
  ) => Promise<T | TResult>;
  state: 'pending' | 'fulfilled' | 'rejected';

  constructor() {
    this.state = 'pending';
    this._promise = new Promise((resolve, reject) => {
      this.resolve = (value?: T | PromiseLike<T> | undefined) => {
        this.state = 'fulfilled';
        resolve(value);
      };
      this.reject = (reason: any) => {
        this.state = 'rejected';
        reject(reason);
      };
    });
    this.then = this._promise.then.bind(this._promise);
    this.catch = this._promise.catch.bind(this._promise);
  }

  [Symbol.toStringTag] = 'Promise' as 'Promise';
}

interface QueueItem<T> {
  task: () => Promise<T>,
  deferredPromise: DeferredPromise<T>
}

export class TaskQueue<T> {
  private _queue: (QueueItem<T> | undefined)[];
  private _queueIsRunning: boolean;
  private _queueFinished: DeferredPromise<void>;

  constructor() {
    this._queue = [];
    this._queueIsRunning = false;
    this._queueFinished = new DeferredPromise<void>();
  }

  private async _execute() {
    const top = this._queue[0];
    if (!top) {
      this._queueIsRunning = false;
      this._queueFinished.resolve();
      return;
    }
    const { task, deferredPromise } = top;
    this._queue = this._queue.slice(1);
    try {
      const value = await task();
      deferredPromise.resolve(value);
    } catch (e) {
      deferredPromise.reject(e);
    }
    this._execute();
  }

  async execute() {
    if (!this._queueIsRunning) {
      this._queueFinished = new DeferredPromise<void>();
      this._queueIsRunning = true;
      this._execute();
    }
    return this._queueFinished;
  }

  add(task: () => Promise<T>) {
    const deferredPromise = new DeferredPromise<T>();
    this._queue.push({
      task,
      deferredPromise
    });

    return deferredPromise as Promise<T>;
  }
}

export class AsyncBlockingQueue<T> {
  private _promises: Promise<T>[];
  private _resolvers: ((t: T) => void)[];

  constructor() {
    this._resolvers = [];
    this._promises = [];
  }

  private _add() {
    this._promises.push(new Promise(resolve => {
      this._resolvers.push(resolve);
    }));
  }

  enqueue(t: T) {
    if (!this._resolvers.length) this._add();
    const resolve = this._resolvers.shift();
    if (!resolve) {
      // should never happen
      throw new Error('resolve function was null or undefined when attempting to enqueue.')
    };
    resolve(t);
  }

  dequeue() {
    if (!this._promises.length) this._add();
    const promise = this._promises.shift();
    if (!promise) {
      // should never happen
      throw new Error('promise was null or undefined when attempting to dequeue.');
    }
    return promise;
  }

  isEmpty() {
    return !this._promises.length;
  }

  isBlocked() {
    return !!this._resolvers.length;
  }

  get length() {
    return this._promises.length - this._resolvers.length;
  }
}

export function clearStack () {
  return new Promise(resolve => setTimeout(() => resolve(), 0));
}