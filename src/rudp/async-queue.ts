class DeferredPromise<T> implements Promise<T> {
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

export default class AsyncQueue<Value> {
  protected _queue: (QueueItem<Value> | undefined)[];
  protected _queueIsRunning: boolean;

  constructor() {
    this._queue = [];
    this._queueIsRunning = false;
  }

  async executeQueue() {
    const top = this._queue[0];
    if (!top) {
      this._queueIsRunning = false;
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
    this.executeQueue();
  }

  addTask(task: () => Promise<Value>) {
    const deferredPromise = new DeferredPromise<Value>();
    this._queue.push({
      task,
      deferredPromise
    });
    if (!this._queueIsRunning) {
      this._queueIsRunning = true;
      this.executeQueue();
    }
    return deferredPromise as Promise<Value>;
  }
}