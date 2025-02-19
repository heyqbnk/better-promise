import type {
  PromiseExecutorFn,
  PromiseOnRejectedFn,
  PromiseRejectFn,
  PromiseOnFulfilledFn,
  PromiseResolveFn,
  PromiseOptions,
  Maybe,
  WithFnFunction,
} from './types.js';
import { TimeoutError } from '../errors/TimeoutError.js';
import { CancelledError } from '../errors/CancelledError.js';
import { isPromiseResolveResult, withResolved } from './resolve.js';

function reassignProps<P extends AbortablePromise<any>>(
  childPromise: P,
  parentPromise: AbortablePromise<any>,
): P {
  childPromise.reject = parentPromise.reject;
  childPromise.abort = parentPromise.abort;
  return childPromise;
}

/**
 * Improved version of the JavaScript Promise.
 */
export class AbortablePromise<Result> extends Promise<Result> {
  /**
   * Creates a new AbortablePromise instance using an executor, resolving the promise when a result
   * was returned.
   * @param fn - function returning promise result.
   * @param options - additional options.
   */
  static fn<T>(fn: WithFnFunction<T>, options?: PromiseOptions): AbortablePromise<T> {
    return new AbortablePromise(async (res, rej, context) => {
      try {
        res(await fn(context));
      } catch (e) {
        rej(e);
      }
    }, options);
  }

  /**
   * @see Promise.resolve
   */
  static override resolve(): AbortablePromise<void>;
  /**
   * @see Promise.resolve
   */
  static override resolve<T>(value: T | PromiseLike<T>): AbortablePromise<Awaited<T>>;
  static override resolve<T>(value?: T | PromiseLike<T>): AbortablePromise<Awaited<T>> {
    return this.fn(() => value) as AbortablePromise<Awaited<T>>;
  }

  /**
   * @see Promise.reject
   */
  static override reject<T = never>(reason?: any): AbortablePromise<T> {
    return new AbortablePromise((_, rej) => {
      rej(reason);
    });
  }

  /**
   * Creates a new AbortablePromise instance using only options.
   * @param options - additional options.
   */
  constructor(options?: PromiseOptions);
  /**
   * Creates a new AbortablePromise instance using specified executor and additional options.
   * @param executor - promise executor.
   * @param options - additional options.
   */
  constructor(executor?: PromiseExecutorFn<Result>, options?: PromiseOptions);
  constructor(
    executorOrOptions?: PromiseExecutorFn<Result> | PromiseOptions,
    maybeOptions?: PromiseOptions,
  ) {
    let reject!: PromiseRejectFn;
    let abort!: (reason: unknown) => void;
    super((res, rej) => {
      let executor: PromiseExecutorFn<Result> | undefined;
      let options: PromiseOptions | undefined;

      if (typeof executorOrOptions === 'function') {
        executor = executorOrOptions;
        options = maybeOptions;
      } else {
        options = executorOrOptions;
      }

      //#region Cleanup section.
      const cleanupFns: VoidFunction[] = [];
      const withCleanup = <F extends (...args: any) => any>(
        fn: F,
      ): (...args: Parameters<F>) => ReturnType<F> => {
        return (...args) => {
          const result = fn(...args);
          cleanupFns.forEach(fn => fn());
          return result;
        };
      };
      //#endregion

      // We are going to use our controller signal in the executor because we can control it.
      // We can't say the same about the abort signal passed from above, we can't abort it by
      // ourselves.
      const controller = new AbortController();
      const { signal } = controller;
      abort = reason => {
        !signal.aborted && controller.abort(reason);
      };
      const abortReason = () => signal.reason;
      const onAborted = (listener: (reason: unknown) => void): VoidFunction => {
        const wrapped = () => {
          listener(abortReason());
        };
        signal.addEventListener('abort', wrapped, true);

        const cleanup = () => {
          signal.removeEventListener('abort', wrapped, true);
        };
        cleanupFns.push(cleanup);
        return cleanup;
      };

      // Enhance resolve and reject functions with cleanup and controller abortion.
      const resolve = withCleanup((result: Result) => {
        res(result);
        abort(withResolved(result));
      }) as PromiseResolveFn<Result>;
      reject = withCleanup(reason => {
        rej(reason);
        abort(reason);
      });

      //#region Process abortSignal option.
      options ||= {};
      const { abortSignal, rejectOnAbort = true } = options;
      if (abortSignal) {
        if (abortSignal.aborted) {
          const { reason } = abortSignal;
          if (rejectOnAbort) {
            return reject(reason);
          }
          abort(reason);
        } else {
          // When the passed abort signal aborts, we are also aborting our locally created signal.
          const listener = () => {
            abort(abortSignal.reason);
          };
          abortSignal.addEventListener('abort', listener);
          cleanupFns.push(() => {
            abortSignal.removeEventListener('abort', listener);
          });
        }
      }
      //#endregion

      //#region Process rejectOnAbort option.
      rejectOnAbort && onAborted(rej);
      //#endregion

      //#region Process timeout option.
      const { timeout } = options;
      if (timeout) {
        const timeoutId = setTimeout(() => {
          abort(new TimeoutError(timeout));
        }, timeout);

        cleanupFns.push(() => {
          clearTimeout(timeoutId);
        });
      }
      //#endregion

      const isAborted = () => signal.aborted;
      const isResolved = () => isPromiseResolveResult(abortReason());
      const resolved = () => {
        const reason = abortReason();
        return isPromiseResolveResult(reason) ? reason[1] as Result : undefined;
      };
      try {
        const result = executor && executor(resolve, reject, {
          abortReason,
          abortSignal: signal,
          isAborted,
          isResolved,
          onAborted,
          onResolved: listener => onAborted(() => {
            isResolved() && listener(resolved() as Result);
          }),
          resolved,
          throwIfAborted() {
            if (isAborted()) {
              throw abortReason();
            }
          },
        });

        // If a promise was returned, we want to handle its rejection because the JS Promise
        // will not do it for us. Not catching the promise rejection this way, an unhandled promise
        // rejection error will be thrown. We also need to perform reject properly cleaning up
        // all effects.
        if (result instanceof Promise) {
          result.catch(reject);
        }
      } catch (e) {
        // The wrapped executor may throw an error. Here we are following the same logic described
        // in result.catch() line above.
        reject(e);
      }
    });

    this.abort = abort;
    this.reject = reject;
  }

  /**
   * Aborts the promise execution using the specified reason.
   *
   * Not that this method doesn't reject the promise but notifies the executor using its context.
   * To perform the same operation but also reject the promise, use the `reject()` method.
   * @param reason - abort reason.
   * @see reject
   */
  abort: (reason?: unknown) => void;

  /**
   * Aborts the promise with the cancel error.
   */
  cancel(): void {
    this.abort(new CancelledError())
  }

  /**
   * @see Promise.catch
   */
  override catch<CatchResult = never>(
    onRejected?: Maybe<PromiseOnRejectedFn<CatchResult>>,
  ): AbortablePromise<Result | CatchResult> {
    return this.then(undefined, onRejected);
  }

  /**
   * @see Promise.finally
   */
  override finally(onFinally?: Maybe<() => void>): AbortablePromise<Result> {
    // Here we follow the same logic described in the "then" method.
    return reassignProps(super.finally(onFinally) as AbortablePromise<Result>, this);
  }

  /**
   * Rejects the initially created promise.
   *
   * This method not only aborts the signal passed to the executor, but also rejects the
   * promise itself calling all chained listeners.
   *
   * The reason passed to the method is being passed as-is to the executor's context.
   */
  reject: PromiseRejectFn;

  /**
   * @see Promise.then
   */
  override then<A = Result, B = never>(
    onFulfilled?: Maybe<PromiseOnFulfilledFn<Result, A>>,
    onRejected?: Maybe<PromiseOnRejectedFn<B>>,
  ): AbortablePromise<A | B> {
    // Use the original promise "then" method because in fact, it creates an AbortablePromise
    // instance.
    // Then, reassign the promise "reject" method, because not doing it and rejecting the promise
    // it will lead to an unhandled promise rejection.
    //
    // Here is an example:
    // const myPromise = new AbortablePromise(...)
    //   .catch(() => console.log('Catched'));
    //
    // If we don't reassign myPromise's "reject" method here, it will reject the promise, returned
    // from the "catch" method, which is unexpected. So, even using several catches in a row,
    // a developer will not be able to catch the error, thrown using the "reject" method.
    //
    // The expected behavior here is the "reject" method rejecting the initially created promise.
    // Then, this error will be handled via the "catch" method.
    return reassignProps(super.then(onFulfilled, onRejected) as AbortablePromise<A | B>, this);
  }
}
