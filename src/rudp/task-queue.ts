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

  constructor() {
    this._promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
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

export default class TaskQueue<T> {
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
    const {task, deferredPromise} = top;
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

// function waitAndThenSay(message: string) {
//   return new Promise<string>((resolve, reject) => {
//     setTimeout(() => resolve(message), 2000);
//   });
// }

// async function main() {
//   const asyncQueue = new TaskQueue<string>();
//   console.log('queue start');
//   asyncQueue.add(() => waitAndThenSay('hello0')).then(console.log.bind(console));
//   asyncQueue.execute();
//   asyncQueue.add(() => waitAndThenSay('hello1')).then(console.log.bind(console));
//   asyncQueue.execute();
//   asyncQueue.add(() => waitAndThenSay('hello2')).then(console.log.bind(console));
//   asyncQueue.execute();
//   asyncQueue.add(() => waitAndThenSay('hello3')).then(console.log.bind(console));
//   await asyncQueue.execute();
//   console.log('queue finished');
// }

// main();